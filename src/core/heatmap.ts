import type { Groups } from './displayMesh.ts'
import type { Pivots } from './impact.ts'
import { GRAVITY } from './units.ts'
import { cross, length, perpendicular, type Vec3 } from './vec.ts'

export type HitMode = 'impulse' | 'push'

export type Directions =
  | { kind: 'fixed', d: Vec3 }
  | { kind: 'worst', up: Vec3, elevation: number }   // elevation in rad, positive rises

export interface HeatSpec {
  mode: HitMode
  mu: number
  mass: number
  dirs: Directions
}

const EDGE = 24
const CORNER = 23
const SAMPLE = 6
const AZIMUTHS = 12
export const PASSES = 2

// Flattened per-pivot constants, so the per-vertex loop does no allocation.
// Edges: the reaction is R = R0 − X·d and k × R2 = (M0 − X·(r × d)) / L, where X
// is J_min or F_min = num / lever. Corners: see cornerTip in impact.ts.
function pack(pv: Pivots, face: number, spec: HeatSpec) {
  const mg = spec.mass * GRAVITY
  const edges = new Float64Array(pv.edges.length * EDGE)
  pv.edges.forEach((e, i) => {
    const flips = e.landing >= 0 && e.landing !== face && (spec.mode === 'push' || Number.isFinite(e.omega))
    const R0 = spec.mode === 'impulse' ? e.mvG : [e.up[0] * mg, e.up[1] * mg, e.up[2] * mg]
    const gm = cross(e.q1, e.up)
    const M0 = spec.mode === 'impulse' ? e.Hq1 : [-gm[0] * mg, -gm[1] * mg, -gm[2] * mg]
    const num = spec.mode === 'impulse' ? e.Ia * e.omega : mg * e.slopeMax
    edges.set([...e.q1, ...e.axis, ...e.k, ...e.up, ...e.across, ...R0, ...M0, num, 1 / e.L, flips ? 1 : 0], i * EDGE)
  })
  const corners = new Float64Array(pv.corners.length * CORNER)
  const others: number[] = []
  const otherStart: number[] = []
  const samples: number[] = []
  pv.corners.forEach((c, i) => {
    const omegaMin = Math.min(...c.samples.map((x) => x.omega))
    corners.set([...c.P, ...c.Iinv, ...c.up, ...c.e1, ...c.e2, c.width, omegaMin], i * CORNER)
    otherStart.push(others.length)
    for (const o of c.others) {
      const l = length(o) || 1
      others.push(o[0] / l, o[1] / l, o[2] / l)
    }
    for (const s of c.samples) {
      const flips = s.landing >= 0 && s.landing !== face && Number.isFinite(s.omega)
      samples.push(...s.axis, s.omega, s.slope, flips ? 1 : 0)
    }
  })
  otherStart.push(others.length)
  const perCorner = pv.corners[0]?.samples.length ?? 0
  return { edges, corners, others: Float64Array.from(others), otherStart, samples: Float64Array.from(samples), perCorner }
}

