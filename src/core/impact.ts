import type { Statics } from './equilibria.ts'
import type { Hull } from './hull.ts'
import { rollFrom, type Roller } from './roll.ts'
import { tipPath, type TipPath } from './tipPath.ts'
import type { MassProps } from './types.ts'
import { GRAVITY } from './units.ts'
import { add, cross, dot, get, inverse3, length, mulMat, normalize, scale, sub, type Mat3, type Vec3 } from './vec.ts'

// Everything about tipping over one support edge of a resting pose that doesn't
// depend on where or how the bot is hit (spec §3.6). Body frame, COM at origin.
export interface EdgeModel {
  a: number                // hull vertex ids of the edge ends (q1, q2)
  b: number
  q1: Vec3
  k: Vec3                  // unit vector q1 → q2
  L: number
  axis: Vec3               // positive rotation about this tips the bot over the edge
  up: Vec3                 // ground normal
  across: Vec3             // up × k: horizontal, perpendicular to the edge
  out: Vec3                // the face's outward in-plane direction across the edge
  Ia: number               // moment of inertia about the edge
  omega: number            // spin that just carries the bot over the top (Infinity: can't)
  mvG: Vec3                // m·v_G at that spin
  Hq1: Vec3                // angular momentum about q1 at that spin
  path: TipPath
  slopeMax: number         // largest gravity lever arm along the path (for slow pushes)
  landing: number          // stable face it rolls to after the top (-1: unknown)
}

export type Outcome = 'ok' | 'launch' | 'lift' | 'slide' | 'none' | 'returns'

export interface EdgeResult {
  edge: number             // index into the pose's edge models
  value: number            // J_min (N·s) or F_min (N)
  lever: number
  outcome: Outcome
}

export function edgeModels(hull: Hull, st: Statics, roller: Roller, face: number, mass: MassProps, inertia: Mat3): EdgeModel[] {
  const f = hull.faces[face]
  const n = f.normal
  const up = scale(n, -1)
  const m = mass.mass
  return f.verts.map((ia, j) => {
    const ib = f.verts[(j + 1) % f.verts.length]
    const q1 = get(st.V, ia)
    const d = sub(get(st.V, ib), q1)
    const L = length(d)
    const k = scale(d, 1 / L)
    const out = normalize(cross(d, n))
    // Rotating about `axis` must lift the COM: (axis × (G − q1)) · up > 0.
    const axis = dot(cross(k, scale(q1, -1)), up) > 0 ? k : scale(k, -1)
    const across = cross(up, k)
    const r = add(scale(q1, -1), scale(k, dot(q1, k)))   // COM offset from the edge line
    const IGa = dot(axis, mulMat(inertia, axis))
    const Ia = IGa + m * dot(r, r)
    const path = tipPath(st.V, hull.count, n, out, ia)
    const omega = thresholdSpin(st.V, path, k, IGa, m, st.faceHeight[face], r)
    const rG = scale(q1, -1)
    const mvG = scale(cross(axis, rG), m * omega)
    const Hq1 = scale(add(mulMat(inertia, axis), scale(cross(rG, cross(axis, rG)), m)), omega)
    let slopeMax = dot(q1, out)
    for (const kink of path.kinks) {
      // Gravity's lever arm right after landing on the new pivot.
      const p = get(st.V, kink.vertex)
      slopeMax = Math.max(slopeMax, dot(p, out) * Math.cos(kink.theta) - dot(p, n) * Math.sin(kink.theta))
    }
    const landing = rollFrom(roller, normalize(add(scale(n, Math.cos(path.land)), scale(out, Math.sin(path.land)))))
    return { a: ia, b: ib, q1, k, L, axis, up, across, out, Ia, omega, mvG, Hq1, path, slopeMax, landing }
  })
}

