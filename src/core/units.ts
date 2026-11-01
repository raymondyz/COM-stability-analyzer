export const GRAVITY = 9.80665

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft'
export type MassUnit = 'g' | 'kg' | 'lb'

// Size of one unit in metres or kilograms.
export const LENGTH: Record<LengthUnit, number> = { mm: 1e-3, cm: 1e-2, m: 1, in: 0.0254, ft: 0.3048 }
export const MASS: Record<MassUnit, number> = { g: 1e-3, kg: 1, lb: 0.45359237 }

export const LENGTH_UNITS = Object.keys(LENGTH) as LengthUnit[]
export const MASS_UNITS = Object.keys(MASS) as MassUnit[]
