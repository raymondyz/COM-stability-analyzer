import { simplify, type Simplified } from '../core/barriers.ts'
import { displayMesh, type DisplayMesh } from '../core/displayMesh.ts'
import { classify, type Statics } from '../core/equilibria.ts'
import { heatRange, PASSES, worstDirection, type HeatSpec } from '../core/heatmap.ts'
import { buildHull, type Hull } from '../core/hull.ts'
import { bestPivot, cornerModels, edgeModels, weaponImpulse, type Pivots } from '../core/impact.ts'
import { centroid, hullMoments, inertiaFromMoments, meshMoments, type Moments } from '../core/inertia.ts'
import { parseObj } from '../core/io/obj.ts'
import { parseStl } from '../core/io/stl.ts'
import { makeRoller, resolve, rollFrom, type Roller, type Segment } from '../core/roll.ts'
import { sampleBot } from '../core/sample.ts'
import { icosphere, vertexCount } from '../core/sphere.ts'
import { tipPath } from '../core/tipPath.ts'
import type { MassProps } from '../core/types.ts'
import { cross, dot, get, normalize, scale, sub, type Vec3 } from '../core/vec.ts'
import { weld } from '../core/weld.ts'
import type { AnalysisResult, HitSpec, LoadResult, PoseInfo, ProbeResult, Request, Response, RollResult } from './protocol.ts'

interface Model {
  display: DisplayMesh        // drawn, painted and picked
  hull: Hull
  moments: Moments            // used for the centroid and estimated inertia
}

interface Current {
  version: number
  com: Vec3
  st: Statics
  roller: Roller
  stableFaces: number[]
  simp: Simplified
  poseOfFace: Map<number, number>   // stable face → pose index
}

let model: Model | null = null
let current: Current | null = null
let version = 0
const latest: Partial<Record<Request['kind'], number>> = {}
const pivotCache = new Map<string, Pivots>()
const CANCELLED = Symbol('cancelled')

