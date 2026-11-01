import type { MassProps } from './types.ts'

// A generated beetleweight-style four-wheel wedge (mm), so the app can be tried
// without a model. Mass properties are plausible made-up values, in SI.
// Extrudes a convex (x, z) outline from y0 to y1 as outward-facing triangles.
export function extrude(tris: number[], shape: [number, number][], y0: number, y1: number) {
  const n = shape.length
  let area = 0
  for (let i = 0; i < n; i++) area += shape[i][0] * shape[(i + 1) % n][1] - shape[(i + 1) % n][0] * shape[i][1]
  const outline = area > 0 ? shape : [...shape].reverse()
  for (let i = 0; i < n; i++) {
    const [x0, z0] = outline[i]
    const [x1, z1] = outline[(i + 1) % n]
    tris.push(x0, y0, z0, x0, y1, z0, x1, y1, z1)
    tris.push(x0, y0, z0, x1, y1, z1, x1, y0, z1)
  }
  for (let i = 1; i + 1 < n; i++) {
    const [a, b, c] = [outline[0], outline[i], outline[i + 1]]
    tris.push(a[0], y1, a[1], c[0], y1, c[1], b[0], y1, b[1])
    tris.push(a[0], y0, a[1], b[0], y0, b[1], c[0], y0, c[1])
  }
}

export function sampleBot(): { soup: Float32Array, mass: MassProps } {
  const tris: number[] = []
  const circle = (cx: number, cz: number, r: number, segments: number) =>
    Array.from({ length: segments }, (_, i): [number, number] => {
      const t = (-2 * Math.PI * i) / segments
      return [cx + r * Math.cos(t), cz + r * Math.sin(t)]
    })

  extrude(tris, [[-110, 14], [-110, 58], [95, 58], [150, 5], [110, 14]], -70, 70)
  for (const x of [-75, 65]) {
    for (const [y0, y1] of [[72, 92], [-92, -72]]) extrude(tris, circle(x, 30, 30, 48), y0, y1)
  }
  return {
    soup: Float32Array.from(tris),
    mass: {
      mass: 1.36,
      com: [-0.005, 0, 0.03],
      inertia: [0.004245, 0, 0, 0, 0.008069, 0, 0, 0, 0.011498],
    },
  }
}
