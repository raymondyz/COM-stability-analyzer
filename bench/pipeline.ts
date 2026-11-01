// Times every stage of the analysis pipeline in Node, outside the browser.
// Usage: node bench/pipeline.ts [model.stl report.txt]   (no arguments: the sample bot)
import { readFileSync } from 'node:fs'
import { simplify } from '../src/core/barriers.ts'
import { classify } from '../src/core/equilibria.ts'
import { heatRange } from '../src/core/heatmap.ts'
import { buildHull } from '../src/core/hull.ts'
import { cornerModels, edgeModels } from '../src/core/impact.ts'
import { hullMoments, inertiaFromMoments, meshMoments } from '../src/core/inertia.ts'
import { parseMassInput } from '../src/core/io/massReport.ts'
import { parseStl } from '../src/core/io/stl.ts'
import { makeRoller, resolve, rollFrom } from '../src/core/roll.ts'
import { sampleBot } from '../src/core/sample.ts'
import { icosphere } from '../src/core/sphere.ts'
import type { MassProps } from '../src/core/types.ts'
import { get, scale } from '../src/core/vec.ts'
import { displayMesh } from '../src/core/displayMesh.ts'
import { weld } from '../src/core/weld.ts'

const rows: [string, number, string][] = []
function time<T>(label: string, f: () => T, note: (r: T) => string = () => ''): T {
  const t = performance.now()
  const r = f()
  rows.push([label, performance.now() - t, note(r)])
  return r
}

const [stlPath, massPath] = process.argv.slice(2)
let soup: Float32Array
let mass: MassProps
if (stlPath) {
  const buf = readFileSync(stlPath)
  soup = time('Parse STL', () => parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer), (s) => `${(s.length / 9).toLocaleString()} triangles`)
  mass = parseMassInput(readFileSync(massPath, 'utf8')).props
} else {
  const s = sampleBot()
  soup = s.soup
  mass = s.mass
}
const mesh = time('Weld vertices', () => weld(soup, stlPath ? 1e-3 : 1e-3), (m) => `${(m.positions.length / 3).toLocaleString()} vertices`)
const hull = time('Convex hull', () => buildHull(mesh.positions), (h) => `${h.count} hull vertices, ${h.faces.length} faces`)
const mo = time('Mesh moments', () => meshMoments(mesh.positions, mesh.indices))
const disp = time('Display mesh', () => displayMesh(mesh, hull.size / 40, mo.volume < 0), (d) => `${(d.positions.length / 3).toLocaleString()} display vertices`)

const st = time('Classify equilibria', () => classify(hull, mass.com), (s) => `${s.stable.reduce((a, b) => a + b, 0)} stable, ${s.saddles.length} saddles, ${s.maxima.length} peaks`)
const roller = time('Destination table', () => makeRoller(hull, st))
const stable = hull.faces.map((_, i) => i).filter((f) => st.stable[f])
const index = new Map(stable.map((f, i) => [f, i]))
const simp = time('Barriers and simplification', () => simplify(
  stable.map((f) => st.faceHeight[f]),
  st.saddles.flatMap((s) => {
    const a = index.get(resolve(roller, hull.edges[s.edge].left))
    const b = index.get(resolve(roller, hull.edges[s.edge].right))
    return a === undefined || b === undefined ? [] : [{ height: s.height, a, b }]
  }),
  0.0005,
), (s) => `${s.poses.length} poses after folding`)
for (const level of [4, 6, 7]) {
  const sphere = icosphere(level)
  time(`Basins, level ${level}`, () => {
    for (let i = 0; i < sphere.weights.length; i++) rollFrom(roller, get(sphere.verts, i))
  }, () => `${sphere.weights.length.toLocaleString()} samples`)
}

const inertia = mass.inertia ?? inertiaFromMoments(mo.volume > 0 ? mo : hullMoments(hull), mass.com, mass.mass)
const face = stable[simp.poses[0]]
const pv = time('Pivot models (one pose)', () => ({
  edges: edgeModels(hull, st, roller, face, mass, inertia),
  corners: cornerModels(hull, st, roller, face, mass, inertia),
}), (p) => `${p.edges.length} edges, ${p.corners.length} corners`)
const n = disp.positions.length / 3
const out = new Float32Array(n)
const up = scale(hull.faces[face].normal, -1)
time('Heatmap, one direction', () => heatRange(pv, face, { mode: 'impulse', mu: 0.5, mass: mass.mass, dirs: { kind: 'fixed', d: [1, 0, 0] } }, disp.positions, mass.com, disp.normals, out, 0, disp.groups.start.length - 1, disp.groups), () => `${n.toLocaleString()} vertices`)
for (const pass of [0, 1]) {
  time(`Heatmap, worst direction, pass ${pass + 1}`, () => heatRange(pv, face, { mode: 'impulse', mu: 0.5, mass: mass.mass, dirs: { kind: 'worst', up, elevation: 0.5 } }, disp.positions, mass.com, disp.normals, out, 0, disp.groups.start.length - 1, disp.groups, pass))
}

const w = Math.max(...rows.map((r) => r[0].length))
for (const [label, ms, note] of rows) console.log(`${label.padEnd(w)}  ${ms.toFixed(0).padStart(6)} ms  ${note}`)
