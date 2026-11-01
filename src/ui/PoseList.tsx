import { GRAVITY } from '../core/units.ts'
import { poseColor } from '../viewer/colors.ts'
import type { AnalysisResult } from '../worker/protocol.ts'
import { deg, joules, letter, mm, pct } from './format.ts'

interface Props {
  analysis: AnalysisResult | null
  rank: number[]              // display rank per pose index
  order: number[]             // pose indices by rank
  selected: number
  onSelect: (pose: number) => void
  mass: number | null
  threshold: number
  onThreshold: (m: number) => void
  status: string | null
  error: string | null
}

export function PoseList({ analysis, rank, order, selected, onSelect, mass, threshold, onThreshold, status, error }: Props) {
  const energy = (lift: number) => (mass ? joules(mass * GRAVITY * lift) : mm(lift))
  const euler = analysis?.euler
  const ok = euler && euler.stable - euler.saddles + euler.maxima === 2
  return (
    <section className="poses">
      <header>
        <h2>Resting poses</h2>
        {euler && (
          <span
            className={ok ? 'badge ok' : 'badge warn'}
            title={`Stable faces ${euler.stable} − saddles ${euler.saddles} + peaks ${euler.maxima} = ${euler.stable - euler.saddles + euler.maxima} (should be 2)`}
          >
            {ok ? 'Topology ✓' : 'Topology check failed'}
          </span>
        )}
      </header>
      {error && <p className="error">{error}</p>}
      {!analysis && !error && <p className="muted">{status ?? 'Load a model and its mass properties to see how it rests.'}</p>}
      {analysis && (
        <>
          <table>
            <thead>
              <tr>
                <th>Pose</th>
                <th title="Share of random starting orientations that roll to this pose">Lands</th>
                <th title="Smallest energy that knocks the bot out of this pose (COM rise in brackets)">Escape</th>
                <th title="How far it can be tilted before it tips over">Tilt</th>
              </tr>
            </thead>
            <tbody>
              {order.map((i) => {
                const p = analysis.poses[i]
                return (
                  <tr key={p.face} className={i === selected ? 'selected' : ''} onClick={() => onSelect(i)}>
                    <td>
                      <span className="swatch" style={{ background: poseColor(rank[i]) }} />
                      <button className="pose-name" aria-pressed={i === selected}>Pose {letter(rank[i])}</button>
                    </td>
                    <td>{pct(p.probability)}</td>
                    <td>{p.escape ? <>{energy(p.escape.lift)} <span className="muted">({mm(p.escape.lift)})</span></> : '—'}</td>
                    <td>{deg(p.tilt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {analysis.poses[selected] && (
            <Detail analysis={analysis} pose={selected} rank={rank} energy={energy} />
          )}
          {!analysis.final && <p className="muted small">Refining… ({status})</p>}
        </>
      )}
      <label className="row threshold" title="Faceted curves (tires, fillets) create many tiny wells. Poses that take less COM lift than this to escape are folded into their neighbour.">
        <span>Fold poses shallower than</span>
        <input
          type="number"
          min={0}
          step={0.1}
          value={+(threshold * 1000).toFixed(3)}
          onChange={(e) => onThreshold(Math.max(0, parseFloat(e.target.value) || 0) / 1000)}
        />
        <span>mm</span>
      </label>
    </section>
  )
}

function Detail({ analysis, pose, rank, energy }: { analysis: AnalysisResult, pose: number, rank: number[], energy: (lift: number) => string }) {
  const p = analysis.poses[pose]
  const P = analysis.poses.length
  const others = analysis.poses
    .map((_, j) => j)
    .filter((j) => j !== pose && Number.isFinite(analysis.lift[pose * P + j]))
    .sort((a, b) => rank[a] - rank[b])
  return (
    <div className="detail">
      <dl>
        <dt>COM height</dt><dd>{mm(p.height)}</dd>
        <dt>COM inset from edge</dt><dd>{mm(p.inset)}</dd>
        {p.escape && <><dt>Cheapest exit</dt><dd>to Pose {letter(rank[p.escape.to])}, {energy(p.escape.lift)}</dd></>}
        {p.folded > 0 && <><dt>Includes</dt><dd>{p.folded} shallow {p.folded === 1 ? 'pose' : 'poses'}</dd></>}
      </dl>
      {others.length > 0 && (
        <>
          <h3>Energy to reach</h3>
          <ul className="reach">
            {others.map((j) => (
              <li key={j}>
                <span className="swatch" style={{ background: poseColor(rank[j]) }} />
                Pose {letter(rank[j])}: {energy(analysis.lift[pose * P + j])}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
