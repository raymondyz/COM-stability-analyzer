import type { HitMode } from '../core/heatmap.ts'

export interface HitSettings {
  mode: HitMode
  dirMode: 'camera' | 'worst'
  elevation: number        // degrees, positive rises
  mu: number
  e: number
  weaponMass: number       // kg
  weaponSpeed: number      // m/s
}

export const HIT_DEFAULTS: HitSettings = { mode: 'impulse', dirMode: 'camera', elevation: 0, mu: 0.5, e: 0.3, weaponMass: 0.5, weaponSpeed: 50 }
