import type { Mat3, Vec3 } from './vec.ts'

export interface MassProps {
  mass: number              // kg
  com: Vec3                 // m, body frame
  inertia: Mat3 | null      // kg·m² about the COM, body axes
}
