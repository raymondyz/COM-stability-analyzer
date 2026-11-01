import type { Mesh } from './weld.ts'

export interface DisplayMesh {
  positions: Float64Array
  indices: Uint32Array
  normals: Float32Array
  groups: Groups             // vertices that share a position (split along creases)
}

// For each distinct position b, its display vertices are members[start[b] .. start[b + 1]).
export interface Groups {
  start: Uint32Array
  members: Uint32Array
}

// The mesh that is drawn and painted. CAD exports cover big flat faces with a
// few long triangles, and welded vertices average normals across sharp edges, so
// per-vertex heatmap values would smear round corners. Here long edges are split
// (flat faces get interior samples) and vertices are split along creases sharper
// than `creaseDeg` (each side of an edge gets its own normal).
export function displayMesh(mesh: Mesh, maxEdge: number, flip: boolean, creaseDeg = 35): DisplayMesh {
  const { positions, indices } = subdivide(mesh.positions, mesh.indices, maxEdge)
  const nv = positions.length / 3
  const nt = indices.length / 3
  const sign = flip ? -1 : 1

  // Face normals: unnormalized (length = 2 × area) for weighting, and unit for grouping.
  const fn = new Float64Array(3 * nt)
  const un = new Float32Array(3 * nt)
  for (let t = 0; t < nt; t++) {
    const a = 3 * indices[3 * t], b = 3 * indices[3 * t + 1], c = 3 * indices[3 * t + 2]
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2]
    fn[3 * t] = sign * (uy * vz - uz * vy)
    fn[3 * t + 1] = sign * (uz * vx - ux * vz)
    fn[3 * t + 2] = sign * (ux * vy - uy * vx)
    const l = Math.sqrt(fn[3 * t] ** 2 + fn[3 * t + 1] ** 2 + fn[3 * t + 2] ** 2) || 1
    un[3 * t] = fn[3 * t] / l
    un[3 * t + 1] = fn[3 * t + 1] / l
    un[3 * t + 2] = fn[3 * t + 2] / l
  }

  // Vertex → incident triangles (CSR).
  const start = new Uint32Array(nv + 1)
  for (let i = 0; i < indices.length; i++) start[indices[i] + 1]++
  for (let v = 0; v < nv; v++) start[v + 1] += start[v]
  const fill = start.slice(0, nv)
  const incident = new Uint32Array(indices.length)
  for (let i = 0; i < indices.length; i++) incident[fill[indices[i]]++] = i   // corner index 3t + k

  // Group each vertex's triangles by normal; every group past the first becomes a new vertex.
  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180)
  const outIndex = new Uint32Array(indices.length)
  const extra: number[] = []          // original vertex of each added vertex
  const base = new Float64Array(3 * nv)   // accumulated normals, original vertices
  const added: number[] = []              // accumulated normals, added vertices
  const reps: number[] = []
  const groups: number[] = []
  for (let v = 0; v < nv; v++) {
    reps.length = 0
    groups.length = 0
    for (let k = start[v]; k < start[v + 1]; k++) {
      const corner = incident[k]
      const t = (corner / 3) | 0
      const x = fn[3 * t], y = fn[3 * t + 1], z = fn[3 * t + 2]
      const nx = un[3 * t], ny = un[3 * t + 1], nz = un[3 * t + 2]
      let g = -1
      for (let j = 0; j < groups.length; j++) {
        if (reps[3 * j] * nx + reps[3 * j + 1] * ny + reps[3 * j + 2] * nz > cosCrease) {
          g = j
          break
        }
      }
      if (g < 0) {
        g = groups.length
        reps.push(nx, ny, nz)
        const id = g === 0 ? v : nv + extra.length
        if (g > 0) {
          extra.push(v)
          added.push(0, 0, 0)
        }
        groups.push(id)
      }
      const id = groups[g]
      outIndex[corner] = id
      const acc = id < nv ? base : added
      const o = id < nv ? 3 * id : 3 * (id - nv)
      acc[o] += x
      acc[o + 1] += y
      acc[o + 2] += z
    }
  }

  const total = nv + extra.length
  const outPos = new Float64Array(3 * total)
  outPos.set(positions)
  extra.forEach((v, i) => {
    outPos[3 * (nv + i)] = positions[3 * v]
    outPos[3 * (nv + i) + 1] = positions[3 * v + 1]
    outPos[3 * (nv + i) + 2] = positions[3 * v + 2]
  })
  const normals = new Float32Array(3 * total)
  for (let i = 0; i < total; i++) {
    const acc = i < nv ? base : added
    const o = i < nv ? 3 * i : 3 * (i - nv)
    const x = acc[o], y = acc[o + 1], z = acc[o + 2]
    const l = Math.sqrt(x * x + y * y + z * z) || 1
    normals[3 * i] = x / l
    normals[3 * i + 1] = y / l
    normals[3 * i + 2] = z / l
  }
  // Group split copies with their original vertex.
  const gStart = new Uint32Array(nv + 1)
  for (let v = 0; v < nv; v++) gStart[v + 1] = 1
  for (const v of extra) gStart[v + 1]++
  for (let v = 0; v < nv; v++) gStart[v + 1] += gStart[v]
  const members = new Uint32Array(total)
  const at = gStart.slice(0, nv)
  for (let v = 0; v < nv; v++) members[at[v]++] = v
  extra.forEach((v, i) => (members[at[v]++] = nv + i))
  return { positions: outPos, indices: outIndex, normals, groups: { start: gStart, members } }
}