// Fills `out` with J_min (or F_min) for the display vertices of positions
// start..end (see Groups; without groups, every vertex is its own position).
// Positions are absolute body coordinates; `com` shifts them. NaN: no direction in
// the set hits that surface from outside. Infinity: hits there don't flip the bot.
// The value at a position only depends on the direction; copies split along a
// crease differ only in which directions can reach them.
export function heatRange(
  pv: Pivots, face: number, spec: HeatSpec, P: Float64Array, com: Vec3, N: Float32Array,
  out: Float32Array, start: number, end: number, groups?: Groups, pass = 0,
) {
  const { edges: E, corners: C, others: O, otherStart, samples: S, perCorner } = pack(pv, face, spec)
  const nE = pv.edges.length
  const nC = pv.corners.length
  const mu = spec.mu
  const m = spec.mass
  const mg = m * GRAVITY
  const impulse = spec.mode === 'impulse'

  const value = (px: number, py: number, pz: number, dx: number, dy: number, dz: number, cap: number) => {
    let best = cap
    for (let o = 0; o < nE * EDGE; o += EDGE) {
      if (E[o + 23] === 0) continue
      const rx = px - E[o], ry = py - E[o + 1], rz = pz - E[o + 2]
      const cx = ry * dz - rz * dy
      const cy = rz * dx - rx * dz
      const cz = rx * dy - ry * dx
      const lever = E[o + 3] * cx + E[o + 4] * cy + E[o + 5] * cz
      if (lever <= 1e-12) continue
      const X = E[o + 21] / lever
      if (X >= best) continue
      const kx = E[o + 6], ky = E[o + 7], kz = E[o + 8]
      const ux = E[o + 9], uy = E[o + 10], uz = E[o + 11]
      const ax = E[o + 12], ay = E[o + 13], az = E[o + 14]
      const Rx = E[o + 15] - X * dx, Ry = E[o + 16] - X * dy, Rz = E[o + 17] - X * dz
      const iL = E[o + 22]
      const Mx = (E[o + 18] - X * cx) * iL, My = (E[o + 19] - X * cy) * iL, Mz = (E[o + 20] - X * cz) * iL
      const R2x = My * kz - Mz * ky, R2y = Mz * kx - Mx * kz, R2z = Mx * ky - My * kx
      const n2 = R2x * ux + R2y * uy + R2z * uz
      const t2 = R2x * ax + R2y * ay + R2z * az
      const n1 = Rx * ux + Ry * uy + Rz * uz - n2
      const t1 = Rx * ax + Ry * ay + Rz * az - t2
      const s = Rx * kx + Ry * ky + Rz * kz
      const tol = 1e-9 * (Math.abs(Rx) + Math.abs(Ry) + Math.abs(Rz))
      if (n1 < -tol || n2 < -tol) continue
      const c1 = mu * n1
      const c2 = mu * n2
      if (t1 * t1 > c1 * c1 + tol * tol || t2 * t2 > c2 * c2 + tol * tol) continue
      if (Math.abs(s) > Math.sqrt(Math.max(c1 * c1 - t1 * t1, 0)) + Math.sqrt(Math.max(c2 * c2 - t2 * t2, 0)) + tol) continue
      best = X
    }

    for (let c = 0; c < nC; c++) {
      const o = c * CORNER
      const Px = C[o], Py = C[o + 1], Pz = C[o + 2]
      const rx = px - Px, ry = py - Py, rz = pz - Pz
      const tx = ry * dz - rz * dy
      const ty = rz * dx - rx * dz
      const tz = rx * dy - ry * dx
      const ux = C[o + 12], uy = C[o + 13], uz = C[o + 14]
      const sBase = c * perCorner * SAMPLE
      if (!impulse) {
        for (let k = 0; k < perCorner; k++) {
          const q = sBase + k * SAMPLE
          if (S[q + 5] === 0) continue
          const lever = tx * S[q] + ty * S[q + 1] + tz * S[q + 2]
          if (lever <= 1e-12) continue
          const F = (mg * S[q + 4]) / lever
          if (F >= best) continue
          const Rx = ux * mg - F * dx, Ry = uy * mg - F * dy, Rz = uz * mg - F * dz
          const Rn = Rx * ux + Ry * uy + Rz * uz
          if (Rn < 0) continue
          if (Rx * Rx + Ry * Ry + Rz * Rz - Rn * Rn > mu * mu * Rn * Rn) continue
          best = F
        }
        continue
      }
      // Spin per unit impulse, w = I_P⁻¹ (r × d).
      const wx = C[o + 3] * tx + C[o + 4] * ty + C[o + 5] * tz
      const wy = C[o + 6] * tx + C[o + 7] * ty + C[o + 8] * tz
      const wz = C[o + 9] * tx + C[o + 10] * ty + C[o + 11] * tz
      const wl = Math.sqrt(wx * wx + wy * wy + wz * wz)
      let sinks = false
      for (let q = otherStart[c]; q < otherStart[c + 1]; q += 3) {
        if (wx * O[q] + wy * O[q + 1] + wz * O[q + 2] < -1e-9 * wl) {
          sinks = true
          break
        }
      }
      if (sinks) continue
      const wu = wx * ux + wy * uy + wz * uz
      const hx0 = wx - wu * ux, hy0 = wy - wu * uy, hz0 = wz - wu * uz
      const s = Math.sqrt(hx0 * hx0 + hy0 * hy0 + hz0 * hz0)
      if (s < 1e-12 || C[o + 22] / s >= best) continue
      // Tipping direction (axis × up), as an angle across the corner.
      const hx = (hy0 * uz - hz0 * uy) / s, hy = (hz0 * ux - hx0 * uz) / s, hz = (hx0 * uy - hy0 * ux) / s
      const t = fastAtan2(hx * C[o + 18] + hy * C[o + 19] + hz * C[o + 20], hx * C[o + 15] + hy * C[o + 16] + hz * C[o + 17]) / C[o + 21]
      if (t < -0.02 || t > 1.02) continue
      const xs = Math.min(1, Math.max(0, t)) * (perCorner - 1)
      const i = Math.min(perCorner - 2, Math.floor(xs))
      const f = xs - i
      const qa = sBase + i * SAMPLE
      const qb = qa + SAMPLE
      if (S[f < 0.5 ? qa + 5 : qb + 5] === 0) continue
      const omega = S[qa + 3] + (S[qb + 3] - S[qa + 3]) * f
      const J = omega / s
      if (!(J < best)) continue
      // COM velocity per unit impulse, w × (G − P), and the ground's reaction.
      const vx = -(wy * Pz - wz * Py), vy = -(wz * Px - wx * Pz), vz = -(wx * Py - wy * Px)
      if (vx * ux + vy * uy + vz * uz <= 0) continue
      const Rx = m * vx - dx, Ry = m * vy - dy, Rz = m * vz - dz
      const Rn = Rx * ux + Ry * uy + Rz * uz
      if (Rn < 0) continue
      if (Rx * Rx + Ry * Ry + Rz * Rz - Rn * Rn > mu * mu * Rn * Rn) continue
      best = J
    }
    return best
  }

  const GS = groups?.start ?? Uint32Array.from({ length: end + 1 }, (_, i) => i)
  const GM = groups?.members ?? Uint32Array.from({ length: end }, (_, i) => i)

  // One direction: evaluate each position once, if any of its copies faces the hit.
  const dirs = spec.dirs
  if (dirs.kind === 'fixed') {
    const [dx, dy, dz] = dirs.d
    for (let b = start; b < end; b++) {
      let v = NaN
      for (let j = GS[b]; j < GS[b + 1]; j++) {
        const i = GM[j]
        if (dx * N[3 * i] + dy * N[3 * i + 1] + dz * N[3 * i + 2] >= 0) {
          out[i] = NaN
          continue
        }
        if (Number.isNaN(v)) v = value(P[3 * i] - com[0], P[3 * i + 1] - com[1], P[3 * i + 2] - com[2], dx, dy, dz, Infinity)
        out[i] = v
      }
    }
    return
  }

  // Worst over azimuths at a fixed elevation, in two passes of 6 directions each
  // (pass 1 fills in between pass 0's and merges). With all 12, 30° apart, J near
  // the best direction grows like 1 / cos(Δφ), so a miss costs at most 3.5%.
  const frame = horizontalFrame(dirs.up)
  const ce = Math.cos(dirs.elevation)
  const se = Math.sin(dirs.elevation)
  const nDir = AZIMUTHS / PASSES
  const D = new Float64Array(3 * nDir)
  for (let k = 0; k < nDir; k++) {
    const phi = (2 * Math.PI * (pass + PASSES * k)) / AZIMUTHS
    const c = Math.cos(phi) * ce
    const s = Math.sin(phi) * ce
    for (let a = 0; a < 3; a++) D[3 * k + a] = c * frame[a] + s * frame[3 + a] + se * dirs.up[a]
  }
  let maxGroup = 1
  for (let b = start; b < end; b++) maxGroup = Math.max(maxGroup, GS[b + 1] - GS[b])
  const best = new Float64Array(maxGroup)
  const reach = new Uint8Array(maxGroup)
  const faces = new Uint8Array(maxGroup)
  for (let b = start; b < end; b++) {
    const j0 = GS[b]
    const size = GS[b + 1] - j0
    for (let m = 0; m < size; m++) {
      const prev = pass > 0 ? out[GM[j0 + m]] : NaN
      best[m] = Number.isNaN(prev) ? Infinity : prev
      reach[m] = Number.isNaN(prev) ? 0 : 1
    }
    const i0 = GM[j0]
    const px = P[3 * i0] - com[0], py = P[3 * i0 + 1] - com[1], pz = P[3 * i0 + 2] - com[2]
    for (let k = 0; k < nDir; k++) {
      const dx = D[3 * k], dy = D[3 * k + 1], dz = D[3 * k + 2]
      // Only worth evaluating below the worst current best of the copies it can reach.
      let cap = -1
      for (let m = 0; m < size; m++) {
        const i = GM[j0 + m]
        faces[m] = dx * N[3 * i] + dy * N[3 * i + 1] + dz * N[3 * i + 2] < 0 ? 1 : 0
        if (faces[m] && best[m] > cap) cap = best[m]
      }
      if (cap < 0) continue
      const v = value(px, py, pz, dx, dy, dz, cap)
      for (let m = 0; m < size; m++) {
        if (!faces[m]) continue
        reach[m] = 1
        if (v < best[m]) best[m] = v
      }
    }
    for (let m = 0; m < size; m++) out[GM[j0 + m]] = reach[m] ? best[m] : NaN
  }
}

