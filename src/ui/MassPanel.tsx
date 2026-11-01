import { useState } from 'react'
import { inertiaProblem, parseMassInput } from '../core/io/massReport.ts'
import type { MassProps } from '../core/types.ts'
import { LENGTH, MASS, MASS_UNITS, type LengthUnit, type MassUnit } from '../core/units.ts'
import type { Mat3, Vec3 } from '../core/vec.ts'

export interface MassState {
  props: MassProps
  label: string
  notes: string[]
}

interface Props {
  units: LengthUnit
  centroid: Vec3 | null
  value: MassState | null
  onChange: (m: MassState | null) => void
}

type Tab = 'paste' | 'manual'

// Mass properties: paste the SolidWorks report (or JSON), or type the numbers in.
export function MassPanel({ units, centroid, value, onChange }: Props) {
  const [tab, setTab] = useState<Tab>('paste')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const paste = (t: string) => {
    setText(t)
    if (!t.trim()) {
      setError(null)
      return
    }
    try {
      const r = parseMassInput(t)
      const problem = r.props.inertia && inertiaProblem(r.props.inertia)
      if (problem) throw new Error(problem)
      setError(null)
      onChange({ props: r.props, label: r.source === 'report' ? 'SolidWorks report' : 'JSON', notes: [...r.checks.map((c) => `✓ ${c}`), ...r.notes] })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="mass">
      <div className="seg" role="tablist">
        <button role="tab" aria-selected={tab === 'paste'} onClick={() => setTab('paste')}>Paste report</button>
        <button role="tab" aria-selected={tab === 'manual'} onClick={() => setTab('manual')}>Enter values</button>
      </div>
      {tab === 'paste' ? (
        <>
          <textarea
            value={text}
            onChange={(e) => paste(e.target.value)}
            placeholder="In SolidWorks: Evaluate → Mass Properties → Copy to Clipboard, then paste here. JSON also works."
            rows={4}
            spellCheck={false}
          />
          {error && <p className="error">{error}</p>}
        </>
      ) : (
        <Manual units={units} centroid={centroid} value={value} onChange={onChange} />
      )}
      {value && <Summary value={value} units={units} />}
    </div>
  )
}

function Summary({ value, units }: { value: MassState, units: LengthUnit }) {
  const s = LENGTH[units]
  const c = value.props.com.map((v) => (v / s).toFixed(1)).join(', ')
  return (
    <div className="summary">
      <div><strong>{value.props.mass < 1 ? `${(value.props.mass * 1000).toFixed(0)} g` : `${value.props.mass.toFixed(3)} kg`}</strong> · COM ({c}) {units}</div>
      <div className="muted">
        From {value.label}. {value.props.inertia ? 'Inertia given.' : 'Inertia estimated from the mesh (uniform density).'}
      </div>
      {value.notes.map((n) => <div key={n} className="muted">{n}</div>)}
    </div>
  )
}

const INERTIA_KEYS = ['Lxx', 'Lyy', 'Lzz', 'Lxy', 'Lxz', 'Lyz'] as const

function Manual({ units, centroid, value, onChange }: Props) {
  const s = LENGTH[units]
  const [massUnit, setMassUnit] = useState<MassUnit>('g')
  const [mass, setMass] = useState(value ? String(+(value.props.mass / MASS[massUnit]).toFixed(4)) : '')
  const [com, setCom] = useState<string[]>(value ? value.props.com.map((v) => String(+(v / s).toFixed(4))) : ['', '', ''])
  const [inertia, setInertia] = useState<string[]>(['', '', '', '', '', ''])
  const [error, setError] = useState<string | null>(null)

  const apply = (m = mass, c = com, I = inertia, mu = massUnit) => {
    const mv = parseFloat(m) * MASS[mu]
    const cv = c.map((v) => parseFloat(v) * s)
    if (!(mv > 0) || cv.some((v) => !Number.isFinite(v))) {
      setError(null)
      return
    }
    let tensor: Mat3 | null = null
    if (I.some((v) => v.trim() !== '')) {
      const iv = I.map((v) => (v.trim() === '' ? 0 : parseFloat(v)))
      if (iv.some((v) => !Number.isFinite(v))) return setError('Inertia values must be numbers.')
      const k = MASS[mu] * s * s
      const [xx, yy, zz, xy, xz, yz] = iv.map((v) => v * k)
      tensor = [xx, -xy, -xz, -xy, yy, -yz, -xz, -yz, zz]
      const problem = inertiaProblem(tensor)
      if (problem) return setError(problem)
    }
    setError(null)
    onChange({ props: { mass: mv, com: cv as Vec3, inertia: tensor }, label: 'manual entry', notes: [] })
  }

  return (
    <div className="manual">
      <label className="row">
        <span>Mass</span>
        <input inputMode="decimal" value={mass} onChange={(e) => { setMass(e.target.value); apply(e.target.value) }} />
        <select value={massUnit} onChange={(e) => { const u = e.target.value as MassUnit; setMassUnit(u); apply(mass, com, inertia, u) }}>
          {MASS_UNITS.map((u) => <option key={u}>{u}</option>)}
        </select>
      </label>
      <div className="row">
        <span>COM ({units})</span>
        {['x', 'y', 'z'].map((axis, i) => (
          <input
            key={axis}
            aria-label={`COM ${axis}`}
            placeholder={axis}
            inputMode="decimal"
            value={com[i]}
            onChange={(e) => {
              const c = com.map((v, j) => (j === i ? e.target.value : v))
              setCom(c)
              apply(mass, c)
            }}
          />
        ))}
      </div>
      {centroid && (
        <button
          className="link"
          onClick={() => {
            const c = centroid.map((v) => String(+(v / s).toFixed(3)))
            setCom(c)
            apply(mass, c)
          }}
        >
          Use the model's centroid (uniform density)
        </button>
      )}
      <details>
        <summary>Inertia (optional, about the COM, {massUnit}·{units}²)</summary>
        <p className="muted">Products in SolidWorks' sign convention (Lxy = +∫xy dm).</p>
        <div className="grid3">
          {INERTIA_KEYS.map((k, i) => (
            <label key={k}>
              <span>{k}</span>
              <input
                inputMode="decimal"
                value={inertia[i]}
                onChange={(e) => {
                  const I = inertia.map((v, j) => (j === i ? e.target.value : v))
                  setInertia(I)
                  apply(mass, com, I)
                }}
              />
            </label>
          ))}
        </div>
      </details>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