// Works back from zero kinetic energy at the top of the path. Each kink is a new
// contact landing with speed: a plastic impact that conserves angular momentum
// about the new pivot. `tumble` in tipPath.ts runs the same model forward.
export function thresholdSpin(V: Float64Array, path: TipPath, k: Vec3, IGa: number, m: number, h0: number, r0: Vec3): number {
  const offset = (vertex: number) => {
    const p = get(V, vertex)
    return add(scale(p, -1), scale(k, dot(p, k)))
  }
  const r = [r0, ...path.kinks.map((kk) => offset(kk.vertex))]
  const I = r.map((ri) => IGa + m * dot(ri, ri))
  let hNext = h0 + path.lift
  let ke = 0
  for (let j = path.kinks.length; j >= 1; j--) {
    ke += m * GRAVITY * (hNext - path.kinks[j - 1].h)
    const after = Math.sqrt((2 * ke) / I[j])
    const ratio = (IGa + m * dot(r[j - 1], r[j])) / I[j]
    if (ratio <= 0) return Infinity
    const before = after / ratio
    ke = 0.5 * I[j - 1] * before * before
    hNext = path.kinks[j - 1].h
  }
  ke += m * GRAVITY * (hNext - h0)
  return Math.sqrt((2 * Math.max(ke, 0)) / I[0])
}

// Impulsive hit at p (relative to the COM) along unit d, tipping over edge e.
export function hitOnEdge(e: EdgeModel, p: Vec3, d: Vec3, mu: number): Omit<EdgeResult, 'edge'> {
  const r = sub(p, e.q1)
  const rd = cross(r, d)
  const lever = dot(e.axis, rd)
  if (lever <= 1e-12 || !Number.isFinite(e.omega)) return { value: Infinity, lever, outcome: 'none' }
  const J = (e.Ia * e.omega) / lever
  const R = sub(e.mvG, scale(d, J))
  // Angular impulse about q1: L·k × R2 = H_q1 − r × J·d
  const M = scale(sub(e.Hq1, scale(rd, J)), 1 / e.L)
  return { value: J, lever, outcome: split(e, R, M, mu) }
}

// Slow push at p along unit d: the force that starts the tip and keeps it going.
export function pushOnEdge(e: EdgeModel, p: Vec3, d: Vec3, mu: number, mass: number): Omit<EdgeResult, 'edge'> {
  const r = sub(p, e.q1)
  const rd = cross(r, d)
  const lever = dot(e.axis, rd)
  if (lever <= 1e-12) return { value: Infinity, lever, outcome: 'none' }
  const F = (mass * GRAVITY * e.slopeMax) / lever
  const R = sub(scale(e.up, mass * GRAVITY), scale(d, F))
  // Moments about q1 at onset: L·k × R2 = −r × F·d − m·g·(q1 × up)
  const M = scale(sub(scale(rd, -F), scale(cross(e.q1, e.up), mass * GRAVITY)), 1 / e.L)
  return { value: F, lever, outcome: split(e, R, M, mu) }
}

// Splits the ground reaction R between the edge's two ends and checks that both
// push (not pull) and stay inside the friction cone. M = k × R2.
function split(e: EdgeModel, R: Vec3, M: Vec3, mu: number): Outcome {
  const R2 = cross(M, e.k)
  const n2 = dot(R2, e.up)
  const t2 = dot(R2, e.across)
  const n1 = dot(R, e.up) - n2
  const t1 = dot(R, e.across) - t2
  const s = dot(R, e.k)
  const tol = 1e-9 * (length(R) + 1e-12)
  if (n1 < -tol && n2 < -tol) return 'launch'
  if (n1 < -tol || n2 < -tol) return 'lift'
  const c1 = mu * Math.max(n1, 0)
  const c2 = mu * Math.max(n2, 0)
  if (t1 * t1 > c1 * c1 + tol * tol || t2 * t2 > c2 * c2 + tol * tol) return 'slide'
  const room = Math.sqrt(Math.max(c1 * c1 - t1 * t1, 0)) + Math.sqrt(Math.max(c2 * c2 - t2 * t2, 0))
  return Math.abs(s) > room + tol ? 'slide' : 'ok'
}

