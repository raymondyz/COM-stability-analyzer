import type { HitMode } from '../core/heatmap.ts'
import type { Strength } from '../worker/protocol.ts'

export interface HitSettings {
  mode: HitMode
  aim: 'heading' | 'worst'  // the heading below, or the easiest direction at each point
  heading: number          // degrees, see Viewer.bodyDirection
  elevation: number        // degrees, positive rises
  mu: number
  e: number
  strength: 'impulse' | 'weapon'
  impulse: number          // N·s
  force: number            // N
  weaponMass: number       // kg
  weaponSpeed: number      // m/s
}

export const HIT_DEFAULTS: HitSettings = {
  mode: 'impulse', aim: 'heading', heading: 0, elevation: 0, mu: 0.5, e: 0.3,
  strength: 'impulse', impulse: 5, force: 100, weaponMass: 0.5, weaponSpeed: 50,
}

export function strengthOf(h: HitSettings): Strength {
  if (h.mode === 'push') return { kind: 'force', value: h.force }
  return h.strength === 'weapon'
    ? { kind: 'weapon', mass: h.weaponMass, speed: h.weaponSpeed, restitution: h.e }
    : { kind: 'impulse', value: h.impulse }
}
