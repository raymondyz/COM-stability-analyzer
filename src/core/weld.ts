export interface Mesh {
  positions: Float64Array   // m, body frame
  indices: Uint32Array
}

// Merges duplicate vertices of a triangle soup (9 floats per triangle) and drops
// triangles that collapse. `scale` converts file units to metres.
export function weld(soup: Float32Array, scale: number): Mesh {
  const n = soup.length / 3
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < soup.length; i++) {
    if (soup[i] < lo) lo = soup[i]
    if (soup[i] > hi) hi = soup[i]
  }
  // Coordinates are quantized relative to the model size. STL exporters write shared
  // vertices with identical floats, so this only has to absorb tiny noise.
  const q = Math.max(hi - lo, 1e-12) * 1e-8
  const key = (i: number, k: number) => Math.round(soup[3 * i + k] / q)
  const hash = (i: number) => Math.imul(key(i, 0), 73856093) ^ Math.imul(key(i, 1), 19349663) ^ Math.imul(key(i, 2), 83492791)
  const same = (i: number, j: number) => key(i, 0) === key(j, 0) && key(i, 1) === key(j, 1) && key(i, 2) === key(j, 2)

  let cap = 1 << Math.ceil(Math.log2(Math.max(1024, n >> 1)))
  let table = new Int32Array(cap).fill(-1)  // unique id per slot
  const rep = new Int32Array(n)             // soup vertex representing each unique id
  const ids = new Uint32Array(n)
  let count = 0

  const insert = (u: number) => {
    let h = hash(rep[u]) & (cap - 1)
    while (table[h] >= 0) h = (h + 1) & (cap - 1)
    table[h] = u
  }

  for (let i = 0; i < n; i++) {
    let h = hash(i) & (cap - 1)
    let found = -1
    while (table[h] >= 0) {
      if (same(rep[table[h]], i)) {
        found = table[h]
        break
      }
      h = (h + 1) & (cap - 1)
    }
    if (found < 0) {
      found = count++
      rep[found] = i
      table[h] = found
      if (count * 2 > cap) {
        cap *= 2
        table = new Int32Array(cap).fill(-1)
        for (let u = 0; u < count; u++) insert(u)
      }
    }
    ids[i] = found
  }

  const positions = new Float64Array(3 * count)
  for (let u = 0; u < count; u++) {
    for (let k = 0; k < 3; k++) positions[3 * u + k] = soup[3 * rep[u] + k] * scale
  }
  let kept = 0
  const indices = new Uint32Array(n)
  for (let t = 0; t < n; t += 3) {
    const a = ids[t]
    const b = ids[t + 1]
    const c = ids[t + 2]
    if (a === b || b === c || a === c) continue
    indices[kept++] = a
    indices[kept++] = b
    indices[kept++] = c
  }
  return { positions, indices: indices.slice(0, kept) }
}
