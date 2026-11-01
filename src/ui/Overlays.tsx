import type { HitMode } from '../core/heatmap.ts'
import type { Outcome } from '../core/impact.ts'
import { BASE, cssGradient, NO_FLIP, poseColor } from '../viewer/colors.ts'
import type { ProbeResult } from '../worker/protocol.ts'
import { letter, sig } from './format.ts'

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
      <div className="muted small">Click the bot for details.</div>
    </div>
  )
}

const REASONS: Record<Outcome, string> = {
  ok: '',
  none: "A hit here in this direction doesn't tip the bot over any edge.",
  launch: 'This hit throws the bot into the air rather than tipping it. Airborne tumbling is not modelled.',
  lift: 'This hit lifts one end of the pivot edge, so the bot would pivot on a corner. Corner pivots are not modelled.',
  slide: 'Not enough floor friction: the bot slides instead of tipping.',
  returns: 'It tips, but rocks back into the same pose.',
}

export function ProbeCard({ probe, mode, rank, onClose }: { probe: ProbeResult, mode: HitMode, rank: number[], onClose: () => void }) {
  const unit = mode === 'impulse' ? 'N·s' : 'N'
  return (
    <div className="probe card">
      <button className="close" aria-label="Close" onClick={onClose}>×</button>
      {probe.value !== null ? (
        <>
          <div className="big">{sig(probe.value)} {unit}</div>
          <div>{mode === 'impulse' ? 'impulse' : 'steady push'} flips it here
            {probe.landing !== null && probe.landing >= 0 && (
              <> into <span className="swatch" style={{ background: poseColor(rank[probe.landing]) }} /> Pose {letter(rank[probe.landing])}</>
            )}
          </div>
          <div className="muted small">{probe.pivot?.kind === 'corner' ? 'Blue dot: the corner it pivots on.' : 'Blue line: the edge it tips over.'}</div>
          {probe.delivered !== null && (
            <div className={probe.delivered >= probe.value ? 'verdict bad' : 'verdict good'}>
              Weapon delivers {sig(probe.delivered)} N·s: {probe.delivered >= probe.value ? 'flips it' : `needs ${sig(probe.value / probe.delivered)}× more`}
            </div>
          )}
        </>
      ) : (
        <div>{probe.dir ? REASONS[probe.reason] : "This side can't be hit from the chosen direction."}</div>
      )}
    </div>
  )
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
      <p><strong>Hits</strong> paints how hard a hit at each point must be to flip the bot. Orbit the camera to choose where the hit comes from.</p>
      <h3>Assumptions</h3>
      <ul>
        <li>Rolling is slow (no momentum carries it past a pose).</li>
        <li>The weapon is not spinning (no gyroscopic effects).</li>
        <li>Tipping stays in one plane; new contacts don't bounce or slip.</li>
        <li>Friction and restitution are estimates; adjust them in the Hits view.</li>
      </ul>
    </div>
  )
}
