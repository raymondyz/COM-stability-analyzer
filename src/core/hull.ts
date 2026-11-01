import quickhull from 'quickhull3d/dist/quickhull3d.js'
import { cross, dot, get, length, sub, type Vec3 } from './vec.ts'

export interface HullFace {
  verts: number[]     // hull vertex ids, counter-clockwise seen from outside
  edges: number[]     // edges[j] joins verts[j] and verts[j + 1]
  normal: Vec3        // outward unit normal
}

export interface HullEdge {
  a: number
  b: number
  left: number        // face in which a → b runs counter-clockwise
  right: number       // face in which b → a runs counter-clockwise
}

export interface Hull {
  verts: Float64Array      // body frame, m
  count: number
  faces: HullFace[]
  edges: HullEdge[]
  neighbors: Int32Array[]  // adjacent vertices
  vertexEdges: Int32Array[]
  seeds: Int32Array        // support vertex for each cube-map cell
  size: number             // bounding-box diagonal, m
}

const SEED_GRID = 8

// Convex hull with true polygon faces. quickhull leaves flat faces split into
// facets wherever float noise exceeds its own tolerance, so neighbouring facets
// whose vertices all lie within `flatness` × model size of a common plane are
// merged, and vertices left on a straight edge are dropped.
export function buildHull(positions: Float64Array, flatness = 1e-6): Hull {
  const n = positions.length / 3
  const pts: Float64Array[] = new Array(n)
  for (let i = 0; i < n; i++) pts[i] = positions.subarray(3 * i, 3 * i + 3)
  let raw: number[][]
  try {
    raw = quickhull(pts, { skipTriangulation: true })
  } catch {
    raw = []
  }
  if (raw.length < 4) throw new Error('Could not build a convex hull. Is the model flat or empty?')

  const used = new Set<number>()
  for (const f of raw) for (const v of f) used.add(v)
  const centre: Vec3 = [0, 0, 0]
  let lo: Vec3 = [Infinity, Infinity, Infinity]
  let hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const v of used) {
    const p = get(positions, v)
    for (let k = 0; k < 3; k++) centre[k] += p[k] / used.size
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])]
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])]
  }
  const size = length(sub(hi, lo))

  // Orient every face outward.
  for (const f of raw) if (dot(newell(positions, f), sub(faceCentre(positions, f), centre)) < 0) f.reverse()

  // Merge as much as stays valid. A merge can strand a vertex between just two
  // faces off their shared line (the faces met at a tiny angle); the facets around
  // such vertices are then kept as they were and the merge is redone.
  const frozen = new Set<number>()
  let loops: number[][] = raw
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = mergeFaces(raw, positions, flatness * size, frozen)
    if (res === null) break
    if (Array.isArray(res)) {
      loops = res
      break
    }
    for (const f of res.refreeze) frozen.add(f)
  }

  // Compact vertex ids.
  const id = new Map<number, number>()
  for (const l of loops) for (const v of l) if (!id.has(v)) id.set(v, id.size)
  const count = id.size
  const verts = new Float64Array(3 * count)
  for (const [v, i] of id) for (let k = 0; k < 3; k++) verts[3 * i + k] = positions[3 * v + k]

  const faces: HullFace[] = loops.map((l) => {
    const vs = l.map((v) => id.get(v)!)
    return { verts: vs, edges: [], normal: newell(verts, vs) }
  })
  const edges: HullEdge[] = []
  const edgeId = new Map<number, number>()
  faces.forEach((f, fi) => {
    f.verts.forEach((a, j) => {
      const b = f.verts[(j + 1) % f.verts.length]
      const key = Math.min(a, b) * count + Math.max(a, b)
      let e = edgeId.get(key)
      if (e === undefined) {
        e = edges.length
        edgeId.set(key, e)
        edges.push({ a, b, left: fi, right: -1 })
      } else {
        edges[e].right = fi
      }
      f.edges.push(e)
    })
  })
  if (edges.some((e) => e.right < 0) || count - edges.length + faces.length !== 2) {
    throw new Error('The convex hull came out malformed. Try re-exporting the model.')
  }

  const nb: number[][] = Array.from({ length: count }, () => [])
  const ve: number[][] = Array.from({ length: count }, () => [])
  edges.forEach((e, ei) => {
    nb[e.a].push(e.b)
    nb[e.b].push(e.a)
    ve[e.a].push(ei)
    ve[e.b].push(ei)
  })

  const hull: Hull = {
    verts,
    count,
    faces,
    edges,
    neighbors: nb.map((l) => Int32Array.from(l)),
    vertexEdges: ve.map((l) => Int32Array.from(l)),
    seeds: new Int32Array(6 * SEED_GRID * SEED_GRID),
    size,
  }
  for (let c = 0; c < hull.seeds.length; c++) hull.seeds[c] = bruteSupport(hull, cellDirection(c))
  return hull
}

