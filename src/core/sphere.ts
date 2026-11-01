export interface Icosphere {
  verts: Float64Array     // unit vectors
  faces: Uint32Array
  weights: Float64Array   // share of the sphere's area per vertex; sums to 1
}

// Level k has 10·4^k + 2 vertices, and its vertices start with all of level k − 1's
// in the same order, so finer levels can reuse coarser results.
export const vertexCount = (level: number) => 10 * 4 ** level + 2

const levels: Icosphere[] = []

export function icosphere(level: number): Icosphere {
  if (levels[level]) return levels[level]
  const t = (1 + Math.sqrt(5)) / 2
  const pts: number[] = []
  const push = (x: number, y: number, z: number) => {
    const l = Math.hypot(x, y, z)
    pts.push(x / l, y / l, z / l)
  }
  for (const [x, y, z] of [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ]) push(x, y, z)
  let faces = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ]
  levels[0] ??= finish(pts, faces)
  for (let k = 1; k <= level; k++) {
    const mid = new Map<number, number>()
    const midpoint = (a: number, b: number) => {
      const key = Math.min(a, b) * 2 ** 20 + Math.max(a, b)
      let m = mid.get(key)
      if (m === undefined) {
        m = pts.length / 3
        push(pts[3 * a] + pts[3 * b], pts[3 * a + 1] + pts[3 * b + 1], pts[3 * a + 2] + pts[3 * b + 2])
        mid.set(key, m)
      }
      return m
    }
    const next: number[] = []
    for (let f = 0; f < faces.length; f += 3) {
      const [a, b, c] = [faces[f], faces[f + 1], faces[f + 2]]
      const ab = midpoint(a, b)
      const bc = midpoint(b, c)
      const ca = midpoint(c, a)
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca)
    }
    faces = next
    levels[k] ??= finish(pts, faces)
  }
  return levels[level]
}

function finish(pts: number[], faces: number[]): Icosphere {
  const verts = Float64Array.from(pts)
  const weights = new Float64Array(pts.length / 3)
  for (let f = 0; f < faces.length; f += 3) {
    const a = 3 * faces[f]
    const b = 3 * faces[f + 1]
    const c = 3 * faces[f + 2]
    // Solid angle of a spherical triangle (Van Oosterom and Strackee).
    const det =
      verts[a] * (verts[b + 1] * verts[c + 2] - verts[b + 2] * verts[c + 1]) -
      verts[a + 1] * (verts[b] * verts[c + 2] - verts[b + 2] * verts[c]) +
      verts[a + 2] * (verts[b] * verts[c + 1] - verts[b + 1] * verts[c])
    const ab = verts[a] * verts[b] + verts[a + 1] * verts[b + 1] + verts[a + 2] * verts[b + 2]
    const bc = verts[b] * verts[c] + verts[b + 1] * verts[c + 1] + verts[b + 2] * verts[c + 2]
    const ca = verts[c] * verts[a] + verts[c + 1] * verts[a + 1] + verts[c + 2] * verts[a + 2]
    const omega = 2 * Math.atan2(Math.abs(det), 1 + ab + bc + ca)
    for (const v of [faces[f], faces[f + 1], faces[f + 2]]) weights[v] += omega / 3 / (4 * Math.PI)
  }
  return { verts, faces: Uint32Array.from(faces), weights }
}
