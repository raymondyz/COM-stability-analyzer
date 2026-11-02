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

// How hard the bot is hit: an impulse, a weapon whose impulse depends on the bot's
// effective mass at the point, or a steady push.
export type Strength =
  | { kind: 'impulse', value: number }                                  // N·s
  | { kind: 'weapon', mass: number, speed: number, restitution: number }  // kg, m/s
  | { kind: 'force', value: number }                                    // N

export interface PickResult {
  point: Vec3                 // body frame
  normal: Vec3                // surface normal, facing the camera
}

// What the applied hit does.
export interface HitResult {
  pose: number                // pose it ends in (-1: unknown)
  tops: number                // times it goes over a top
  maxTilt: number             // rad
  energy: number | null       // kinetic energy given to the bot, J (impacts)
  hardest: number             // most energy one landing absorbs, J: a real bot may bounce instead
  complete: boolean           // false: still tumbling after a full turn, past what the model covers
  segments: Segment[]         // the motion from rest, for the animation
}

export interface ProbeResult {
  point: Vec3                 // body frame
  dir: Vec3 | null            // hit direction used, body frame
  value: number | null        // J_min (N·s) or F_min (N) at this point in this direction
  reason: Outcome | 'away'    // why nothing tips ('away': the surface faces away from the hit)
  pivot: { kind: 'edge' | 'corner', a: Vec3, b: Vec3 } | null   // relative to the COM
  landing: number | null      // pose a just-sufficient hit lands in
  applied: number | null      // impulse (N·s) or force (N) applied
  result: HitResult | null
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
  | { kind: 'pick', id: number, ray: { origin: Vec3, dir: Vec3 } }
  | { kind: 'probe', id: number, version: number, pose: number, mass: MassProps, hit: HitSpec, point: Vec3, normal: Vec3, strength: Strength }

export type Response =
  | { id: number, type: 'progress', stage: string, fraction: number }
  | { id: number, type: 'partial', data: unknown }
  | { id: number, type: 'result', data: unknown }
  | { id: number, type: 'error', message: string }
  | { id: number, type: 'cancelled' }
