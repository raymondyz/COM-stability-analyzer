import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { HitMode } from './core/heatmap.ts'
import { LENGTH, LENGTH_UNITS, type LengthUnit } from './core/units.ts'
import type { Vec3 } from './core/vec.ts'
import { HitControls } from './ui/HitControls.tsx'
import { HIT_DEFAULTS, type HitSettings } from './ui/hitSettings.ts'
import { MassPanel, type MassState } from './ui/MassPanel.tsx'
import { Busy, Empty, Help, Legend, ProbeCard, RollBar } from './ui/Overlays.tsx'
import { PoseList } from './ui/PoseList.tsx'
import { heatColors, heatRange } from './viewer/colors.ts'
import { Viewer, type ViewMode } from './viewer/Viewer.ts'
import { Analyzer } from './worker/client.ts'
import type { AnalysisResult, HitDirection, LoadResult, ProbeResult, RollResult } from './worker/protocol.ts'

const SAMPLE_LABEL = 'the sample bot'
const VIEWS: { id: ViewMode, label: string, hint: string }[] = [
  { id: 'poses', label: 'Poses', hint: 'How the bot rests' },
  { id: 'basins', label: 'Basins', hint: 'Where each starting orientation rolls to' },
  { id: 'hits', label: 'Hits', hint: 'How hard a hit must be to flip it' },
]

