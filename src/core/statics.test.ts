import { describe, expect, it } from 'vitest'
import { simplify } from './barriers.ts'
import { classify } from './equilibria.ts'
import { buildHull } from './hull.ts'
import { makeRoller, rollFrom, resolve, type Segment } from './roll.ts'
import { icosphere, vertexCount } from './sphere.ts'
import { boxMesh, prismMesh, tetraMesh } from './testShapes.ts'
import { dot, get, length, sub, type Vec3 } from './vec.ts'

const counts = (st: ReturnType<typeof classify>) => [st.stable.reduce((a, b) => a + b, 0), st.saddles.length, st.maxima.length]

function probabilities(mesh: ReturnType<typeof boxMesh>, com: Vec3, level = 5) {
  const hull = buildHull(mesh.positions)
  const st = classify(hull, com)
  const roller = makeRoller(hull, st)
  const sphere = icosphere(level)
  const prob = new Map<number, number>()
  for (let i = 0; i < sphere.weights.length; i++) {
    const f = rollFrom(roller, get(sphere.verts, i))
    prob.set(f, (prob.get(f) ?? 0) + sphere.weights[i])
  }
  return { hull, st, roller, prob }
}

describe('hull', () => {
  it('merges triangulated faces into polygons and drops edge midpoints', () => {
    const hull = buildHull(boxMesh(0, 0, 0, 2, 1, 0.5, true).positions)
    expect(hull.count).toBe(8)
    expect(hull.faces).toHaveLength(6)
    expect(hull.edges).toHaveLength(12)
    for (const f of hull.faces) expect(f.verts).toHaveLength(4)
  })
})

describe('equilibria', () => {
  it('cube with a centred COM: 6 stable, 12 saddles, 8 maxima', () => {
    const st = classify(buildHull(boxMesh(-1, -1, -1, 1, 1, 1).positions), [0, 0, 0])
    expect(counts(st)).toEqual([6, 12, 8])
  })

  it('regular tetrahedron: 4 stable, 6 saddles, 4 maxima', () => {
    const st = classify(buildHull(tetraMesh().positions), [0, 0, 0])
    expect(counts(st)).toEqual([4, 6, 4])
  })

  it('Poincaré–Hopf holds for random interior COMs', () => {
    const hull = buildHull(boxMesh(0, 0, 0, 3, 2, 1).positions)
    let seed = 1
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let i = 0; i < 50; i++) {
      const st = classify(hull, [0.1 + 2.8 * rnd(), 0.1 + 1.8 * rnd(), 0.1 + 0.8 * rnd()])
      const [s, d, m] = counts(st)
      expect(s - d + m).toBe(2)
    }
  })

  it('a face stops being stable once the COM passes its edge', () => {
    // Prism with an obtuse corner at (4, 0): the base only holds while the COM is over it.
    const hull = buildHull(prismMesh([[0, 0], [4, 0], [5, 1]], 0, 1).positions)
    const base = hull.faces.findIndex((f) => f.normal[2] < -0.99)
    expect(classify(hull, [3, 0.5, 1 / 3]).stable[base]).toBe(1)
    expect(classify(hull, [4.2, 0.5, 0.3]).stable[base]).toBe(0)
  })
})

describe('rolling and basins', () => {
  it('icosphere weights sum to 1 and levels nest', () => {
    const a = icosphere(3)
    const b = icosphere(4)
    expect(a.weights.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 12)
    expect(b.verts.length / 3).toBe(vertexCount(4))
    expect(Array.from(b.verts.subarray(0, a.verts.length))).toEqual(Array.from(a.verts))
  })

  it('a cube with a centred COM lands on each face 1/6 of the time', () => {
    const { prob } = probabilities(boxMesh(-1, -1, -1, 1, 1, 1), [0, 0, 0])
    expect(prob.size).toBe(6)
    for (const p of prob.values()) expect(p).toBeCloseTo(1 / 6, 2)
  })

  it('every recorded roll lowers the COM', () => {
    const hull = buildHull(boxMesh(0, 0, 0, 3, 2, 1).positions)
    const st = classify(hull, [1.2, 0.9, 0.3])
    const roller = makeRoller(hull, st)
    const sphere = icosphere(3)
    for (let i = 0; i < sphere.weights.length; i++) {
      const path: Segment[] = []
      const f = rollFrom(roller, get(sphere.verts, i), path)
      expect(f).toBeGreaterThanOrEqual(0)
      expect(st.stable[f]).toBe(1)
      for (const s of path) {
        const h = (u: Vec3) => Math.max(...Array.from({ length: hull.count }, (_, k) => dot(get(st.V, k), u)))
        expect(h(s.to)).toBeLessThanOrEqual(h(s.from) + 1e-12)
        expect(length(sub(s.to, s.from))).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('a box resting on its long face mostly lands there', () => {
    const { hull, prob } = probabilities(boxMesh(0, 0, 0, 3, 2, 1), [1.5, 1, 0.5])
    const big = hull.faces.filter((f) => Math.abs(f.normal[2]) > 0.99).map((f) => hull.faces.indexOf(f))
    const pBig = big.reduce((s, f) => s + (prob.get(f) ?? 0), 0)
    expect(pBig).toBeGreaterThan(0.5)
    expect([...prob.values()].reduce((s, p) => s + p, 0)).toBeCloseTo(1, 9)
  })
})

describe('barriers', () => {
  it('box escape barrier is the lift over its nearest edge', () => {
    const hull = buildHull(boxMesh(0, 0, 0, 3, 2, 1).positions)
    const com: Vec3 = [1.5, 1, 0.5]
    const st = classify(hull, com)
    const roller = makeRoller(hull, st)
    const stableFaces = hull.faces.map((_, i) => i).filter((f) => st.stable[f])
    const index = new Map(stableFaces.map((f, i) => [f, i]))
    const links = st.saddles.map((s) => ({
      height: s.height,
      a: index.get(resolve(roller, hull.edges[s.edge].left))!,
      b: index.get(resolve(roller, hull.edges[s.edge].right))!,
    }))
    const res = simplify(stableFaces.map((f) => st.faceHeight[f]), links, 0)
    const bottom = stableFaces.findIndex((f) => hull.faces[f].normal[2] < -0.99)
    const pose = res.poses.indexOf(bottom)
    // Resting on the 3 × 2 face (h = 0.5), the cheapest way out is over a long edge (1 from the COM).
    expect(res.escape[pose]!.lift).toBeCloseTo(Math.hypot(0.5, 1) - 0.5, 9)
  })

  it('shallow wells fold into their cheapest exit', () => {
    // Pose 0 is deepest; pose 1 sits 20 mm above its exit to 0; pose 2 sits 0.2 mm below its exit to 1.
    const res = simplify([0, 0.01, 0.0118], [
      { height: 0.012, a: 1, b: 2 },
      { height: 0.03, a: 0, b: 1 },
    ], 0.0005)
    expect(res.poses).toEqual([0, 1])
    expect(res.survivor[2]).toBe(1)
    expect(res.escape[1]!.lift).toBeCloseTo(0.02, 12)
    expect(res.lift[1]).toBeCloseTo(0.03, 12)   // row 0, column 1
  })
})
