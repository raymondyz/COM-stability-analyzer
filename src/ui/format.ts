export const letter = (rank: number) => (rank < 26 ? String.fromCharCode(65 + rank) : `#${rank + 1}`)

// n significant figures, without exponent notation for everyday magnitudes.
export function sig(x: number, n = 2): string {
  if (!Number.isFinite(x)) return '∞'
  if (x === 0) return '0'
  const digits = Math.max(0, n - 1 - Math.floor(Math.log10(Math.abs(x))))
  return x.toFixed(Math.min(digits, 6))
}

export const mm = (m: number, digits = 1) => `${(m * 1000).toFixed(digits)} mm`
export const deg = (rad: number) => `${Math.round((rad * 180) / Math.PI)}°`
export const pct = (p: number) => (p > 0 && p < 0.005 ? '<1%' : `${Math.round(p * 100)}%`)
export const joules = (j: number) => `${sig(j)} J`
