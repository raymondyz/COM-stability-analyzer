import type { Hull } from './hull.ts'
import type { Mat3, Vec3 } from './vec.ts'

// Volume integrals ∫1, ∫x and ∫xxᵀ over a closed surface's interior, body frame.
export interface Moments {
  volume: number
  first: Vec3
  second: Mat3
}

// Sums signed tetrahedra (origin, a, b, c) over the triangles. Closed bodies count
// once each; overlapping bodies in an assembly double-count, which is fine for an
// estimate.
export function meshMoments(p: Float64Array, indices: ArrayLike<number>): Moments {
  let vol = 0
  const s: Vec3 = [0, 0, 0]
  const c: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t]
    const b = 3 * indices[t + 1]
    const d = 3 * indices[t + 2]
    const ax = p[a], ay = p[a + 1], az = p[a + 2]
    const bx = p[b], by = p[b + 1], bz = p[b + 2]
    const cx = p[d], cy = p[d + 1], cz = p[d + 2]
    const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
    vol += v
    const sx = ax + bx + cx
    const sy = ay + by + cy
    const sz = az + bz + cz
    s[0] += (v * sx) / 4
    s[1] += (v * sy) / 4
    s[2] += (v * sz) / 4
    // ∫xxᵀ over a tetrahedron with one vertex at the origin: V/20 · (Σ pᵢpᵢᵀ + (Σ pᵢ)(Σ pᵢ)ᵀ).
    const k = v / 20
    c[0] += k * (ax * ax + bx * bx + cx * cx + sx * sx)
    c[4] += k * (ay * ay + by * by + cy * cy + sy * sy)
    c[8] += k * (az * az + bz * bz + cz * cz + sz * sz)
    c[1] += k * (ax * ay + bx * by + cx * cy + sx * sy)
    c[2] += k * (ax * az + bx * bz + cx * cz + sx * sz)
    c[5] += k * (ay * az + by * bz + cy * cz + sy * sz)
  }
  c[3] = c[1]
  c[6] = c[2]
  c[7] = c[5]
  return { volume: vol, first: s, second: c }
}

export function hullMoments(hull: Hull): Moments {
  const idx: number[] = []
  for (const f of hull.faces) for (let j = 1; j + 1 < f.verts.length; j++) idx.push(f.verts[0], f.verts[j], f.verts[j + 1])
  return meshMoments(hull.verts, idx)
}

// Uniform-density inertia about `com`, scaled to `mass`.
export function inertiaFromMoments(mo: Moments, com: Vec3, mass: number): Mat3 {
  const { volume: V, first: s, second: c } = mo
  // Second moment about the COM: C − c·sᵀ − s·cᵀ + V·c·cᵀ
  const m: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) m[3 * i + j] = c[3 * i + j] - com[i] * s[j] - s[i] * com[j] + V * com[i] * com[j]
  }
  const rho = mass / V
  const tr = m[0] + m[4] + m[8]
  return [
    rho * (tr - m[0]), -rho * m[1], -rho * m[2],
    -rho * m[3], rho * (tr - m[4]), -rho * m[5],
    -rho * m[6], -rho * m[7], rho * (tr - m[8]),
  ]
}

export const centroid = (mo: Moments): Vec3 => [mo.first[0] / mo.volume, mo.first[1] / mo.volume, mo.first[2] / mo.volume]
