// Reads vertices and faces from a Wavefront OBJ and returns a triangle soup
// (9 floats per triangle, file units). Polygons are fan-triangulated.
export function parseObj(text: string): Float32Array {
  const verts: number[] = []
  const out: number[] = []
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts[0] === 'v') {
      verts.push(+parts[1], +parts[2], +parts[3])
    } else if (parts[0] === 'f') {
      const count = verts.length / 3
      const idx = parts.slice(1).map((p) => {
        const i = parseInt(p, 10)
        return i < 0 ? count + i : i - 1
      })
      for (let j = 1; j + 1 < idx.length; j++) {
        for (const i of [idx[0], idx[j], idx[j + 1]]) out.push(verts[3 * i], verts[3 * i + 1], verts[3 * i + 2])
      }
    }
  }
  if (out.length === 0 || out.some(Number.isNaN)) throw new Error('This file has no readable faces.')
  return Float32Array.from(out)
}