// Pivoting on one corner P of the support polygon (spec §3.6, corner pivots).
// An off-centre hit usually lifts one end of every edge, so the bot turns about
// a single point: angular momentum about P is conserved, ω = I_P⁻¹ (r × J·d).
// The horizontal part of ω is the tipping axis; tip energy and threshold spin are
// tabulated over the corner's outward directions and interpolated per hit.
export interface CornerModel {
  vertex: number
  P: Vec3                  // relative to the COM
  Iinv: Mat3               // inverse of the inertia about P
  up: Vec3
  e1: Vec3                 // horizontal basis; the corner's outward directions run
  e2: Vec3                 // from e1 (angle 0) toward e2, up to `width`
  width: number
  others: Vec3[]           // (Q − P) × up for the face's other vertices
  samples: CornerSample[]
}

export interface CornerSample {
  axis: Vec3               // tipping axis (horizontal)
  omega: number            // threshold spin about it
  slope: number            // largest gravity lever arm along the path
  landing: number
}

const CORNER_SAMPLES = 12

export function cornerModels(hull: Hull, st: Statics, roller: Roller, face: number, mass: MassProps, inertia: Mat3): CornerModel[] {
  const f = hull.faces[face]
  const n = f.normal
  const up = scale(n, -1)
  const m = mass.mass
  const L = f.verts.length
  return f.verts.map((v, j) => {
    const P = get(st.V, v)
    const prev = get(st.V, f.verts[(j + L - 1) % L])
    const next = get(st.V, f.verts[(j + 1) % L])
    const e1 = normalize(cross(sub(P, prev), n))
    const mNext = normalize(cross(sub(next, P), n))
    const e2raw = cross(up, e1)
    const e2 = dot(e2raw, mNext) < 0 ? scale(e2raw, -1) : e2raw
    const width = Math.atan2(dot(mNext, e2), dot(mNext, e1))
    const r = scale(P, -1)
    const rr = dot(r, r)
    const IP: Mat3 = [
      inertia[0] + m * (rr - r[0] * r[0]), inertia[1] - m * r[0] * r[1], inertia[2] - m * r[0] * r[2],
      inertia[3] - m * r[1] * r[0], inertia[4] + m * (rr - r[1] * r[1]), inertia[5] - m * r[1] * r[2],
      inertia[6] - m * r[2] * r[0], inertia[7] - m * r[2] * r[1], inertia[8] + m * (rr - r[2] * r[2]),
    ]
    const samples = Array.from({ length: CORNER_SAMPLES }, (_, s): CornerSample => {
      const phi = (width * s) / (CORNER_SAMPLES - 1)
      const h = add(scale(e1, Math.cos(phi)), scale(e2, Math.sin(phi)))
      const axis = normalize(cross(up, h))
      const path = tipPath(st.V, hull.count, n, h, v)
      const IGa = dot(axis, mulMat(inertia, axis))
      const omega = thresholdSpin(st.V, path, axis, IGa, m, st.faceHeight[face], add(r, scale(axis, dot(P, axis))))
      let slope = dot(P, h)
      for (const kink of path.kinks) {
        const q = get(st.V, kink.vertex)
        slope = Math.max(slope, dot(q, h) * Math.cos(kink.theta) - dot(q, n) * Math.sin(kink.theta))
      }
      const landing = rollFrom(roller, normalize(add(scale(n, Math.cos(path.land)), scale(h, Math.sin(path.land)))))
      return { axis, omega, slope, landing }
    })
    const others = f.verts.filter((q) => q !== v).map((q) => cross(sub(get(st.V, q), P), up))
    return { vertex: v, P, Iinv: inverse3(IP), up, e1, e2, width, others, samples }
  })
}

// The horizontal part of a spin w about corner c: its size, and the direction it
// tips the bot toward.
function cornerSpin(c: CornerModel, w: Vec3): { s: number, h: Vec3 } {
  const wh = sub(w, scale(c.up, dot(w, c.up)))
  const s = length(wh)
  return { s, h: s < 1e-12 ? [0, 0, 0] : cross(scale(wh, 1 / s), c.up) }
}