// Splits triangles 1 → 4 (sharing edge midpoints) until no edge exceeds maxEdge.
function subdivide(p: Float64Array, idx: Uint32Array, maxEdge: number): { positions: Float64Array, indices: Uint32Array } {
  const max2 = maxEdge * maxEdge
  const len2 = (a: number, b: number, pos: ArrayLike<number>) =>
    (pos[3 * a] - pos[3 * b]) ** 2 + (pos[3 * a + 1] - pos[3 * b + 1]) ** 2 + (pos[3 * a + 2] - pos[3 * b + 2]) ** 2
  let any = false
  for (let t = 0; t < idx.length && !any; t += 3) {
    any = len2(idx[t], idx[t + 1], p) > max2 || len2(idx[t + 1], idx[t + 2], p) > max2 || len2(idx[t + 2], idx[t], p) > max2
  }
  if (!any || p.length / 3 > 2 ** 22) return { positions: p, indices: idx }

  // Only a few triangles split, so original data stays in typed arrays and just
  // the new midpoints and split triangles go through plain arrays.
  const n0 = p.length / 3
  const added: number[] = []
  const coord = (v: number, k: number) => (v < n0 ? p[3 * v + k] : added[3 * (v - n0) + k])
  const long = (a: number, b: number) => (coord(a, 0) - coord(b, 0)) ** 2 + (coord(a, 1) - coord(b, 1)) ** 2 + (coord(a, 2) - coord(b, 2)) ** 2 > max2
  const mid = new Map<number, number>()
  const midpoint = (a: number, b: number) => {
    const key = Math.min(a, b) * 2 ** 22 + Math.max(a, b)
    let m = mid.get(key)
    if (m === undefined) {
      m = n0 + added.length / 3
      added.push((coord(a, 0) + coord(b, 0)) / 2, (coord(a, 1) + coord(b, 1)) / 2, (coord(a, 2) + coord(b, 2)) / 2)
      mid.set(key, m)
    }
    return m
  }
  const splitTris: number[] = []
  const split = (a: number, b: number, c: number, depth: number) => {
    if (depth >= 6 || !(long(a, b) || long(b, c) || long(c, a))) {
      splitTris.push(a, b, c)
      return
    }
    const ab = midpoint(a, b)
    const bc = midpoint(b, c)
    const ca = midpoint(c, a)
    split(a, ab, ca, depth + 1)
    split(ab, b, bc, depth + 1)
    split(ca, bc, c, depth + 1)
    split(ab, bc, ca, depth + 1)
  }
  const keep = new Uint32Array(idx.length)
  let kept = 0
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]]
    if (len2(a, b, p) > max2 || len2(b, c, p) > max2 || len2(c, a, p) > max2) split(a, b, c, 0)
    else {
      keep[kept++] = a
      keep[kept++] = b
      keep[kept++] = c
    }
  }
  const indices = new Uint32Array(kept + splitTris.length)
  indices.set(keep.subarray(0, kept))
  indices.set(splitTris, kept)
  const positions = new Float64Array(p.length + added.length)
  positions.set(p)
  positions.set(added, p.length)
  return { positions, indices }
}
