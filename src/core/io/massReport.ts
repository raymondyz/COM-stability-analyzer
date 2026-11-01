import type { MassProps } from '../types.ts'
import { LENGTH, MASS, type LengthUnit, type MassUnit } from '../units.ts'
import { symEigenvalues, type Mat3, type Vec3 } from '../vec.ts'

export interface ParsedMass {
  props: MassProps
  source: 'report' | 'json'
  notes: string[]           // things worth showing next to the values
  checks: string[]          // self-checks that passed
}

// Accepts either the text from SolidWorks' Mass Properties dialog (Copy to
// Clipboard) or the JSON sidecar format (spec §3.8).
export function parseMassInput(text: string): ParsedMass {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return parseSidecar(trimmed)
  return parseReport(trimmed)
}

const LENGTH_WORDS: Record<string, LengthUnit> = {
  millimeters: 'mm', millimetres: 'mm', centimeters: 'cm', centimetres: 'cm',
  meters: 'm', metres: 'm', inches: 'in', feet: 'ft',
}
const MASS_WORDS: Record<string, MassUnit> = { grams: 'g', kilograms: 'kg', pounds: 'lb' }

const NUM = '([-+]?\\d+(?:[.,]\\d+)?(?:[eE][-+]?\\d+)?)'
const num = (s: string) => parseFloat(s.replace(',', '.'))

function lengthUnit(word: string): number {
  const u = LENGTH_WORDS[word.trim().toLowerCase()]
  if (!u) throw new Error(`Unknown length unit "${word.trim()}".`)
  return LENGTH[u]
}

function massUnit(word: string): number {
  const u = MASS_WORDS[word.trim().toLowerCase()]
  if (!u) throw new Error(`Unknown mass unit "${word.trim()}".`)
  return MASS[u]
}

// "( grams * square millimeters )" → kg·m² per reported unit
function inertiaUnit(text: string): number {
  const m = /\(\s*(\w+)\s*\*\s*square\s+(\w+)\s*\)/i.exec(text)
  if (!m) throw new Error('Could not read the inertia units.')
  return massUnit(m[1]) * lengthUnit(m[2]) ** 2
}

