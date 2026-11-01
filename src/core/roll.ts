import type { Statics } from './equilibria.ts'
import { edgeBetween, support, type Hull } from './hull.ts'
import { add, clamp, dot, get, length, normalize, perpendicular, scale, sub, type Vec3 } from './vec.ts'

// One stretch of a roll: the bot turns about `point` (relative to the COM) while
// its body-frame down vector moves along a great circle from `from` to `to`.
export interface Segment {
  kind: 'pivot' | 'edge'
  point: Vec3
  from: Vec3
  to: Vec3
}

export interface Roller {
  hull: Hull
  st: Statics
  faceDest: Int32Array    // stable face reached from rest on each face (-1: unresolved)
}

const MAX_STEPS = 20000

export function makeRoller(hull: Hull, st: Statics): Roller {
  const r: Roller = { hull, st, faceDest: new Int32Array(hull.faces.length).fill(-1) }
  for (let f = 0; f < hull.faces.length; f++) if (st.stable[f]) r.faceDest[f] = f
  for (let f = 0; f < hull.faces.length; f++) resolve(r, f)
  return r
}

// Rolls quasi-statically from body-frame down vector u. Returns the stable face it
// settles on (-1 if unresolved). Pass `path` to record the motion.
export function rollFrom(r: Roller, u: Vec3, path?: Segment[]): number {
  const f = pivot(r, support(r.hull, u), u, path)
  if (f < 0) return -1
  if (!path) return resolve(r, f)
  let g = f
  for (let i = 0; i < MAX_STEPS && g >= 0 && !r.st.stable[g]; i++) g = nextFromFace(r, g, path)
  return g >= 0 && r.st.stable[g] ? g : -1
}

// Stable face reached from rest on face f, memoized along the way.
export function resolve(r: Roller, f: number): number {
  if (r.faceDest[f] >= 0) return r.faceDest[f]
  const chain: number[] = []
  let g = f
  while (g >= 0 && r.faceDest[g] < 0) {
    chain.push(g)
    if (chain.length > r.hull.faces.length) {
      g = -1
      break
    }
    g = nextFromFace(r, g)
  }
  const dest = g < 0 ? -1 : r.faceDest[g]
  for (const c of chain) r.faceDest[c] = dest
  return dest
}

// From rest on unstable face f: the next face the bot lands on.
function nextFromFace(r: Roller, f: number, path?: Segment[]): number {
  const { hull, st } = r
  const face = hull.faces[f]
  const p = scale(face.normal, st.faceHeight[f])
  let best = Infinity
  let edge = -1
  let vertex = -1
  const m = face.verts.length
  for (let j = 0; j < m; j++) {
    const ia = face.verts[j]
    const ib = face.verts[(j + 1) % m]
    const a = get(st.V, ia)
    const ab = sub(get(st.V, ib), a)
    const t = clamp(dot(sub(p, a), ab) / dot(ab, ab), 0, 1)
    const dist = length(sub(p, add(a, scale(ab, t))))
    if (dist < best) {
      best = dist
      edge = t > 0 && t < 1 ? face.edges[j] : -1
      vertex = t <= 0 ? ia : t >= 1 ? ib : -1
    }
  }
  if (edge >= 0) {
    const e = hull.edges[edge]
    const g = e.left === f ? e.right : e.left
    path?.push({ kind: 'edge', point: get(st.V, e.a), from: face.normal, to: hull.faces[g].normal })
    return g
  }
  return pivot(r, vertex, face.normal, path)
}

// Pivots on vertex v starting from down vector u, through any further pivots and
// edge rolls, until a face lands. Returns that face.
function pivot(r: Roller, v: number, u: Vec3, path?: Segment[]): number {
  const { hull, st } = r
  for (let step = 0; step < MAX_STEPS; step++) {
    const Vv = get(st.V, v)
    const w = normalize(Vv)
    const c = dot(u, w)
    const tRaw = sub(u, scale(w, c))
    const tl = length(tRaw)
    // Moving u away from w along their great circle lowers the COM.
    const t = tl < 1e-12 ? perpendicular(w) : scale(tRaw, 1 / tl)
    const phi0 = Math.atan2(dot(u, t), c)

    // Leave the vertex's normal cone where the first neighbour comes down to the ground.
    let delta = Infinity
    let j = -1
    for (const k of hull.neighbors[v]) {
      const D = sub(Vv, get(st.V, k))
      const A = dot(w, D)
      const B = dot(t, D)
      let d = (Math.atan2(B, A) + Math.PI / 2 - phi0) % (2 * Math.PI)
      if (d < 0) d += 2 * Math.PI
      if (d > Math.PI + 1e-6) d = 0   // already past this side (rounding)
      if (d < delta) {
        delta = d
        j = k
      }
    }
    if (j < 0) return -1
    const phi1 = phi0 + delta
    const u1: Vec3 = normalize(add(scale(w, Math.cos(phi1)), scale(t, Math.sin(phi1))))
    if (delta > 0) path?.push({ kind: 'pivot', point: Vv, from: u, to: u1 })

    const ei = edgeBetween(hull, v, j)
    const e = hull.edges[ei]
    const nl = hull.faces[e.left].normal
    const nr = hull.faces[e.right].normal
    if (dot(u1, nl) > 1 - 1e-12) return e.left
    if (dot(u1, nr) > 1 - 1e-12) return e.right

    const a = Vv
    const ab = sub(get(st.V, j), a)
    const s = -dot(a, ab) / dot(ab, ab)
    if (s >= 1 - 1e-9) {
      // The COM projects past the far end: that end becomes the pivot.
      v = j
      u = u1
      continue
    }
    // Otherwise roll about the edge, away from the point directly under the COM.
    const foot = normalize(add(a, scale(ab, Math.max(s, 0))))
    const toLeft = sub(nl, scale(u1, dot(nl, u1)))
    const g = dot(toLeft, foot) < 0 ? e.left : e.right
    path?.push({ kind: 'edge', point: a, from: u1, to: hull.faces[g].normal })
    return g
  }
  return -1
}
