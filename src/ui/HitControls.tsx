import { poseColor } from '../viewer/colors.ts'
import { letter } from './format.ts'
import type { HitSettings } from './hitSettings.ts'

interface Props {
  value: HitSettings
  onChange: (v: HitSettings) => void
  inertiaEstimated: boolean
  rank: number[]              // display rank per pose index
  order: number[]             // pose indices by rank
  start: number               // starting pose index
  onStart: (pose: number) => void
  placed: boolean             // a hit point is on the bot
}

export function HitControls({ value: v, onChange, inertiaEstimated, rank, order, start, onStart, placed }: Props) {
  const set = <K extends keyof HitSettings>(k: K, x: HitSettings[K]) => onChange({ ...v, [k]: x })
  const num = (k: 'impulse' | 'force' | 'weaponMass' | 'weaponSpeed') => (e: { target: HTMLInputElement }) => set(k, Math.max(0, +e.target.value))
  return (
    <div className="hit-controls">
      <div className="label">Starting pose</div>
      <div className="chips" role="radiogroup" aria-label="Starting pose">
        {order.map((i) => (
          <button key={i} role="radio" aria-checked={i === start} onClick={() => onStart(i)}>
            <span className="swatch" style={{ background: poseColor(rank[i]) }} />{letter(rank[i])}
          </button>
        ))}
      </div>
      <div className="seg" role="radiogroup" aria-label="Kind of hit">
        <button role="radio" aria-checked={v.mode === 'impulse'} onClick={() => set('mode', 'impulse')} title="Spinners, hammers, fast impacts">Impact</button>
        <button role="radio" aria-checked={v.mode === 'push'} onClick={() => set('mode', 'push')} title="Wedges and lifters driving under the bot">Slow push</button>
      </div>
      <div className="seg" role="radiogroup" aria-label="Hit direction">
        <button role="radio" aria-checked={v.aim === 'heading'} onClick={() => set('aim', 'heading')} title="The hit comes from the heading and elevation below">Set heading</button>
        <button role="radio" aria-checked={v.aim === 'worst'} onClick={() => set('aim', 'worst')} title="For each point, the direction that tips the bot most easily">Worst direction</button>
      </div>
      {v.aim === 'heading' && (
        <Slider label="Heading" unit="°" min={0} max={359} step={1} value={v.heading} onChange={(x) => set('heading', x)} hint="0° runs along the bot" />
      )}
      <Slider label="Elevation" unit="°" min={-45} max={80} step={5} value={v.elevation} onChange={(x) => set('elevation', x)}
        hint={v.elevation === 0 ? 'horizontal' : v.elevation > 0 ? 'rising (wedge, flipper)' : 'downward'} />
      <Slider label="Floor friction μ" min={0.1} max={1.5} step={0.05} value={v.mu} onChange={(x) => set('mu', x)} />
      <fieldset>
        <legend>Hit strength</legend>
        {v.mode === 'push' ? (
          <label className="row">
            <span>Force</span>
            <input type="number" min={0} step={10} value={v.force} onChange={num('force')} />
            <span>N</span>
          </label>
        ) : (
          <>
            <div className="seg" role="radiogroup" aria-label="Strength as">
              <button role="radio" aria-checked={v.strength === 'impulse'} onClick={() => set('strength', 'impulse')}>Impulse</button>
              <button role="radio" aria-checked={v.strength === 'weapon'} onClick={() => set('strength', 'weapon')} title="The impulse depends on how heavy the bot feels at the hit point">Weapon</button>
            </div>
            {v.strength === 'impulse' ? (
              <label className="row">
                <span>Impulse</span>
                <input type="number" min={0} step={0.5} value={v.impulse} onChange={num('impulse')} />
                <span>N·s</span>
              </label>
            ) : (
              <>
                <label className="row">
                  <span title="For a spinner: its moment of inertia ÷ tip radius²">Effective mass</span>
                  <input type="number" min={0} step={0.1} value={v.weaponMass} onChange={num('weaponMass')} />
                  <span>kg</span>
                </label>
                <label className="row">
                  <span>Closing speed</span>
                  <input type="number" min={0} step={1} value={v.weaponSpeed} onChange={num('weaponSpeed')} />
                  <span>m/s</span>
                </label>
                <Slider label="Restitution e" min={0} max={1} step={0.05} value={v.e} onChange={(x) => set('e', x)} />
              </>
            )}
          </>
        )}
        {!placed && <p className="muted small">Click the bot to place the hit.</p>}
      </fieldset>
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