function parseReport(text: string): ParsedMass {
  const notes: string[] = []
  const checks: string[] = []

  const massM = new RegExp(`Mass\\s*=\\s*${NUM}\\s*(\\w+)`, 'i').exec(text)
  if (!massM) throw new Error('No "Mass = …" line found. Paste the whole Mass Properties report.')
  const mass = num(massM[1]) * massUnit(massM[2])

  const comM = new RegExp(`Center of mass:\\s*\\(\\s*(\\w+)\\s*\\)\\s*X\\s*=\\s*${NUM}\\s*Y\\s*=\\s*${NUM}\\s*Z\\s*=\\s*${NUM}`, 'i').exec(text)
  if (!comM) throw new Error('No "Center of mass" block found.')
  const lu = lengthUnit(comM[1])
  const com: Vec3 = [num(comM[2]) * lu, num(comM[3]) * lu, num(comM[4]) * lu]

  let inertia: Mat3 | null = null
  const block = /Moments of inertia:[^\n]*\n?[^\n]*Taken at the center of mass and aligned with the output coordinate system[\s\S]*?Lzz\s*=\s*\S+/i.exec(text)
  if (block) {
    const iu = inertiaUnit(block[0])
    const get = (name: string, src: string) => {
      const m = new RegExp(`${name}\\s*=\\s*${NUM}`).exec(src)
      if (!m) throw new Error(`Missing ${name} in the inertia block.`)
      return num(m[1])
    }
    const L = (n: string) => get(n, block[0])
    // SolidWorks reports products in positive tensor notation (Lxy = +∫xy dm), so
    // the tensor's off-diagonal entries are their negatives.
    const raw: Mat3 = [
      L('Lxx'), -L('Lxy'), -L('Lxz'),
      -L('Lyx'), L('Lyy'), -L('Lyz'),
      -L('Lzx'), -L('Lzy'), L('Lzz'),
    ]
    inertia = raw.map((v) => v * iu) as Mat3

    const principal = /Principal axes of inertia[\s\S]*?Px\s*=\s*(\S+)[\s\S]*?Py\s*=\s*(\S+)[\s\S]*?Pz\s*=\s*(\S+)/i.exec(text)
    if (principal) {
      const p = [num(principal[1]), num(principal[2]), num(principal[3])].sort((a, b) => a - b)
      const e = symEigenvalues(raw)
      const rel = Math.max(...p.map((v, i) => Math.abs(v - e[i]) / Math.max(Math.abs(v), 1e-30)))
      if (rel > 1e-4) throw new Error('The inertia values don\'t match the principal moments. Check the paste.')
      checks.push('Inertia matches the principal moments')
    }
    const origin = /Taken at the output coordinate system[\s\S]*?Izz\s*=\s*\S+/i.exec(text)
    if (origin) {
      const I = (n: string) => get(n, origin[0])
      // Parallel axis in positive notation: Pxy(origin) = Lxy + m·x·y (report units)
      const mr = num(massM[1])
      const c = [num(comM[2]), num(comM[3]), num(comM[4])]
      const scaleRatio = massUnit(massM[2]) * lu * lu / iu
      const expect = (l: number, a: number, b: number) => l + mr * c[a] * c[b] * scaleRatio
      const pairs: [string, string, number, number][] = [['Lxy', 'Ixy', 0, 1], ['Lxz', 'Ixz', 0, 2], ['Lyz', 'Iyz', 1, 2]]
      const tolerance = 1e-4 * Math.max(Math.abs(L('Lxx')), Math.abs(L('Lyy')), Math.abs(L('Lzz')))
      for (const [l, o, a, b] of pairs) {
        if (Math.abs(expect(L(l), a, b) - I(o)) > tolerance) throw new Error('The inertia blocks disagree with each other. Check the paste.')
      }
      checks.push('Inertia is consistent with the origin block')
    }
  } else {
    notes.push('No inertia found; hit results will use an estimate.')
  }

  const cs = /Coordinate system:\s*(.+)/i.exec(text)
  if (cs && !/default/i.test(cs[1])) notes.push(`Reported in coordinate system "${cs[1].trim()}". The STL must be exported in the same one.`)
  if (/hidden components/i.test(text)) notes.push('Includes hidden components. Fine if they are all inside the bot.')

  return { props: { mass, com, inertia }, source: 'report', notes, checks }
}

function parseSidecar(text: string): ParsedMass {
  let j: { units?: { length?: string, mass?: string }, mass?: number, com?: number[], inertia?: number[][] }
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error('That looks like JSON but doesn\'t parse.')
  }
  const lu = LENGTH[(j.units?.length ?? 'm') as LengthUnit]
  const mu = MASS[(j.units?.mass ?? 'kg') as MassUnit]
  if (!lu || !mu) throw new Error('Unknown units in the JSON.')
  if (typeof j.mass !== 'number' || !Array.isArray(j.com) || j.com.length !== 3) throw new Error('The JSON needs "mass" and a 3-element "com".')
  const com = j.com.map((v) => v * lu) as Vec3
  const inertia = j.inertia ? (j.inertia.flat().map((v) => v * mu * lu * lu) as Mat3) : null
  if (inertia && inertia.length !== 9) throw new Error('"inertia" must be a 3 × 3 array.')
  return { props: { mass: j.mass * mu, com, inertia }, source: 'json', notes: inertia ? [] : ['No inertia given; hit results will use an estimate.'], checks: [] }
}

// Problems with an inertia tensor that make it physically impossible.
export function inertiaProblem(I: Mat3): string | null {
  const e = symEigenvalues(I)
  if (e[0] <= 0) return 'The inertia tensor isn\'t positive definite.'
  if (e[0] + e[1] < e[2] * (1 - 1e-6)) return 'The principal moments break the triangle inequality.'
  return null
}
