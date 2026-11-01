// STL files hold a triangle soup. Returns 9 floats per triangle, in file units.
export function parseStl(buf: ArrayBuffer): Float32Array {
  const dv = new DataView(buf)
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true)
    if (84 + 50 * n === buf.byteLength) return parseBinary(dv, n)
  }
  return parseAscii(new TextDecoder().decode(buf))
}

function parseBinary(dv: DataView, n: number): Float32Array {
  const soup = new Float32Array(n * 9)
  for (let i = 0; i < n; i++) {
    const o = 84 + 50 * i + 12
    for (let k = 0; k < 9; k++) soup[9 * i + k] = dv.getFloat32(o + 4 * k, true)
  }
  return soup
}

function parseAscii(text: string): Float32Array {
  const values: number[] = []
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g
  for (let m = re.exec(text); m; m = re.exec(text)) values.push(+m[1], +m[2], +m[3])
  if (values.length === 0 || values.length % 9 !== 0 || values.some(Number.isNaN)) {
    throw new Error('This file is not a valid STL.')
  }
  return Float32Array.from(values)
}