export default function App() {
  const analyzer = useMemo(() => new Analyzer(), [])
  const canvasRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [units, setUnits] = useState<LengthUnit>('mm')
  const [model, setModel] = useState<LoadResult | null>(null)
  const [busy, setBusy] = useState<{ stage: string, fraction: number } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mass, setMass] = useState<MassState | null>(null)
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [analysisStatus, setAnalysisStatus] = useState<string | null>(null)
  const [selectedFace, setSelectedFace] = useState<number | null>(null)
  const [view, setView] = useState<ViewMode>('poses')
  const [threshold, setThreshold] = useState(0.0005)
  const [highPrecision, setHighPrecision] = useState(false)
  const [hit, setHit] = useState<HitSettings>(HIT_DEFAULTS)
  const [cameraTick, setCameraTick] = useState(0)
  const [heat, setHeat] = useState<{ values: Float32Array, mode: HitMode } | null>(null)
  const [heatStatus, setHeatStatus] = useState<{ stage: string, fraction: number } | null>(null)
  // Clicks and their results are tagged with the pose they belong to, so changing
  // pose hides them without resetting state in an effect.
  const [ray, setRay] = useState<{ origin: Vec3, dir: Vec3, pose: string } | null>(null)
  const [probe, setProbe] = useState<{ result: ProbeResult | null, ray: object } | null>(null)
  const [rollTime, setRollTime] = useState<{ time: number, total: number } | null>(null)
  const [rollLanding, setRollLanding] = useState<{ pose: number, key: string } | null>(null)
  const [help, setHelp] = useState(false)
  const [inputsOpen, setInputsOpen] = useState({ model: true, mass: true })

  // The viewer lives for the whole session.
  useEffect(() => {
    const v = new Viewer(canvasRef.current!)
    viewerRef.current = v
    v.onCameraSettled = () => setCameraTick((t) => t + 1)
    v.onAnimTime = (time, total) => setRollTime(total > 0 ? { time, total } : null)
    return () => {
      v.dispose()
      viewerRef.current = null
    }
  }, [])
  useEffect(() => () => analyzer.dispose(), [analyzer])

  const load = useCallback(async (f: File | null, u: LengthUnit) => {
    setBusy({ stage: 'Reading file', fraction: 0 })
    setLoadError(null)
    try {
      const res = await analyzer.request<LoadResult>(
        { kind: 'load', file: f, name: f?.name ?? 'Sample bot', unitScale: f ? LENGTH[u] : 1e-3 },
        { onProgress: (stage, fraction) => setBusy({ stage, fraction }) },
      )
      if (!res) return
      setModel(res)
      setAnalysis(null)
      setAnalysisError(null)
      setHeat(null)
      setRay(null)
      setSelectedFace(null)
      setMass((m) => (res.sampleMass ? { props: res.sampleMass, label: SAMPLE_LABEL, notes: [] } : m?.label === SAMPLE_LABEL ? null : m))
    } catch (e) {
      setLoadError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }, [analyzer])

  const openFile = (f: File) => {
    setFile(f)
    load(f, units)
  }
  const openSample = () => {
    setFile(null)
    load(null, units)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const f = e.dataTransfer.files[0]
    if (f) openFile(f)
  }

  // Model and COM into the viewer.
  useEffect(() => {
    if (model) viewerRef.current?.setModel(model.positions, model.indices, model.normals, model.hullVerts, model.size)
  }, [model])
  const com = useMemo(() => mass?.props.com ?? model?.centroid ?? null, [mass, model])
  useEffect(() => {
    if (model && com) viewerRef.current?.setCom(com)
  }, [model, com])

  // Rerun the statics whenever the COM or the settings that shape them change.
  useEffect(() => {
    if (!model || !mass) return
    let live = true
    const t = setTimeout(async () => {
      setAnalysisStatus('Finding resting poses')
      try {
        const res = await analyzer.request<AnalysisResult>(
          { kind: 'analyze', com: mass.props.com, threshold, level: highPrecision ? 7 : 6 },
          {
            onPartial: (d) => live && setAnalysis(d as AnalysisResult),
            onProgress: (stage, f) => live && setAnalysisStatus(`${stage}, ${Math.round(f * 100)}%`),
          },
        )
        if (!live || !res) return
        setAnalysis(res)
        setAnalysisError(null)
        setAnalysisStatus(null)
        setInputsOpen({ model: false, mass: false })
      } catch (e) {
        if (!live) return
        setAnalysis(null)
        setAnalysisError((e as Error).message)
        setAnalysisStatus(null)
      }
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [analyzer, model, mass, threshold, highPrecision])

  const order = useMemo(() => {
    if (!analysis) return []
    return analysis.poses.map((_, i) => i).sort((a, b) => analysis.poses[b].probability - analysis.poses[a].probability)
  }, [analysis])
  const rank = useMemo(() => {
    const r: number[] = []
    order.forEach((p, i) => (r[p] = i))
    return r
  }, [order])
  const found = analysis ? analysis.poses.findIndex((p) => p.face === selectedFace) : -1
  const selected = found >= 0 ? found : order[0] ?? 0
  const pose = analysis?.poses[selected] ?? null
  const poseKey = pose && analysis ? `${analysis.version}:${pose.face}` : ''

  const activeRay = ray && ray.pose === poseKey ? ray : null
  const landing = rollLanding && rollLanding.key === poseKey ? rollLanding.pose : null
  const shownProbe = view === 'hits' && activeRay && probe?.ray === activeRay ? probe.result : null

  useEffect(() => {
    viewerRef.current?.showPose(pose ? { down: pose.down, height: pose.height, support: pose.support } : null, false)
  }, [pose])

  useEffect(() => {
    if (!analysis) return
    const d = new Int16Array(analysis.basin.length)
    for (let i = 0; i < d.length; i++) d[i] = analysis.basin[i] >= 0 ? rank[analysis.basin[i]] : -1
    viewerRef.current?.setBasins(analysis.basinLevel, d)
  }, [analysis, rank])

  useEffect(() => viewerRef.current?.setMode(view), [view])

  // Clicks in the viewport: the shell in Basins, the bot in Hits.
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    v.onShellClick = async (down) => {
      if (!analysis) return
      setRollLanding(null)
      const res = await analyzer.request<RollResult>({ kind: 'roll', version: analysis.version, down })
      if (res) {
        v.playRoll(down, res.segments)
        setRollLanding({ pose: res.pose, key: poseKey })
      }
    }
    v.onBodyClick = (r) => setRay({ ...r, pose: poseKey })
  })

  // The camera position is read when this is called, so callers re-run on cameraTick.
  const hitDirection = useCallback((): HitDirection => {
    const elev = (hit.elevation * Math.PI) / 180
    return hit.dirMode === 'worst' ? { kind: 'worst', elevation: elev } : { kind: 'fixed', d: viewerRef.current!.cameraHitDirection(elev) }
  }, [hit.dirMode, hit.elevation])
  const cameraDep = hit.dirMode === 'camera' ? cameraTick : 0

  // Heatmap for the selected pose and hit settings.
  useEffect(() => {
    if (view !== 'hits' || !analysis || !mass || !pose) return
    let live = true
    const dir = hitDirection()
    const t = setTimeout(async () => {
      try {
        const values = await analyzer.request<Float32Array>(
          { kind: 'heatmap', version: analysis.version, pose: selected, mass: mass.props, hit: { mode: hit.mode, mu: hit.mu, dir } },
          {
            onProgress: (stage, fraction) => live && fraction < 1 && setHeatStatus({ stage, fraction }),
            onPartial: (d) => live && setHeat({ values: d as Float32Array, mode: hit.mode }),
          },
        )
        if (live && values) setHeat({ values, mode: hit.mode })
      } catch {
        // A newer analysis replaced this one; the next run repaints.
      } finally {
        if (live) setHeatStatus(null)
      }
    }, 80)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [analyzer, view, analysis, selected, mass, pose, hit.mode, hit.mu, hitDirection, cameraDep])

  const heatScale = useMemo(() => (heat ? heatRange(heat.values) : null), [heat])
  useEffect(() => {
    viewerRef.current?.setHeat(view === 'hits' && heat ? heatColors(heat.values, ...(heatScale ?? [1, 2])) : null)
  }, [heat, heatScale, view])

  // Probe at the clicked point; refreshed when the hit settings change.
  useEffect(() => {
    if (view !== 'hits' || !activeRay || !analysis || !mass) return
    let live = true
    analyzer.request<ProbeResult | null>({
      kind: 'probe',
      version: analysis.version,
      pose: selected,
      mass: mass.props,
      hit: { mode: hit.mode, mu: hit.mu, dir: hitDirection() },
      ray: { origin: activeRay.origin, dir: activeRay.dir },
      weapon: { mass: hit.weaponMass, speed: hit.weaponSpeed, restitution: hit.e },
    }).then((result) => live && setProbe({ result, ray: activeRay }), () => live && setProbe({ result: null, ray: activeRay }))
    return () => {
      live = false
    }
  }, [analyzer, activeRay, view, analysis, selected, mass, hit, hitDirection, cameraDep])

  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    if (view !== 'hits') return
    v.setProbe(shownProbe ? { point: shownProbe.point, dir: shownProbe.dir, pivot: shownProbe.pivot } : null)
    const dir = hitDirection()
    if (shownProbe?.dir) v.setArrow(shownProbe.dir, shownProbe.point)
    else if (dir.kind === 'fixed' && pose) v.setArrow(dir.d)
    else v.setArrow(null)
  }, [shownProbe, view, hitDirection, cameraDep, pose])

  const inertiaEstimated = !!mass && !mass.props.inertia
  const settingsTitle = view === 'basins' ? 'Basins' : 'Hit settings'

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="topbar">
        <h1>Stability Analyzer</h1>
        {model && <span className="file muted">{model.name} · {model.triangles.toLocaleString()} triangles</span>}
        <div className="spacer" />
        <button onClick={() => fileInput.current?.click()}>Open…</button>
        <button className="icon" aria-label="Help" aria-pressed={help} onClick={() => setHelp((h) => !h)}>?</button>
        <input
          ref={fileInput}
          type="file"
          accept=".stl,.STL,.obj,.OBJ"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) openFile(f)
            e.target.value = ''
          }}
        />
      </header>
      <div className="main">
        <aside className="panel">
          <details open={inputsOpen.model} onToggle={(e) => setInputsOpen((o) => ({ ...o, model: (e.target as HTMLDetailsElement).open }))}>
            <summary>Model {model && <span className="muted">· {model.name}</span>}</summary>
            <div className="section">
              {model ? (
                <p className="muted small">
                  {model.triangles.toLocaleString()} triangles, {(model.hullVerts.length / 3).toLocaleString()} hull vertices, loaded in {Math.round(model.ms)} ms.
                </p>
              ) : <p className="muted small">Open or drop an STL or OBJ of the whole bot.</p>}
              <label className="row">
                <span>File units</span>
                <select
                  value={units}
                  disabled={!!model && !file}
                  onChange={(e) => {
                    const u = e.target.value as LengthUnit
                    setUnits(u)
                    if (file) load(file, u)
                  }}
                >
                  {LENGTH_UNITS.map((u) => <option key={u}>{u}</option>)}
                </select>
              </label>
              <div className="actions">
                <button onClick={() => fileInput.current?.click()}>Open a file</button>
                <button onClick={openSample}>Sample bot</button>
              </div>
            </div>
          </details>
          <details open={inputsOpen.mass} onToggle={(e) => setInputsOpen((o) => ({ ...o, mass: (e.target as HTMLDetailsElement).open }))}>
            <summary>Mass properties {mass && <span className="muted">· {mass.props.mass < 1 ? `${(mass.props.mass * 1000).toFixed(0)} g` : `${mass.props.mass.toFixed(2)} kg`}</span>}</summary>
            <div className="section">
              <MassPanel units={units} centroid={model?.centroid ?? null} value={mass} onChange={setMass} />
            </div>
          </details>
          {view !== 'poses' && (
            <details open>
              <summary>{settingsTitle}</summary>
              <div className="section">
                {view === 'basins' ? (
                  <>
                    <p className="muted small">Each point on the shell means "start with this side facing the floor". Click one to watch it roll.</p>
                    <label className="check">
                      <input type="checkbox" checked={highPrecision} onChange={(e) => setHighPrecision(e.target.checked)} />
                      High precision (164k samples instead of 41k)
                    </label>
                  </>
                ) : (
                  <HitControls value={hit} onChange={setHit} inertiaEstimated={inertiaEstimated} />
                )}
              </div>
            </details>
          )}
          <PoseList
            analysis={analysis}
            rank={rank}
            order={order}
            selected={selected}
            onSelect={(i) => analysis && setSelectedFace(analysis.poses[i].face)}
            mass={mass?.props.mass ?? null}
            threshold={threshold}
            onThreshold={setThreshold}
            status={model ? (mass ? analysisStatus : 'Add mass properties to analyze.') : null}
            error={analysisError}
          />
        </aside>
        <section className="viewport">
          <div className="canvas" ref={canvasRef} />
          {model && (
            <nav className="tabs" aria-label="View">
              {VIEWS.map((v) => (
                <button key={v.id} aria-pressed={view === v.id} title={v.hint} onClick={() => setView(v.id)} disabled={!analysis && v.id !== 'poses'}>
                  {v.label}
                </button>
              ))}
            </nav>
          )}
          {!model && !busy && <Empty onOpen={() => fileInput.current?.click()} onSample={openSample} />}
          {busy && <Busy {...busy} />}
          {loadError && <div className="banner error" role="alert">{loadError}</div>}
          {view === 'hits' && heat && <Legend range={heatScale} mode={heat.mode} />}
          {view === 'hits' && heatStatus && <div className="mini-busy">{heatStatus.stage}…</div>}
          {shownProbe && <ProbeCard probe={shownProbe} mode={hit.mode} rank={rank} onClose={() => setRay(null)} />}
          {view === 'hits' && analysis && !shownProbe && <div className="hint">Orbit to choose where the hit comes from. Click the bot for details.</div>}
          {view === 'basins' && rollTime && (
            <RollBar
              time={rollTime.time}
              total={rollTime.total}
              landing={landing}
              rank={rank}
              onScrub={(t) => viewerRef.current?.setAnimTime(t)}
              onReplay={() => viewerRef.current?.replay()}
              onReset={() => viewerRef.current?.resetToPose()}
            />
          )}
          {view === 'basins' && analysis && !rollTime && <div className="hint">Click the shell to drop the bot with that side down.</div>}
          {help && <Help onClose={() => setHelp(false)} />}
        </section>
      </div>
    </div>
  )
}