const post = (msg: Response, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

self.onmessage = async (ev: MessageEvent<Request>) => {
  const req = ev.data
  latest[req.kind] = req.id
  try {
    if (req.kind === 'load') await load(req)
    else if (req.kind === 'analyze') await analyze(req)
    else if (req.kind === 'roll') roll(req)
    else if (req.kind === 'heatmap') await heatmap(req)
    else probe(req)
  } catch (e) {
    if (e === CANCELLED) post({ id: req.id, type: 'cancelled' })
    else post({ id: req.id, type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}

// Yields to the message loop, then stops if a newer request of the same kind arrived.
async function checkpoint(req: Request) {
  await new Promise<void>((resolve) => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => resolve()
    ch.port2.postMessage(null)
  })
  if (latest[req.kind] !== req.id) throw CANCELLED
}

const progress = (req: Request, stage: string, fraction: number) => post({ id: req.id, type: 'progress', stage, fraction })

async function load(req: Extract<Request, { kind: 'load' }>) {
  const t0 = performance.now()
  progress(req, 'Reading file', 0.05)
  let soup: Float32Array
  let sampleMass: MassProps | null = null
  if (req.file) {
    const buf = await req.file.arrayBuffer()
    soup = req.name.toLowerCase().endsWith('.obj') ? parseObj(new TextDecoder().decode(buf)) : parseStl(buf)
  } else {
    const s = sampleBot()
    soup = s.soup
    sampleMass = s.mass
  }
  await checkpoint(req)
  progress(req, 'Merging vertices', 0.3)
  await checkpoint(req)
  const mesh = weld(soup, req.unitScale)
  progress(req, 'Building convex hull', 0.6)
  await checkpoint(req)
  const hull = buildHull(mesh.positions)
  let mo = meshMoments(mesh.positions, mesh.indices)
  const flip = mo.volume < 0
  if (flip) mo = { volume: -mo.volume, first: scale(mo.first, -1), second: mo.second.map((v) => -v) as Moments['second'] }
  const hullMo = hullMoments(hull)
  // An assembly can over-count overlapping bodies or have open shells; fall back to the hull.
  const moments = mo.volume > 0 && mo.volume <= 1.05 * hullMo.volume ? mo : hullMo
  progress(req, 'Preparing the display mesh', 0.85)
  await checkpoint(req)
  const display = displayMesh(mesh, hull.size / 40, flip)
  model = { display, hull, moments }
  current = null
  pivotCache.clear()

  const positions = Float32Array.from(display.positions)
  const indices = display.indices.slice()
  const normals = display.normals.slice()
  const hullVerts = hull.verts.slice()
  const data: LoadResult = {
    name: req.name,
    triangles: soup.length / 9,
    positions,
    indices,
    normals,
    hullVerts,
    centroid: centroid(moments),
    size: hull.size,
    sampleMass,
    ms: performance.now() - t0,
  }
  post({ id: req.id, type: 'result', data }, [positions.buffer, indices.buffer, normals.buffer, hullVerts.buffer])
}

async function analyze(req: Extract<Request, { kind: 'analyze' }>) {
  if (!model) throw new Error('No model loaded.')
  const t0 = performance.now()
  const { hull } = model
  const st = classify(hull, req.com)
  if (st.depth <= 0) {
    throw new Error('The center of mass is outside the model. Check that the STL and the mass properties use the same coordinate system and units.')
  }
  const roller = makeRoller(hull, st)
  const stableFaces = hull.faces.map((_, i) => i).filter((f) => st.stable[f])
  const rawIndex = new Map(stableFaces.map((f, i) => [f, i]))
  const links = st.saddles.flatMap((s) => {
    const e = hull.edges[s.edge]
    const a = rawIndex.get(resolve(roller, e.left))
    const b = rawIndex.get(resolve(roller, e.right))
    return a === undefined || b === undefined ? [] : [{ height: s.height, a, b }]
  })
  const simp = simplify(stableFaces.map((f) => st.faceHeight[f]), links, req.threshold)
  const poseIndex = new Map(simp.poses.map((raw, i) => [raw, i]))
  const poseOfFace = new Map<number, number>()
  stableFaces.forEach((f, raw) => {
    let s = raw
    while (simp.survivor[s] !== s) s = simp.survivor[s]
    poseOfFace.set(f, poseIndex.get(s)!)
  })
  const v = ++version
  current = { version: v, com: req.com, st, roller, stableFaces, simp, poseOfFace }
  pivotCache.clear()

  const folded = simp.poses.map(() => 0)
  for (const [, p] of poseOfFace) folded[p]++
  const base = simp.poses.map((raw, i): PoseInfo => {
    const f = stableFaces[raw]
    const face = hull.faces[f]
    let tilt = Infinity
    face.verts.forEach((ia, j) => {
      const ib = face.verts[(j + 1) % face.verts.length]
      const out = normalize(cross(sub(get(st.V, ib), get(st.V, ia)), face.normal))
      tilt = Math.min(tilt, tipPath(st.V, hull.count, face.normal, out, ia).top)
    })
    return {
      face: f,
      down: face.normal,
      height: st.faceHeight[f],
      inset: st.inset[f],
      tilt,
      probability: 0,
      escape: simp.escape[i],
      support: face.verts.map((k) => get(st.V, k)),
      folded: folded[i] - 1,
    }
  })

  const euler = { stable: stableFaces.length, saddles: st.saddles.length, maxima: st.maxima.length }
  const levels = req.level > 4 ? [4, req.level] : [req.level]
  const dest = new Int16Array(vertexCount(levels[levels.length - 1])).fill(-1)
  let done = 0
  for (const level of levels) {
    const sphere = icosphere(level)
    const n = vertexCount(level)
    for (let i = done; i < n; i++) {
      const f = rollFrom(roller, get(sphere.verts, i))
      dest[i] = f >= 0 ? poseOfFace.get(f) ?? -1 : -1
      if ((i & 4095) === 4095) {
        progress(req, 'Mapping where each orientation rolls', i / vertexCount(levels[levels.length - 1]))
        await checkpoint(req)
      }
    }
    done = n
    const poses = base.map((p) => ({ ...p, probability: 0 }))
    for (let i = 0; i < n; i++) if (dest[i] >= 0) poses[dest[i]].probability += sphere.weights[i]
    const final = level === levels[levels.length - 1]
    const data: AnalysisResult = {
      version: v,
      com: req.com,
      poses,
      lift: simp.lift.slice(),
      euler,
      basinLevel: level,
      basin: dest.slice(0, n),
      final,
      ms: performance.now() - t0,
    }
    post({ id: req.id, type: final ? 'result' : 'partial', data })
    if (!final) await checkpoint(req)
  }
}

function needCurrent(v: number): Current {
  if (!model || !current || current.version !== v) throw CANCELLED
  return current
}

function roll(req: Extract<Request, { kind: 'roll' }>) {
  const cur = needCurrent(req.version)
  const segments: Segment[] = []
  const f = rollFrom(cur.roller, normalize(req.down), segments)
  const data: RollResult = { segments, pose: f >= 0 ? cur.poseOfFace.get(f) ?? -1 : -1 }
  post({ id: req.id, type: 'result', data })
}

// Edge and corner pivots for a pose, with landing faces mapped to pose indices.
function pivotsFor(cur: Current, pose: number, mass: MassProps): Pivots {
  const key = `${cur.version}|${pose}|${mass.mass}|${mass.inertia?.join(',') ?? 'est'}`
  const hit = pivotCache.get(key)
  if (hit) return hit
  const inertia = mass.inertia ?? inertiaFromMoments(model!.moments, cur.com, mass.mass)
  const face = cur.stableFaces[cur.simp.poses[pose]]
  const toPose = (f: number) => (f >= 0 ? cur.poseOfFace.get(f) ?? -1 : -1)
  const { hull } = model!
  const pv: Pivots = {
    edges: edgeModels(hull, cur.st, cur.roller, face, mass, inertia).map((e) => ({ ...e, landing: toPose(e.landing) })),
    corners: cornerModels(hull, cur.st, cur.roller, face, mass, inertia).map((c) => ({
      ...c,
      samples: c.samples.map((s) => ({ ...s, landing: toPose(s.landing) })),
    })),
  }
  pivotCache.set(key, pv)
  return pv
}

function heatSpec(cur: Current, pose: number, mass: MassProps, hit: HitSpec): HeatSpec {
  const up = scale(model!.hull.faces[cur.stableFaces[cur.simp.poses[pose]]].normal, -1)
  return {
    mode: hit.mode,
    mu: hit.mu,
    mass: mass.mass,
    dirs: hit.dir.kind === 'fixed' ? { kind: 'fixed', d: normalize(hit.dir.d) } : { kind: 'worst', up, elevation: hit.dir.elevation },
  }
}

async function heatmap(req: Extract<Request, { kind: 'heatmap' }>) {
  const cur = needCurrent(req.version)
  const pv = pivotsFor(cur, req.pose, req.mass)
  const spec = heatSpec(cur, req.pose, req.mass, req.hit)
  const { positions, normals, groups } = model!.display
  const out = new Float32Array(positions.length / 3)
  const n = groups.start.length - 1
  const passes = spec.dirs.kind === 'fixed' ? 1 : PASSES
  const chunk = spec.dirs.kind === 'fixed' ? 200000 : 16384
  for (let pass = 0; pass < passes; pass++) {
    for (let s = 0; s < n; s += chunk) {
      heatRange(pv, req.pose, spec, positions, cur.com, normals, out, s, Math.min(n, s + chunk), groups, pass)
      progress(req, passes > 1 ? `Painting the heatmap (pass ${pass + 1} of ${passes})` : 'Painting the heatmap', (pass + Math.min(1, (s + chunk) / n)) / passes)
      await checkpoint(req)
    }
    // Show the coarse pass while the next one refines it.
    if (pass < passes - 1) post({ id: req.id, type: 'partial', data: out.slice() })
  }
  post({ id: req.id, type: 'result', data: out }, [out.buffer])
}

function probe(req: Extract<Request, { kind: 'probe' }>) {
  const cur = needCurrent(req.version)
  const hitTri = raycast(model!.display, req.ray.origin, normalize(req.ray.dir))
  if (!hitTri) {
    post({ id: req.id, type: 'result', data: null })
    return
  }
  const pv = pivotsFor(cur, req.pose, req.mass)
  const spec = heatSpec(cur, req.pose, req.mass, req.hit)
  const p = sub(hitTri.point, cur.com)
  // Face the surface normal toward the ray, so the "hits push in" test uses the visible side.
  const normal = dot(hitTri.normal, req.ray.dir) > 0 ? scale(hitTri.normal, -1) : hitTri.normal
  const d = worstDirection(pv, req.pose, spec, p, normal)
  let data: ProbeResult = { point: hitTri.point, dir: d, value: null, reason: 'none', pivot: null, landing: null, delivered: null }
  if (d && dot(d, normal) < 0) {
    const res = bestPivot(pv, req.pose, p, d, req.hit.mu, req.hit.mode, req.mass.mass)
    if (res.best) {
      const b = res.best
      const pivot: ProbeResult['pivot'] = b.kind === 'edge'
        ? { kind: 'edge', a: pv.edges[b.index].q1, b: get(cur.st.V, pv.edges[b.index].b) }
        : { kind: 'corner', a: pv.corners[b.index].P, b: pv.corners[b.index].P }
      data = {
        ...data,
        value: b.value,
        reason: 'ok',
        pivot,
        landing: b.landing,
        delivered: req.weapon && req.hit.mode === 'impulse'
          ? weaponImpulse(b.mEff, req.weapon.mass, req.weapon.speed, req.weapon.restitution)
          : null,
      }
    } else {
      data = { ...data, reason: res.reason }
    }
  }
  post({ id: req.id, type: 'result', data })
}

// Nearest triangle hit along a ray (Möller–Trumbore), in body coordinates.
function raycast(mesh: DisplayMesh, o: Vec3, d: Vec3): { point: Vec3, normal: Vec3 } | null {
  const p = mesh.positions
  const idx = mesh.indices
  let best = Infinity
  let tri = -1
  for (let t = 0; t < idx.length; t += 3) {
    const a = 3 * idx[t]
    const b = 3 * idx[t + 1]
    const c = 3 * idx[t + 2]
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2]
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2]
    const px = d[1] * e2z - d[2] * e2y
    const py = d[2] * e2x - d[0] * e2z
    const pz = d[0] * e2y - d[1] * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (Math.abs(det) < 1e-18) continue
    const inv = 1 / det
    const sx = o[0] - p[a], sy = o[1] - p[a + 1], sz = o[2] - p[a + 2]
    const u = (sx * px + sy * py + sz * pz) * inv
    if (u < 0 || u > 1) continue
    const qx = sy * e1z - sz * e1y
    const qy = sz * e1x - sx * e1z
    const qz = sx * e1y - sy * e1x
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv
    if (v < 0 || u + v > 1) continue
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv
    if (dist > 0 && dist < best) {
      best = dist
      tri = t
    }
  }
  if (tri < 0) return null
  const a = get(p, idx[tri])
  const normal = normalize(cross(sub(get(p, idx[tri + 1]), a), sub(get(p, idx[tri + 2]), a)))
  return { point: [o[0] + best * d[0], o[1] + best * d[1], o[2] + best * d[2]], normal }
}
