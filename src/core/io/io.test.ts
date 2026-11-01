import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classify } from '../equilibria.ts'
import { buildHull } from '../hull.ts'
import { symEigenvalues, type Mat3 } from '../vec.ts'
import { weld } from '../weld.ts'
import { parseMassInput } from './massReport.ts'
import { parseObj } from './obj.ts'
import { parseStl } from './stl.ts'

const f = (x: number) => x.toFixed(4)

// Builds report text in SolidWorks' layout from a mass (g), COM (mm) and products
// of inertia in positive notation (g·mm²).
function report(mass: number, c: number[], L: { xx: number, yy: number, zz: number, xy: number, xz: number, yz: number }, flipXY = false) {
  const tensor: Mat3 = [L.xx, -L.xy, -L.xz, -L.xy, L.yy, -L.yz, -L.xz, -L.yz, L.zz]
  const p = symEigenvalues(tensor)
  const o = {
    xy: L.xy + mass * c[0] * c[1], xz: L.xz + mass * c[0] * c[2], yz: L.yz + mass * c[1] * c[2],
  }
  const xy = flipXY ? -L.xy : L.xy
  return `Mass properties of Test
     Configuration: Default
     Coordinate system: -- default --

Mass = ${f(mass)} grams

Center of mass: ( millimeters )
\tX = ${f(c[0])}
\tY = ${f(c[1])}
\tZ = ${f(c[2])}

Principal axes of inertia and principal moments of inertia: ( grams *  square millimeters )
Taken at the center of mass.
\t Ix = ( 1.0000,  0.0000, 0.0000)   \tPx = ${f(p[0])}
\t Iy = ( 0.0000,  1.0000, 0.0000)   \tPy = ${f(p[1])}
\t Iz = ( 0.0000,  0.0000, 1.0000)   \tPz = ${f(p[2])}

Moments of inertia: ( grams *  square millimeters )
Taken at the center of mass and aligned with the output coordinate system. (Using positive tensor notation.)
\tLxx = ${f(L.xx)}\tLxy = ${f(xy)}\tLxz = ${f(L.xz)}
\tLyx = ${f(xy)}\tLyy = ${f(L.yy)}\tLyz = ${f(L.yz)}
\tLzx = ${f(L.xz)}\tLzy = ${f(L.yz)}\tLzz = ${f(L.zz)}

Moments of inertia: ( grams *  square millimeters )
Taken at the output coordinate system. (Using positive tensor notation.)
\tIxx = 0\tIxy = ${f(o.xy)}\tIxz = ${f(o.xz)}
\tIyx = ${f(o.xy)}\tIyy = 0\tIyz = ${f(o.yz)}
\tIzx = ${f(o.xz)}\tIzy = ${f(o.yz)}\tIzz = 0
`
}

const L = { xx: 2e6, yy: 10e6, zz: 11e6, xy: 1e5, xz: -5e4, yz: 2e5 }

describe('SolidWorks mass properties report', () => {
  it('reads mass, COM and inertia in SI, negating products', () => {
    const r = parseMassInput(report(1360, [150, 50, 30], L))
    expect(r.props.mass).toBeCloseTo(1.36, 9)
    expect(r.props.com).toEqual([0.15, 0.05, 0.03].map((v) => expect.closeTo(v, 12)))
    const I = r.props.inertia!
    expect(I[0]).toBeCloseTo(2e6 * 1e-9, 12)
    expect(I[1]).toBeCloseTo(-1e5 * 1e-9, 12)
    expect(I[5]).toBeCloseTo(-2e5 * 1e-9, 12)
    expect(r.checks).toHaveLength(2)
  })

  it('rejects a paste whose products have the wrong sign', () => {
    expect(() => parseMassInput(report(1360, [150, 50, 30], L, true))).toThrow()
  })

  it('reads the JSON sidecar format', () => {
    const r = parseMassInput(JSON.stringify({ units: { length: 'mm', mass: 'g' }, mass: 1360, com: [150, 50, 30] }))
    expect(r.props.mass).toBeCloseTo(1.36, 12)
    expect(r.props.com[0]).toBeCloseTo(0.15, 12)
    expect(r.props.inertia).toBeNull()
  })
})

describe('mesh files', () => {
  const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0]

  it('parses binary STL', () => {
    const buf = new ArrayBuffer(84 + 50)
    const dv = new DataView(buf)
    dv.setUint32(80, 1, true)
    tri.forEach((v, k) => dv.setFloat32(84 + 12 + 4 * k, v, true))
    expect(Array.from(parseStl(buf))).toEqual(tri)
  })

  it('parses ASCII STL', () => {
    const text = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n'
    expect(Array.from(parseStl(new TextEncoder().encode(text).buffer as ArrayBuffer))).toEqual(tri)
  })

  it('parses OBJ quads into triangles', () => {
    const soup = parseObj('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n')
    expect(soup.length).toBe(18)
    expect(weld(soup, 1).positions.length).toBe(12)
  })
})

// Regression on the real test model. The files are gitignored, so this only runs locally.
const stl = new URL('../../../docs/test_1.STL', import.meta.url)
const txt = new URL('../../../docs/test_1.txt', import.meta.url)
describe.skipIf(!existsSync(stl) || !existsSync(txt))('test_1 (local files)', () => {
  it('has 7 stable faces, 13 saddles and 8 maxima at the reported COM', () => {
    const buf = readFileSync(stl)
    const mesh = weld(parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer), 1e-3)
    const mass = parseMassInput(readFileSync(txt, 'utf8'))
    const st = classify(buildHull(mesh.positions), mass.props.com)
    expect([st.stable.reduce((a, b) => a + b, 0), st.saddles.length, st.maxima.length]).toEqual([7, 13, 8])
    expect(st.depth).toBeGreaterThan(0.05)
  })
})