// Where a spin per unit impulse w tips the bot over corner c: the interpolated
// sample, the spin about the tipping axis, or null if c isn't the pivot.
function cornerTip(c: CornerModel, w: Vec3): { s: number, omega: number, landing: number } | null {
  const tol = 1e-9 * length(w)
  for (const o of c.others) if (dot(w, o) < -tol * length(o)) return null   // another corner would sink
  const { s, h } = cornerSpin(c, w)
  if (s < 1e-12) return null
  const t = Math.atan2(dot(h, c.e2), dot(h, c.e1)) / c.width
  if (t < -0.02 || t > 1.02) return null
  const x = Math.min(1, Math.max(0, t)) * (CORNER_SAMPLES - 1)
  const i = Math.min(CORNER_SAMPLES - 2, Math.floor(x))
  const a = c.samples[i]
  const b = c.samples[i + 1]
  const f = x - i
  return { s, omega: a.omega + (b.omega - a.omega) * f, landing: (f < 0.5 ? a : b).landing }
}

interface CornerResult {
  value: number
  mEff: number
  landing: number
  outcome: Outcome
  sample: number           // pushes: the tipping direction used (index into samples)
}

export function hitOnCorner(c: CornerModel, p: Vec3, d: Vec3, mu: number, mass: number): CornerResult {
  const tau = cross(sub(p, c.P), d)
  const w = mulMat(c.Iinv, tau)
  const mEff = 1 / dot(tau, w)
  const tip = cornerTip(c, w)
  if (!tip || !Number.isFinite(tip.omega) || tip.landing < 0) return { value: Infinity, mEff, landing: -1, outcome: 'none', sample: -1 }
  const J = tip.omega / tip.s
  const vG = cross(w, scale(c.P, -1))
  if (dot(vG, c.up) <= 0) return { value: Infinity, mEff, landing: -1, outcome: 'none', sample: -1 }
  const R = scale(sub(scale(vG, mass), d), J)
  return { value: J, mEff, landing: tip.landing, outcome: groundCheck(R, c.up, mu), sample: -1 }
}

export function pushOnCorner(c: CornerModel, p: Vec3, d: Vec3, mu: number, mass: number, face: number): CornerResult {
  const tau = cross(sub(p, c.P), d)
  let best: CornerResult = { value: Infinity, mEff: 0, landing: -1, outcome: 'none', sample: -1 }
  c.samples.forEach((s, i) => {
    if (s.landing < 0 || s.landing === face) return
    const lever = dot(tau, s.axis)
    if (lever <= 1e-12) return
    const F = (mass * GRAVITY * s.slope) / lever
    if (F >= best.value) return
    const R = sub(scale(c.up, mass * GRAVITY), scale(d, F))
    best = { value: F, mEff: 0, landing: s.landing, outcome: groundCheck(R, c.up, mu), sample: i }
  })
  return best
}

// A single contact must push, and stay inside the friction cone.
function groundCheck(R: Vec3, up: Vec3, mu: number): Outcome {
  const n = dot(R, up)
  const tol = 1e-9 * length(R)
  if (n < -tol) return 'launch'
  const t = length(sub(R, scale(up, n)))
  return t > mu * Math.max(n, 0) + tol ? 'slide' : 'ok'
}

export interface Pivots {
  edges: EdgeModel[]
  corners: CornerModel[]
}

export interface PivotResult {
  kind: 'edge' | 'corner'
  index: number
  value: number            // J_min (N·s) or F_min (N)
  mEff: number             // the bot's effective mass at the hit point (impulse mode)
  landing: number
  outcome: Outcome
  sample: number           // corner pushes: the tipping direction used
}

