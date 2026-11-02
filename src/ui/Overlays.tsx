import type { HitMode } from '../core/heatmap.ts'
import { BASE, cssGradient, NO_FLIP, poseColor } from '../viewer/colors.ts'
import type { HitResult, ProbeResult } from '../worker/protocol.ts'
import { deg, joules, letter, sig } from './format.ts'

export function Busy({ stage, fraction }: { stage: string, fraction: number }) {
  return (
    <div className="busy" role="status">
      <span>{stage}</span>
      <progress value={fraction} max={1} />
    </div>
  )
}

export function Empty({ onOpen, onSample }: { onOpen: () => void, onSample: () => void }) {
  return (
    <div className="empty">
      <h2>Drop an STL or OBJ here</h2>
      <p>Export the whole assembly as one file, with "Do not translate STL output data to positive space" ticked.</p>
      <div className="actions">
        <button className="primary" onClick={onOpen}>Open a file</button>
        <button onClick={onSample}>Try the sample bot</button>
      </div>
      <p className="muted small">Everything runs in your browser. Files never leave this computer.</p>
    </div>
  )
}

export function Legend({ range, mode }: { range: [number, number] | null, mode: HitMode }) {
  const unit = mode === 'impulse' ? 'N·s' : 'N'
  return (
    <div className="legend">
      <div className="legend-title">{mode === 'impulse' ? 'Impulse needed to flip' : 'Push force needed to flip'}</div>
      {range ? (
        <>
          <div className="ramp" style={{ background: cssGradient() }} />
          <div className="ramp-labels"><span>{sig(range[0])} {unit}</span><span>{sig(range[1])}+ {unit}</span></div>
        </>
      ) : <p className="small">No point flips from this direction: hits slide or lift the bot instead. Try a rising hit (raise the elevation).</p>}
      <div className="key"><span className="swatch" style={{ background: NO_FLIP }} />Can't flip from here</div>
      <div className="key"><span className="swatch" style={{ background: BASE }} />Faces away from the hit</div>
      <div className="muted small">Click the bot to test a hit there.</div>
    </div>
  )
}

const REASONS: Record<ProbeResult['reason'], string> = {
  ok: '',
  away: 'This side faces away from the hit. Turn the hit, or pick a point that faces it.',
  none: "A hit here in this direction doesn't tip the bot over any edge or corner.",
  launch: 'This hit throws the bot into the air rather than tipping it. Airborne tumbling is not modelled.',
  lift: "This hit lifts the bot in a way neither an edge nor a corner pivot explains, so the model can't say what happens.",
  slide: 'Not enough floor friction: the bot slides instead of tipping.',
  returns: 'It tips, but rocks back into the same pose.',
}

const PoseName = ({ pose, rank }: { pose: number, rank: number[] }) => (
  <><span className="swatch" style={{ background: poseColor(rank[pose]) }} />Pose {letter(rank[pose])}</>
)

