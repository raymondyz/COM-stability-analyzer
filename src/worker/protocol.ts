import type { HitMode } from '../core/heatmap.ts'
import type { Outcome } from '../core/impact.ts'
import type { Segment } from '../core/roll.ts'
import type { MassProps } from '../core/types.ts'
import type { Vec3 } from '../core/vec.ts'

export interface LoadResult {
  name: string
  triangles: number
  positions: Float32Array     // display mesh, body frame, m
  indices: Uint32Array
  normals: Float32Array
  hullVerts: Float64Array     // body frame, m
  centroid: Vec3              // uniform-density centroid, body frame
  size: number                // hull bounding-box diagonal, m
  sampleMass: MassProps | null
  ms: number
}

export interface PoseInfo {
  face: number
  down: Vec3                  // body-frame down vector
  height: number              // COM height at rest, m
  inset: number               // projected COM to nearest support edge, m
  tilt: number                // tilt-to-tip, rad
  probability: number
  escape: { lift: number, to: number } | null
  support: Vec3[]             // support polygon, relative to the COM
  folded: number              // shallow poses folded into this one
}

export interface AnalysisResult {
  version: number
  com: Vec3
  poses: PoseInfo[]
  lift: Float64Array          // lift[i·P + j]: COM rise from pose i to pose j, m
  euler: { stable: number, saddles: number, maxima: number }
  basinLevel: number
  basin: Int16Array           // pose index per icosphere vertex (-1: unresolved)
  final: boolean
  ms: number
}

export type HitDirection = { kind: 'fixed', d: Vec3 } | { kind: 'worst', elevation: number }

export interface HitSpec {
  mode: HitMode
  mu: number
  dir: HitDirection
}

export interface Weapon {
  mass: number                // effective mass, kg
  speed: number               // closing speed, m/s
  restitution: number
}

export interface ProbeResult {
  point: Vec3                 // body frame
  dir: Vec3 | null            // hit direction used, body frame
  value: number | null        // J_min (N·s) or F_min (N)
  reason: Outcome
  pivot: { kind: 'edge' | 'corner', a: Vec3, b: Vec3 } | null   // relative to the COM
  landing: number | null      // pose index
  delivered: number | null    // impulse from the weapon at this point
}

export interface RollResult {
  segments: Segment[]
  pose: number
}

export type Request =
  | { kind: 'load', id: number, file: File | null, name: string, unitScale: number }
  | { kind: 'analyze', id: number, com: Vec3, threshold: number, level: number }
  | { kind: 'roll', id: number, version: number, down: Vec3 }
  | { kind: 'heatmap', id: number, version: number, pose: number, mass: MassProps, hit: HitSpec }
  | { kind: 'probe', id: number, version: number, pose: number, mass: MassProps, hit: HitSpec, ray: { origin: Vec3, dir: Vec3 }, weapon: Weapon | null }


export type Response =
  | { id: number, type: 'progress', stage: string, fraction: number }
  | { id: number, type: 'partial', data: unknown }
  | { id: number, type: 'result', data: unknown }
  | { id: number, type: 'error', message: string }
  | { id: number, type: 'cancelled' }