// The cheapest way this hit flips the bot out of pose `face`, or why it can't.
export function bestPivot(
  pv: Pivots, face: number, p: Vec3, d: Vec3, mu: number, mode: 'impulse' | 'push', mass: number,
): { best: PivotResult | null, reason: Outcome } {
  const results: PivotResult[] = []
  pv.edges.forEach((e, i) => {
    const r = mode === 'impulse' ? hitOnEdge(e, p, d, mu) : pushOnEdge(e, p, d, mu, mass)
    results.push({ kind: 'edge', index: i, value: r.value, mEff: e.Ia / (r.lever * r.lever), landing: e.landing, outcome: r.outcome, sample: -1 })
  })
  pv.corners.forEach((c, i) => {
    const r = mode === 'impulse' ? hitOnCorner(c, p, d, mu, mass) : pushOnCorner(c, p, d, mu, mass, face)
    results.push({ kind: 'corner', index: i, ...r })
  })
  for (const r of results) if (r.outcome === 'ok' && (r.landing === face || r.landing < 0)) r.outcome = 'returns'
  let best: PivotResult | null = null
  for (const r of results) if (r.outcome === 'ok' && (!best || r.value < best.value)) best = r
  if (best) return { best, reason: 'ok' }
  const tipping = results.filter((r) => r.outcome !== 'none')
  const reason: Outcome =
    tipping.length === 0 ? 'none'
      : tipping.every((r) => r.outcome === 'launch') ? 'launch'
        : tipping.some((r) => r.outcome === 'slide') ? 'slide'
          : tipping.some((r) => r.outcome === 'lift') ? 'lift'
            : 'returns'
  return { best: null, reason }
}

// The planar path a hit sends the bot along through pivot r: the great circle
// u(θ) = cos θ·n + sin θ·m starting on hull vertex `start`, the inertia about the
// tipping axis through the COM, and the spin each N·s of impulse starts.
export interface HitPath {
  m: Vec3
  start: number
  path: TipPath
  IGa: number
  spinPerJ: number         // impulse mode
  value: number            // J_min or F_min, from this exact path
}

// n is the pose's down vector, h0 its COM height. For an impulse on a corner the
// path is traced for this hit's own tipping direction instead of read from the
// corner's table, so J_min here can differ slightly from the heatmap's.
export function hitPath(pv: Pivots, r: PivotResult, V: Float64Array, count: number, n: Vec3, h0: number, p: Vec3, d: Vec3, inertia: Mat3, mass: number): HitPath {
  const about = (axis: Vec3) => dot(axis, mulMat(inertia, axis))
  if (r.kind === 'edge') {
    const e = pv.edges[r.index]
    const lever = dot(e.axis, cross(sub(p, e.q1), d))
    return { m: e.out, start: e.a, path: e.path, IGa: about(e.axis), spinPerJ: lever / e.Ia, value: r.value }
  }
  const c = pv.corners[r.index]
  if (r.sample >= 0) {
    const phi = (c.width * r.sample) / (CORNER_SAMPLES - 1)
    const h = add(scale(c.e1, Math.cos(phi)), scale(c.e2, Math.sin(phi)))
    return { m: h, start: c.vertex, path: tipPath(V, count, n, h, c.vertex), IGa: about(c.samples[r.sample].axis), spinPerJ: 0, value: r.value }
  }
  const { s, h } = cornerSpin(c, mulMat(c.Iinv, cross(sub(p, c.P), d)))
  const axis = normalize(cross(c.up, h))
  const path = tipPath(V, count, n, h, c.vertex)
  const IGa = about(axis)
  const omega = thresholdSpin(V, path, axis, IGa, mass, h0, add(scale(c.P, -1), scale(axis, dot(c.P, axis))))
  return { m: h, start: c.vertex, path, IGa, spinPerJ: s, value: omega / s }
}

// Impulse a weapon of effective mass mw delivers to a point of effective mass mEff.
export function weaponImpulse(mEff: number, weaponMass: number, speed: number, restitution: number): number {
  return ((1 + restitution) * speed) / (1 / weaponMass + 1 / mEff)
}