// Merges neighbouring faces whose vertices all lie within `delta` of the group's
// plane, then drops vertices that end up on a straight edge between two faces.
// Returns the merged loops; or raw faces to keep unmerged on the next try; or
// null if the result isn't a valid closed polyhedron.
function mergeFaces(raw: number[][], p: Float64Array, delta: number, frozen: Set<number>): number[][] | { refreeze: number[] } | null {
  const n = p.length / 3
  const owner = new Map<number, number>()
  raw.forEach((f, fi) => f.forEach((a, j) => owner.set(a * n + f[(j + 1) % f.length], fi)))

  // Each group keeps the plane of its largest face and the set of its vertices.
  const area = raw.map((f) => polygonArea(p, f))
  const plane = raw.map((f) => {
    const nrm = newell(p, f)
    return { n: nrm, d: dot(nrm, get(p, f[0])) }
  })
  const verts = raw.map((f) => new Set(f))
  const parent = raw.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const flat = (g: number, vs: Set<number>) => {
    for (const v of vs) if (Math.abs(dot(plane[g].n, get(p, v)) - plane[g].d) > delta) return false
    return true
  }
  const order = raw.map((_, i) => i).sort((x, y) => area[y] - area[x])
  for (const fi of order) {
    if (frozen.has(fi)) continue
    raw[fi].forEach((a, j) => {
      const gi = owner.get(raw[fi][(j + 1) % raw[fi].length] * n + a)
      if (gi === undefined || frozen.has(gi)) return
      const ra = find(fi)
      const rb = find(gi)
      if (ra === rb || !flat(ra, verts[rb]) || !flat(rb, verts[ra])) return
      const [big, small] = area[ra] >= area[rb] ? [ra, rb] : [rb, ra]
      parent[small] = big
      for (const v of verts[small]) verts[big].add(v)
      area[big] += area[small]
    })
  }

  const groups = new Map<number, number[]>()
  raw.forEach((_, fi) => {
    const r = find(fi)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r)!.push(fi)
  })
  const loops: number[][] = []
  for (const [root, members] of groups) {
    if (members.length === 1) {
      loops.push([...raw[members[0]]])
      continue
    }
    // The merged polygon's boundary is every directed edge whose twin lies outside the group.
    const next = new Map<number, number>()
    for (const fi of members) {
      const f = raw[fi]
      for (let j = 0; j < f.length; j++) {
        const a = f[j]
        const b = f[(j + 1) % f.length]
        const gi = owner.get(b * n + a)
        if (gi !== undefined && find(gi) === root) continue
        if (next.has(a)) return null
        next.set(a, b)
      }
    }
    const start = next.keys().next().value!
    const loop = [start]
    for (let v = next.get(start)!; v !== start && loop.length <= next.size; v = next.get(v)!) loop.push(v)
    if (loop.length !== next.size) return null
    loops.push(loop)
  }

  // A vertex in only two faces should sit on the straight edge between them.
  const faceCount = new Map<number, number>()
  for (const l of loops) for (const v of l) faceCount.set(v, (faceCount.get(v) ?? 0) + 1)
  const drop = new Set<number>()
  const stranded = new Set<number>()
  for (const l of loops) {
    l.forEach((v, j) => {
      if (faceCount.get(v) !== 2) return
      const a = get(p, l[(j + l.length - 1) % l.length])
      const ab = sub(get(p, l[(j + 1) % l.length]), a)
      const off = length(cross(ab, sub(get(p, v), a))) / length(ab)
      if (off <= delta) drop.add(v)
      else stranded.add(v)
    })
  }
  if (stranded.size > 0) {
    const refreeze = raw.map((_, i) => i).filter((fi) => !frozen.has(fi) && raw[fi].some((v) => stranded.has(v)))
    return refreeze.length > 0 ? { refreeze } : null
  }
  const out = loops.map((l) => l.filter((v) => !drop.has(v)))

  // Validate: closed, consistently oriented, Euler characteristic 2.
  const directed = new Set<number>()
  const vs = new Set<number>()
  for (const l of out) {
    if (l.length < 3 || new Set(l).size !== l.length) return null
    for (let j = 0; j < l.length; j++) {
      const key = l[j] * n + l[(j + 1) % l.length]
      if (directed.has(key)) return null
      directed.add(key)
      vs.add(l[j])
    }
  }
  for (const key of directed) if (!directed.has((key % n) * n + Math.floor(key / n))) return null
  return vs.size - directed.size / 2 + out.length === 2 ? out : null
}