// Worst-direction search for a single point: returns the direction it used.
export function worstDirection(pv: Pivots, face: number, spec: HeatSpec, p: Vec3, normal: Vec3): Vec3 | null {
  if (spec.dirs.kind === 'fixed') return spec.dirs.d
  const { up, elevation } = spec.dirs
  const frame = horizontalFrame(up)
  let best = Infinity
  let bestD: Vec3 | null = null
  const out = new Float32Array(1)
  const P = Float64Array.from(p)
  const N = Float32Array.from(normal)
  for (let k = 0; k < 4 * AZIMUTHS; k++) {
    const phi = (k * 2 * Math.PI) / (4 * AZIMUTHS)
    const d: Vec3 = [0, 1, 2].map((j) =>
      Math.cos(elevation) * (Math.cos(phi) * frame[j] + Math.sin(phi) * frame[3 + j]) + Math.sin(elevation) * up[j]) as Vec3
    heatRange(pv, face, { ...spec, dirs: { kind: 'fixed', d } }, P, [0, 0, 0], N, out, 0, 1)
    if (Number.isNaN(out[0])) continue
    if (!bestD || out[0] < best) {
      best = out[0]
      bestD = d
    }
  }
  return bestD
}

// atan2 to about 1e-5 rad, several times faster than Math.atan2 in this loop.
function fastAtan2(y: number, x: number): number {
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  if (ax === 0 && ay === 0) return 0
  const swap = ay > ax
  const z = swap ? ax / ay : ay / ax
  const z2 = z * z
  let r = z * (0.99997726 + z2 * (-0.33262347 + z2 * (0.19354346 + z2 * (-0.11643287 + z2 * (0.05265332 - 0.0117212 * z2)))))
  if (swap) r = Math.PI / 2 - r
  if (x < 0) r = Math.PI - r
  return y < 0 ? -r : r
}

// Two horizontal unit vectors (e1, e2) for a ground normal `up`.
function horizontalFrame(up: Vec3): number[] {
  const e1 = perpendicular(up)
  const e2 = cross(up, e1)
  return [...e1, ...e2]
}
