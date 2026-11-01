import type { HitSettings } from './hitSettings.ts'

interface Props {
  value: HitSettings
  onChange: (v: HitSettings) => void
  inertiaEstimated: boolean
}

export function HitControls({ value: v, onChange, inertiaEstimated }: Props) {
  const set = <K extends keyof HitSettings>(k: K, x: HitSettings[K]) => onChange({ ...v, [k]: x })
  return (
    <div className="hit-controls">
      <div className="seg" role="radiogroup" aria-label="Kind of hit">
        <button role="radio" aria-checked={v.mode === 'impulse'} onClick={() => set('mode', 'impulse')} title="Spinners, hammers, fast impacts">Impact</button>
        <button role="radio" aria-checked={v.mode === 'push'} onClick={() => set('mode', 'push')} title="Wedges and lifters driving under the bot">Slow push</button>
      </div>
      <div className="seg" role="radiogroup" aria-label="Hit direction">
        <button role="radio" aria-checked={v.dirMode === 'camera'} onClick={() => set('dirMode', 'camera')} title="The hit comes from where you're looking. Orbit to change it.">From camera</button>
        <button role="radio" aria-checked={v.dirMode === 'worst'} onClick={() => set('dirMode', 'worst')} title="For each point, the direction that flips the bot most easily">Worst direction</button>
      </div>
      <Slider label="Elevation" unit="°" min={-45} max={80} step={5} value={v.elevation} onChange={(x) => set('elevation', x)}
        hint={v.elevation === 0 ? 'horizontal' : v.elevation > 0 ? 'rising (wedge, flipper)' : 'downward'} />
      <Slider label="Floor friction μ" min={0.1} max={1.5} step={0.05} value={v.mu} onChange={(x) => set('mu', x)} />
      {v.mode === 'impulse' && (
        <>
          <Slider label="Restitution e" min={0} max={1} step={0.05} value={v.e} onChange={(x) => set('e', x)} />
          <fieldset>
            <legend>Weapon (for a clicked point)</legend>
            <label className="row">
              <span title="For a spinner: its moment of inertia ÷ tip radius²">Effective mass</span>
              <input type="number" min={0} step={0.1} value={v.weaponMass} onChange={(e) => set('weaponMass', Math.max(0, +e.target.value))} />
              <span>kg</span>
            </label>
            <label className="row">
              <span>Closing speed</span>
              <input type="number" min={0} step={1} value={v.weaponSpeed} onChange={(e) => set('weaponSpeed', Math.max(0, +e.target.value))} />
              <span>m/s</span>
            </label>
          </fieldset>
        </>
      )}
      {inertiaEstimated && <p className="muted small">Inertia is estimated from the mesh (uniform density). Paste the SolidWorks report for real values.</p>}
    </div>
  )
}

function Slider(p: { label: string, unit?: string, min: number, max: number, step: number, value: number, onChange: (x: number) => void, hint?: string }) {
  return (
    <label className="slider">
      <span>{p.label}</span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(+e.target.value)} />
      <output>{p.value}{p.unit ?? ''}{p.hint ? <span className="muted"> {p.hint}</span> : null}</output>
    </label>
  )
}
