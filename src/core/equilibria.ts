import type { Hull } from './hull.ts'
import { add, cross, dot, get, length, scale, sub, type Vec3 } from './vec.ts'

export interface Saddle {
  edge: number
  height: number          // COM height balanced on the edge
  down: Vec3              // body-frame down vector at the balance point
}

export interface Statics {
  V: Float64Array         // hull vertices relative to the COM
  faceHeight: Float64Array
  stable: Uint8Array
  inset: Float64Array     // stable faces: projected COM to the nearest edge line; otherwise -1
  saddles: Saddle[]
  maxima: number[]        // hull vertex ids
  depth: number           // smallest face height; ≤ 0 means the COM is outside the hull
}

// Classifies every hull face, edge and vertex as an equilibrium or not (notes §4.1–4.2).
export function classify(hull: Hull, com: Vec3): Statics {
  const V = new Float64Array(hull.verts.length)
  for (let i = 0; i < V.length; i++) V[i] = hull.verts[i] - com[i % 3]
  const eps = 1e-9 * hull.size

  const faceHeight = new Float64Array(hull.faces.length)
  const stable = new Uint8Array(hull.faces.length)
  const inset = new Float64Array(hull.faces.length).fill(-1)
  let depth = Infinity
  hull.faces.forEach((f, fi) => {
    let h = -Infinity
    for (const v of f.verts) h = Math.max(h, dot(f.normal, get(V, v)))
    faceHeight[fi] = h
    depth = Math.min(depth, h)
    const p = scale(f.normal, h)
    let d = Infinity
    for (let j = 0; j < f.verts.length; j++) {
      const a = get(V, f.verts[j])
      const b = get(V, f.verts[(j + 1) % f.verts.length])
      const ab = sub(b, a)
      d = Math.min(d, dot(cross(ab, sub(p, a)), f.normal) / length(ab))
    }
    if (d > eps) {
      stable[fi] = 1
      inset[fi] = d
    }
  })

  const saddles: Saddle[] = []
  hull.edges.forEach((e, ei) => {
    const a = get(V, e.a)
    const ab = sub(get(V, e.b), a)
    const t = -dot(a, ab) / dot(ab, ab)
    if (t <= 1e-12 || t >= 1 - 1e-12) return
    const foot = add(a, scale(ab, t))
    const height = length(foot)
    const w = scale(foot, 1 / height)
    if (between(w, hull.faces[e.left].normal, hull.faces[e.right].normal)) saddles.push({ edge: ei, height, down: w })
  })

  const maxima: number[] = []
  for (let i = 0; i < hull.count; i++) {
    const v = get(V, i)
    let ok = true
    for (const j of hull.neighbors[i]) {
      if (dot(v, sub(v, get(V, j))) <= 0) {
        ok = false
        break
      }
    }
    if (ok) maxima.push(i)
  }

  return { V, faceHeight, stable, inset, saddles, maxima, depth }
}

// True if unit w lies strictly inside the short arc from n1 to n2 (all three
// perpendicular to the same edge).
function between(w: Vec3, n1: Vec3, n2: Vec3): boolean {
  const k = cross(n1, n2)
  const kk = dot(k, k)
  if (kk < 1e-24) return false
  return dot(cross(w, n2), k) / kk > 1e-12 && dot(cross(n1, w), k) / kk > 1e-12
}