// Hull vertex farthest along u, by hill climbing from a cube-map seed.
export function support(hull: Hull, u: Vec3): number {
  const V = hull.verts
  let k = hull.seeds[cellOf(u)]
  let best = u[0] * V[3 * k] + u[1] * V[3 * k + 1] + u[2] * V[3 * k + 2]
  for (let moved = true; moved;) {
    moved = false
    for (const j of hull.neighbors[k]) {
      const v = u[0] * V[3 * j] + u[1] * V[3 * j + 1] + u[2] * V[3 * j + 2]
      if (v > best) {
        best = v
        k = j
        moved = true
      }
    }
  }
  return k
}

export function edgeBetween(hull: Hull, a: number, b: number): number {
  for (const e of hull.vertexEdges[a]) {
    const edge = hull.edges[e]
    if (edge.a === b || edge.b === b) return e
  }
  return -1
}

function bruteSupport(hull: Hull, u: Vec3): number {
  let best = -Infinity
  let k = 0
  for (let i = 0; i < hull.count; i++) {
    const v = dot(u, get(hull.verts, i))
    if (v > best) {
      best = v
      k = i
    }
  }
  return k
}

function cellOf(u: Vec3): number {
  const ax = Math.abs(u[0])
  const ay = Math.abs(u[1])
  const az = Math.abs(u[2])
  let face: number, s: number, t: number, m: number
  if (ax >= ay && ax >= az) [face, s, t, m] = [u[0] > 0 ? 0 : 1, u[1], u[2], ax]
  else if (ay >= az) [face, s, t, m] = [u[1] > 0 ? 2 : 3, u[0], u[2], ay]
  else [face, s, t, m] = [u[2] > 0 ? 4 : 5, u[0], u[1], az]
  const i = Math.min(SEED_GRID - 1, Math.floor(((s / m + 1) / 2) * SEED_GRID))
  const j = Math.min(SEED_GRID - 1, Math.floor(((t / m + 1) / 2) * SEED_GRID))
  return (face * SEED_GRID + i) * SEED_GRID + j
}

function cellDirection(c: number): Vec3 {
  const j = c % SEED_GRID
  const i = Math.floor(c / SEED_GRID) % SEED_GRID
  const face = Math.floor(c / (SEED_GRID * SEED_GRID))
  const s = (2 * (i + 0.5)) / SEED_GRID - 1
  const t = (2 * (j + 0.5)) / SEED_GRID - 1
  const dirs: Vec3[] = [[1, s, t], [-1, s, t], [s, 1, t], [s, -1, t], [s, t, 1], [s, t, -1]]
  return dirs[face]
}

// Newell's method: robust normal of a (possibly slightly non-planar) polygon.
function newell(p: ArrayLike<number>, loop: number[]): Vec3 {
  let x = 0
  let y = 0
  let z = 0
  for (let j = 0; j < loop.length; j++) {
    const a = get(p, loop[j])
    const b = get(p, loop[(j + 1) % loop.length])
    x += (a[1] - b[1]) * (a[2] + b[2])
    y += (a[2] - b[2]) * (a[0] + b[0])
    z += (a[0] - b[0]) * (a[1] + b[1])
  }
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
}

function polygonArea(p: ArrayLike<number>, loop: number[]): number {
  const a = get(p, loop[0])
  let s: Vec3 = [0, 0, 0]
  for (let j = 1; j + 1 < loop.length; j++) {
    const c = cross(sub(get(p, loop[j]), a), sub(get(p, loop[j + 1]), a))
    s = [s[0] + c[0], s[1] + c[1], s[2] + c[2]]
  }
  return length(s) / 2
}

function faceCentre(p: ArrayLike<number>, loop: number[]): Vec3 {
  const c: Vec3 = [0, 0, 0]
  for (const v of loop) for (let k = 0; k < 3; k++) c[k] += p[3 * v + k] / loop.length
  return c
}
