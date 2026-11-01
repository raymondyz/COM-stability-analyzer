import { extrude } from './sample.ts'
import { weld, type Mesh } from './weld.ts'

// Small closed meshes for tests and benchmarks (metres, outward winding).

export function prismMesh(outline: [number, number][], y0: number, y1: number): Mesh {
  const tris: number[] = []
  extrude(tris, outline, y0, y1)
  return weld(Float32Array.from(tris), 1)
}

export function boxMesh(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, split = false): Mesh {
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ]
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]]
  const tris: number[] = []
  for (const [a, b, cc, d] of quads) {
    if (split) {
      // Fan from the face centre, so every face is split into four coplanar triangles.
      const m = [0, 1, 2].map((k) => (c[a][k] + c[b][k] + c[cc][k] + c[d][k]) / 4)
      for (const [p, q] of [[a, b], [b, cc], [cc, d], [d, a]]) tris.push(...m, ...c[p], ...c[q])
    } else {
      tris.push(...c[a], ...c[b], ...c[cc], ...c[a], ...c[cc], ...c[d])
    }
  }
  return weld(Float32Array.from(tris), 1)
}

export function tetraMesh(): Mesh {
  const p = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]]
  const faces = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]]
  const tris: number[] = []
  for (const f of faces) for (const v of f) tris.push(...p[v])
  return weld(Float32Array.from(tris), 1)
}
