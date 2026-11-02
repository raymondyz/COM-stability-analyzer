import { GRAVITY } from './units.ts'
import { add, cross, dot, get, normalize, scale, type Vec3 } from './vec.ts'

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

// The bot's support along the great circle u(θ) = cos θ·n + sin θ·m: pivoting on
// hull vertex j, the COM sits a[j]·cos θ + b[j]·sin θ above the floor.
interface Circle {
  a: Float64Array
  b: Float64Array
  tol: number
  height: (j: number, theta: number) => number
  slope: (j: number, theta: number) => number
  nextKink: (i: number, theta: number) => [number, number]
}

function circle(V: Float64Array, count: number, n: Vec3, m: Vec3, start: number): Circle {
  const a = new Float64Array(count)
  const b = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const v = get(V, i)
    a[i] = dot(v, n)
    b[i] = dot(v, m)
  }
  const tol = 1e-12 * (Math.abs(a[start]) + 1e-9)
  const height = (j: number, th: number) => a[j] * Math.cos(th) + b[j] * Math.sin(th)
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
  return { a, b, tol, height, slope, nextKink }
}

// Tips the bot from rest on a face (outward normal n) about an axis along one of
// its edges, so the down vector follows u(θ) = cos θ·n + sin θ·m, where m is the
// face's outward in-plane direction across that edge. The COM height is the hull's
// support function along that great circle; this walks it to its first maximum,
// then on down to where the bot lands (momentum keeps it in the plane).
// V holds hull vertices relative to the COM; `start` is a vertex on the edge.
export function tipPath(V: Float64Array, count: number, n: Vec3, m: Vec3, start: number): TipPath {
  const { a, b, height, slope, nextKink } = circle(V, count, n, m, start)
  const h0 = a[start]
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
      return { top, lift: height(i, top) - h0, kinks, land: landing(i, top) }
    }
    kinks.push({ theta: next, vertex: nj, h: height(i, next) })
    i = nj
    theta = next
  }
  return { top: theta, lift: 0, kinks, land: theta + 1e-3 }
}

export interface TumbleStep {
  vertex: number    // the pivot
  from: number      // tilt range covered while on it
  to: number
}

export interface Tumble {
  steps: TumbleStep[]   // out to where it stops, then back into the well it settles in
  rest: number          // tilt it settles at: 0 is where it started, otherwise just short of a landing
  maxTilt: number
  tops: number          // tops it went over
  hardest: number       // most kinetic energy one impact absorbed, J (0 for pushes)
  complete: boolean     // false: still going after a full turn, past what the planar model covers
}

// Follows the planar tip path forward: the counterpart of the threshold spin in
// impact.ts, with gravity between contact changes and, at each one, a plastic impact
// that keeps angular momentum about the new pivot. The bot starts at rest on the face
// with spin omega0 about the first pivot, or with 'push': pushed slowly over the
// first top, after which it lands without carrying momentum on. IGa is the moment of
// inertia about the tipping axis through the COM.
export function tumble(V: Float64Array, count: number, n: Vec3, m: Vec3, start: number, IGa: number, mass: number, omega0: number | 'push'): Tumble {
  const { a, b, tol, height, slope, nextKink } = circle(V, count, n, m, start)
  const k = normalize(cross(n, m))
  const pivot = (j: number) => {
    const p = get(V, j)
    const r = add(scale(p, -1), scale(k, dot(p, k)))   // COM offset from the axis through j
    return { r, I: IGa + mass * dot(r, r) }
  }
  const mg = mass * GRAVITY
  const pushed = omega0 === 'push'
  const steps: TumbleStep[] = []
  let i = start
  let cur = pivot(i)
  let ke = pushed ? Infinity : 0.5 * cur.I * omega0 * omega0
  let theta = 0
  let tops = 0
  let well = 0        // tilt at the bottom of the well it is in
  let wellStep = 0    // steps taken when it got there
  let hardest = 0
  // Rocks back from where it stopped into the bottom of the well.
  const settle = (maxTilt: number): Tumble => {
    const back = steps.slice(wellStep).reverse().map((s) => ({ vertex: s.vertex, from: s.to, to: s.from }))
    return { steps: [...steps, ...back], rest: well, maxTilt, tops, hardest, complete: true }
  }

  for (let guard = 0; guard < 8 * count + 16 && theta <= 2 * Math.PI; guard++) {
    const [next, j] = nextKink(i, theta)
    if (j < 0) break
    if (slope(i, theta) > tol) {
      // Rising: to the top of this pivot's arc, or to the next contact if that comes first.
      let peak = Math.atan2(b[i], a[i])
      while (peak < theta) peak += 2 * Math.PI
      const end = Math.min(peak, next)
      const need = mg * (height(i, end) - height(i, theta))
      if (ke < need) {
        const stop = peak - Math.acos(Math.min(1, (height(i, theta) + ke / mg) / Math.hypot(a[i], b[i])))
        steps.push({ vertex: i, from: theta, to: stop })
        return settle(stop)
      }
      ke -= need
      steps.push({ vertex: i, from: theta, to: end })
      theta = end
      if (peak < next) {
        tops++
        continue
      }
    } else {
      // Falling until the next contact comes down.
      ke += mg * (height(i, theta) - height(i, next))
      steps.push({ vertex: i, from: theta, to: next })
      theta = next
      if (slope(j, next) >= 0) {
        // A landing: the bottom of a new well.
        well = next - 1e-6
        wellStep = steps.length
        if (pushed) return { steps, rest: well, maxTilt: theta, tops, hardest, complete: true }
      }
    }
    const nxt = pivot(j)
    if (!pushed) {
      const ratio = (IGa + mass * dot(cur.r, nxt.r)) / nxt.I
      const omega = Math.sqrt((2 * ke) / cur.I) * Math.max(ratio, 0)
      const after = 0.5 * nxt.I * omega * omega
      hardest = Math.max(hardest, ke - after)
      ke = after
      // Stopped dead by the impact: it stays unless the new contact is falling.
      if (ke <= 0 && slope(j, theta) >= 0) return settle(theta)
    }
    i = j
    cur = nxt
  }
  return { steps, rest: theta, maxTilt: theta, tops, hardest, complete: false }
}
