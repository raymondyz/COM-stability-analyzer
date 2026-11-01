import { Color } from 'three'

// Categorical colors for poses (A, B, C, …), distinguishable in light and dark themes.
export const POSE_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2', '#edc948', '#ff9da7', '#9c755f', '#bab0ac']
export const poseColor = (i: number) => (i < 0 ? '#808080' : POSE_COLORS[i % POSE_COLORS.length])

// Heatmap ramp from easy to flip (red) to hard (neutral grey).
export const HEAT_STOPS: [number, string][] = [[0, '#c0262c'], [0.3, '#f07c3a'], [0.6, '#f5c86e'], [1, '#d6d6d6']]
export const NO_FLIP = '#8fa7c0'      // hits here never flip it
export const BASE = '#c4c7cc'         // surfaces this direction can't hit

const linear = (hex: string) => new Color(hex)   // three converts sRGB hex to its linear working space

export function heatColors(values: Float32Array, lo: number, hi: number): Float32Array {
  const stops = HEAT_STOPS.map(([t, c]) => [t, linear(c)] as const)
  const noFlip = linear(NO_FLIP)
  const base = linear(BASE)
  const out = new Float32Array(values.length * 3)
  const llo = Math.log(lo)
  const span = Math.max(Math.log(hi) - llo, 1e-9)
  const tmp = new Color()
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    let c: Color
    if (Number.isNaN(v)) c = base
    else if (!Number.isFinite(v)) c = noFlip
    else {
      const t = Math.min(1, Math.max(0, (Math.log(v) - llo) / span))
      let k = 1
      while (k < stops.length - 1 && t > stops[k][0]) k++
      const [t0, c0] = stops[k - 1]
      const [t1, c1] = stops[k]
      c = tmp.copy(c0).lerp(c1, (t - t0) / (t1 - t0))
    }
    out[3 * i] = c.r
    out[3 * i + 1] = c.g
    out[3 * i + 2] = c.b
  }
  return out
}

// Robust colour-scale range: 2nd to 98th percentile of the finite values.
export function heatRange(values: Float32Array): [number, number] | null {
  const finite: number[] = []
  const step = Math.max(1, Math.floor(values.length / 50000))
  for (let i = 0; i < values.length; i += step) if (Number.isFinite(values[i]) && values[i] > 0) finite.push(values[i])
  if (finite.length === 0) return null
  finite.sort((a, b) => a - b)
  const lo = finite[Math.floor(0.02 * (finite.length - 1))]
  const hi = finite[Math.floor(0.98 * (finite.length - 1))]
  return [lo, Math.max(hi, lo * 1.01)]
}

export function cssGradient(): string {
  return `linear-gradient(to right, ${HEAT_STOPS.map(([t, c]) => `${c} ${t * 100}%`).join(', ')})`
}
