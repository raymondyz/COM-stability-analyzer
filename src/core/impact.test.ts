import { describe, expect, it } from 'vitest'
import { classify } from './equilibria.ts'
import { buildHull } from './hull.ts'
import { bestPivot, cornerModels, edgeModels, hitOnEdge } from './impact.ts'
import { heatRange } from './heatmap.ts'
import { makeRoller } from './roll.ts'
import { boxMesh, prismMesh } from './testShapes.ts'
import { GRAVITY } from './units.ts'
import { sub, type Mat3, type Vec3 } from './vec.ts'

// Notes §6.3: a uniform 300 × 60 mm, 1.36 kg box (100 mm deep), tipping over its far bottom edge.
const m = 1.36
const [lx, ly, lz] = [0.3, 0.1, 0.06]
const com: Vec3 = [0.15, 0.05, 0.03]
const inertia: Mat3 = [
  (m * (ly ** 2 + lz ** 2)) / 12, 0, 0,
  0, (m * (lx ** 2 + lz ** 2)) / 12, 0,
  0, 0, (m * (lx ** 2 + ly ** 2)) / 12,
]

function setup() {
  const hull = buildHull(boxMesh(0, 0, 0, lx, ly, lz).positions)
  const st = classify(hull, com)
  const roller = makeRoller(hull, st)
  const bottom = hull.faces.findIndex((f) => f.normal[2] < -0.99)
  const edges = edgeModels(hull, st, roller, bottom, { mass: m, com, inertia }, inertia)
  const far = edges.findIndex((e) => e.q1[0] > 0.14 && Math.abs(e.k[1]) > 0.99)
  return { hull, bottom, edges, far }
}

const rel = (p: Vec3) => sub(p, com)

describe('worked example (notes §6.3)', () => {
  it('matches I_a, the barrier and both threshold impulses', () => {
    const { edges, far } = setup()
    const e = edges[far]
    expect(e.Ia).toBeCloseTo(0.042432, 6)
    expect(m * GRAVITY * e.path.lift).toBeCloseTo(1.64, 2)
    expect(e.path.kinks).toHaveLength(0)
    const side = hitOnEdge(e, rel([0, 0.05, 0.06]), [1, 0, 0], 4)
    expect(side.lever).toBeCloseTo(0.06, 6)
    expect(side.value).toBeCloseTo(6.218, 2)
    const up = hitOnEdge(e, rel([0, 0.05, 0]), [0, 0, 1], 1)
    expect(up.lever).toBeCloseTo(0.3, 6)
    expect(up.value).toBeCloseTo(1.2436, 3)
  })

  it('needs μ ≈ 3.3 for the side hit and μ ≈ 0.65 for the upward one', () => {
    const { edges, far } = setup()
    const e = edges[far]
    expect(hitOnEdge(e, rel([0, 0.05, 0.06]), [1, 0, 0], 3.2).outcome).toBe('slide')
    expect(hitOnEdge(e, rel([0, 0.05, 0.06]), [1, 0, 0], 3.35).outcome).toBe('ok')
    expect(hitOnEdge(e, rel([0, 0.05, 0]), [0, 0, 1], 0.6).outcome).toBe('slide')
    expect(hitOnEdge(e, rel([0, 0.05, 0]), [0, 0, 1], 0.7).outcome).toBe('ok')
  })

  it('an upward hit at a back corner lifts one end of the far edge', () => {
    const { edges, far } = setup()
    expect(hitOnEdge(edges[far], rel([0, 0, 0]), [0, 0, 1], 1).outcome).toBe('lift')
  })

  it('reports the landing pose and picks the cheapest valid edge', () => {
    const { hull, bottom, edges } = setup()
    const res = bestPivot({ edges, corners: [] }, bottom, rel([0, 0.05, 0]), [0, 0, 1], 1, 'impulse', m)
    expect(res.best).not.toBeNull()
    const landed = hull.faces[res.best!.landing].normal
    expect(landed[0]).toBeCloseTo(1, 6)
  })
})

