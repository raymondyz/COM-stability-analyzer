// A saddle joining two stable poses (indices into the raw pose list).
export interface Link {
  height: number
  a: number
  b: number
}

export interface Simplified {
  survivor: Int32Array      // raw pose → the raw pose it folded into (itself if it survives)
  poses: number[]           // surviving raw poses
  escape: ({ lift: number, to: number } | null)[]   // per surviving pose; `to` indexes `poses`
  lift: Float64Array        // lift[i·P + j]: COM rise to get from pose i to pose j
}

// Folds every pose that can be escaped with less than `threshold` of COM lift into
// the pose its cheapest exit leads to (0-dimensional persistence, elder rule), then
// computes escape barriers and pairwise barriers between the survivors.
export function simplify(heights: number[], links: Link[], threshold: number): Simplified {
  const n = heights.length
  const sorted = links.filter((l) => l.a !== l.b).sort((x, y) => x.height - y.height)

  const survivor = Int32Array.from({ length: n }, (_, i) => i)
  const surv = (i: number): number => {
    while (survivor[i] !== i) i = survivor[i]
    return i
  }
  const parent = Int32Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const lowest = Int32Array.from({ length: n }, (_, i) => i)
  const deeper = (x: number, y: number) => heights[x] < heights[y] || (heights[x] === heights[y] && x < y)

  for (const l of sorted) {
    const ra = find(l.a)
    const rb = find(l.b)
    if (ra === rb) continue
    const [elder, younger] = deeper(lowest[ra], lowest[rb]) ? [ra, rb] : [rb, ra]
    const y = lowest[younger]
    if (l.height - heights[y] < threshold) {
      const elderSide = find(l.a) === elder ? l.a : l.b
      survivor[y] = surv(elderSide)
    }
    parent[younger] = elder
  }

  const poses: number[] = []
  const index = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    if (surv(i) === i) {
      index[i] = poses.length
      poses.push(i)
    }
  }
  const P = poses.length
  const mapped = sorted
    .map((l) => ({ height: l.height, a: index[surv(l.a)], b: index[surv(l.b)] }))
    .filter((l) => l.a !== l.b)

  const escape: Simplified['escape'] = poses.map(() => null)
  for (const l of mapped) {
    for (const [p, q] of [[l.a, l.b], [l.b, l.a]]) {
      const lift = l.height - heights[poses[p]]
      if (!escape[p] || lift < escape[p]!.lift) escape[p] = { lift, to: q }
    }
  }

  // Pairwise barriers: Kruskal over the survivors; two poses join at the lowest pass.
  const lift = new Float64Array(P * P).fill(Infinity)
  const members = poses.map((_, i) => [i])
  const comp = Int32Array.from({ length: P }, (_, i) => i)
  for (const l of mapped) {
    const ca = comp[l.a]
    const cb = comp[l.b]
    if (ca === cb) continue
    for (const i of members[ca]) {
      for (const j of members[cb]) {
        lift[i * P + j] = l.height - heights[poses[i]]
        lift[j * P + i] = l.height - heights[poses[j]]
      }
    }
    for (const j of members[cb]) {
      comp[j] = ca
      members[ca].push(j)
    }
    members[cb] = []
  }
  for (let i = 0; i < P; i++) lift[i * P + i] = 0
  return { survivor, poses, escape, lift }
}