// What the placed hit does to the bot, starting at rest in pose `start`.
// escapeOf gives the energy it takes to leave a pose (null: no way out).
export function HitCard({ probe, mode, weapon, rank, start, escapeOf, onShow, onClose }: {
  probe: ProbeResult, mode: HitMode, weapon: boolean, rank: number[], start: number,
  escapeOf: (pose: number) => number | null, onShow: () => void, onClose: () => void,
}) {
  const unit = mode === 'impulse' ? 'N·s' : 'N'
  const r = probe.result
  const { value, applied } = probe
  const escape = escapeOf(start)
  // A landing that soaks up more than it takes to leave the final pose could bounce it on.
  const leave = r && r.pose >= 0 ? escapeOf(r.pose) : null
  return (
    <div className="probe card">
      <button className="close" aria-label="Remove the hit" onClick={onClose}>×</button>
      {r && value !== null && applied !== null ? (
        <>
          <div className="big">
            {r.pose < 0 ? 'Keeps tumbling' : <>{r.pose === start ? 'Stays in' : 'Ends in'} <PoseName pose={r.pose} rank={rank} /></>}
          </div>
          <div>{motion(r, mode, applied >= value)}</div>
          <dl className="facts">
            <dt>This hit</dt>
            <dd>{sig(applied)} {unit}{weapon && <span className="muted"> from the weapon</span>}</dd>
            <dt>Tips it out</dt>
            <dd>
              at {sig(value)} {unit}
              <span className="muted"> ({applied >= value ? `${sig(applied / value)}× that` : `${sig(value / applied)}× short`})</span>
              {probe.landing !== null && probe.landing >= 0 && probe.landing !== start && (
                <div className="muted">Just enough lands it in <PoseName pose={probe.landing} rank={rank} /></div>
              )}
            </dd>
            {r.energy !== null && (
              <>
                <dt>Energy given</dt>
                <dd>{joules(r.energy)}{escape !== null && <span className="muted"> (the cheapest way out takes {joules(escape)})</span>}</dd>
              </>
            )}
          </dl>
          <div className="muted small">{probe.pivot?.kind === 'corner' ? 'Blue dot: the corner it pivots on.' : 'Blue line: the edge it tips over.'}</div>
          {leave !== null && r.hardest > leave && (
            <p className="caution">
              One landing absorbs {joules(r.hardest)}, more than the {joules(leave)} it takes to leave <PoseName pose={r.pose} rank={rank} />.
              The model assumes the floor soaks that up; a real bot may bounce on.
            </p>
          )}
          {r.complete && r.segments.length > 0 && <button className="show" onClick={onShow}>▶ Show the motion</button>}
        </>
      ) : (
        <div>{REASONS[probe.reason]}</div>
      )}
    </div>
  )
}

function motion(r: HitResult, mode: HitMode, enough: boolean): string {
  if (!r.complete) return 'Still tumbling after a full turn, past what the rolling model covers.'
  if (mode === 'push') return enough ? 'Pushed over, then rolls to rest.' : 'Not enough to push it over.'
  if (r.tops === 0) return r.maxTilt < 0.01 ? 'Barely moves.' : `Tips ${deg(r.maxTilt)}, then rocks back.`
  // The angle, not the number of tops: a faceted wheel puts a small top at every facet.
  return `Tips over and turns ${deg(r.maxTilt)} before it settles.`
}

export function RollBar({ time, total, landing, rank, onScrub, onReplay, onReset }: {
  time: number, total: number, landing: number | null, rank: number[], onScrub: (t: number) => void, onReplay: () => void, onReset: () => void,
}) {
  return (
    <div className="rollbar card">
      <button onClick={onReplay} aria-label="Replay">↻</button>
      <input type="range" min={0} max={total} step={0.01} value={time} onChange={(e) => onScrub(+e.target.value)} aria-label="Scrub the roll" />
      <span className="landing">
        {landing !== null && landing >= 0 ? (
          <>Lands in <span className="swatch" style={{ background: poseColor(rank[landing]) }} /> Pose {letter(rank[landing])}</>
        ) : 'Rolling…'}
      </span>
      <button onClick={onReset}>Reset</button>
    </div>
  )
}

export function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="help card" role="dialog" aria-label="Help">
      <button className="close" aria-label="Close" onClick={onClose}>×</button>
      <h2>How to read this</h2>
      <p><strong>Poses</strong> are the ways the bot can rest. The pink dot is the center of mass; the outline on the floor is what it rests on. "Lands" is the share of random starting orientations that roll to each pose.</p>
      <p><strong>Escape</strong> is the least energy that knocks it out of a pose. <strong>Tilt</strong> is how far it can lean before tipping.</p>
      <p><strong>Basins</strong>: each point on the shell means "start with this side facing the floor". Its color is the pose the bot rolls into. Click it to watch.</p>
      <p><strong>Hits</strong> paints how hard a hit at each point must be to flip the bot. Set the heading and elevation to choose where the hit comes from.</p>
      <p>To test one hit, pick the starting pose, click the bot where it's hit, then set the heading, elevation and strength. The card says where the bot ends up, and "Show the motion" plays it.</p>
      <h3>Assumptions</h3>
      <ul>
        <li>Rolling is slow (no momentum carries it past a pose), except right after a hit, where the hit's momentum is followed until it runs out.</li>
        <li>The weapon is not spinning (no gyroscopic effects).</li>
        <li>Tipping stays in one plane; new contacts don't bounce or slip.</li>
        <li>Friction and restitution are estimates; adjust them in the Hits view.</li>
      </ul>
    </div>
  )
}