describe('corner pivots', () => {
  it('pick up the off-centre hit that lifts one end of an edge', () => {
    const { hull, bottom, edges } = setup()
    const st = classify(hull, com)
    const corners = cornerModels(hull, st, makeRoller(hull, st), bottom, { mass: m, com, inertia }, inertia)
    expect(corners).toHaveLength(4)
    const res = bestPivot({ edges, corners }, bottom, rel([0, 0, 0]), [0, 0, 1], 1, 'impulse', m)
    expect(res.best?.kind).toBe('corner')
    // Pivoting on a corner is cheaper than the centred edge tip, but of the same order.
    expect(res.best!.value).toBeGreaterThan(0.3)
    expect(res.best!.value).toBeLessThan(1.3)
  })

  it('the heatmap kernel agrees with the per-point evaluation', () => {
    const { hull, bottom, edges } = setup()
    const st = classify(hull, com)
    const corners = cornerModels(hull, st, makeRoller(hull, st), bottom, { mass: m, com, inertia }, inertia)
    const pv = { edges, corners }
    let seed = 5
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let i = 0; i < 200; i++) {
      const p: Vec3 = [lx * rnd(), ly * rnd(), lz * rnd()]
      const el = rnd() * 1.2 - 0.3
      const az = rnd() * 2 * Math.PI
      const d: Vec3 = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)]
      for (const mode of ['impulse', 'push'] as const) {
        const out = new Float32Array(1)
        const spec = { mode, mu: 0.6, mass: m, dirs: { kind: 'fixed' as const, d } }
        heatRange(pv, bottom, spec, Float64Array.from(p), com, Float32Array.from([-d[0], -d[1], -d[2]]), out, 0, 1)
        const res = bestPivot(pv, bottom, rel(p), d, 0.6, mode, m)
        const expected = res.best ? res.best.value : Infinity
        if (Number.isFinite(expected)) expect(out[0] / expected).toBeCloseTo(1, 4)
        else expect(out[0]).toBe(Infinity)
      }
    }
  })
})

describe('tip path over a rounded corner', () => {
  // 300 × 60 block whose far bottom corner is rounded (r = 20) with n facets.
  const rounded = (n: number) => {
    const outline: [number, number][] = [[0, 0], [0.28, 0]]
    for (let i = 1; i < n; i++) {
      const t = -Math.PI / 2 + ((Math.PI / 2) * i) / n
      outline.push([0.28 + 0.02 * Math.cos(t), 0.02 + 0.02 * Math.sin(t)])
    }
    outline.push([0.3, 0.02], [0.3, 0.06], [0, 0.06])
    return prismMesh(outline, 0, 0.1)
  }
  const spin = (n: number) => {
    const hull = buildHull(rounded(n).positions)
    const st = classify(hull, com)
    const roller = makeRoller(hull, st)
    const bottom = hull.faces.findIndex((f) => f.normal[2] < -0.99)
    const edges = edgeModels(hull, st, roller, bottom, { mass: m, com, inertia }, inertia)
    return edges.find((e) => e.q1[0] > 0.1 && Math.abs(e.k[1]) > 0.99)!
  }

  it('crosses the facets and loses less energy as they get finer', () => {
    const coarse = spin(4)
    const fine = spin(32)
    expect(coarse.path.kinks.length).toBeGreaterThan(0)
    expect(fine.path.kinks.length).toBeGreaterThan(coarse.path.kinks.length)
    expect(fine.path.lift).toBeCloseTo(coarse.path.lift, 3)
    const lossless = (e: typeof fine) => Math.sqrt((2 * m * GRAVITY * e.path.lift) / e.Ia)
    expect(coarse.omega).toBeGreaterThan(fine.omega)
    expect(fine.omega).toBeGreaterThanOrEqual(lossless(fine) * (1 - 1e-9))
    expect(fine.omega / lossless(fine)).toBeLessThan(1.05)
  })
})
