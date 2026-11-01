import { dot, get, type Vec3 } from './vec.ts'

export interface Kink {
  theta: number     // tilt at which a new contact lands
  vertex: number    // the new pivot (hull vertex id)
  h: number         // COM height at that moment
}

export interface TipPath {
  top: number       // tilt at the top of the path (tilt-to-tip), rad
  lift: number      // COM rise from rest to the top, m
  kinks: Kink[]     // contact changes before the top
  land: number      // tilt where it first comes to rest past the top
}

// Tips the bot from rest on a face (outward normal n) about an axis along one of
// its edges, so the down vector follows u(θ) = cos θ·n + sin θ·m, where m is the
// face's outward in-plane direction across that edge. The COM height is the hull's
// support function along that great circle; this walks it to its first maximum,
// then on down to where the bot lands (momentum keeps it in the plane).
// V holds hull vertices relative to the COM; `start` is a vertex on the edge.
export function tipPath(V: Float64Array, count: number, n: Vec3, m: Vec3, start: number): TipPath {
  const a = new Float64Array(count)
  const b = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const v = get(V, i)
    a[i] = dot(v, n)
    b[i] = dot(v, m)
  }
  const h0 = a[start]
  const tol = 1e-12 * (Math.abs(h0) + 1e-9)
  const slope = (j: number, th: number) => b[j] * Math.cos(th) - a[j] * Math.sin(th)
  // Next contact change after theta while pivoting on i: [angle, new pivot].
  const nextKink = (i: number, theta: number): [number, number] => {
    let next = Infinity
    let nj = -1
    for (let j = 0; j < count; j++) {
      const A = a[j] - a[i]
      const B = b[j] - b[i]
      if (Math.abs(A) + Math.abs(B) < tol) continue
      // j overtakes i where A·cos θ + B·sin θ crosses zero going up: at ψ − π/2.
      let z = (Math.atan2(B, A) - Math.PI / 2 - theta) % (2 * Math.PI)
      if (z < 0) z += 2 * Math.PI
      if (z < 1e-9 || z > 2 * Math.PI - 1e-9) {
        // Tied right now: j takes over only if it is rising faster.
        if (slope(j, theta) <= slope(i, theta) + tol) continue
        z = 0
      }
      z += theta
      if (z < next - 1e-12 || (Math.abs(z - next) <= 1e-12 && slope(j, z) > slope(nj, z))) {
        next = z
        nj = j
      }
    }
    return [next, nj]
  }
  // Past the top it lands where a new contact comes down that isn't itself falling.
  const landing = (i: number, top: number) => {
    let theta = top
    for (let step = 0; step < 4 * count + 8; step++) {
      const [next, nj] = nextKink(i, theta)
      if (nj < 0 || next > top + Math.PI) return top + 1e-3
      if (slope(nj, next) >= 0) return next - 1e-6
      i = nj
      theta = next
    }
    return top + 1e-3
  }

  const kinks: Kink[] = []
  let i = start
  let theta = 0
  for (let step = 0; step < 4 * count + 8; step++) {
    // The current pivot's curve a·cos θ + b·sin θ peaks at atan2(b, a).
    const peak = Math.atan2(b[i], a[i])
    const [next, nj] = nextKink(i, theta)
    if (peak <= theta + 1e-12 || peak <= next) {
      const top = Math.max(peak, theta)
      return { top, lift: a[i] * Math.cos(top) + b[i] * Math.sin(top) - h0, kinks, land: landing(i, top) }
    }
    kinks.push({ theta: next, vertex: nj, h: a[i] * Math.cos(next) + b[i] * Math.sin(next) })
    i = nj
    theta = next
  }
  return { top: theta, lift: 0, kinks, land: theta + 1e-3 }
}
