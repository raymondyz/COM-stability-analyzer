import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Segment } from '../core/roll.ts'
import { icosphere } from '../core/sphere.ts'
import type { Vec3 } from '../core/vec.ts'
import { poseColor } from './colors.ts'

export type ViewMode = 'poses' | 'basins' | 'hits'

export interface PoseDisplay {
  down: Vec3
  height: number
  support: Vec3[]      // relative to the COM
}

export interface ProbeDisplay {
  point: Vec3          // body frame
  dir: Vec3 | null     // body frame
  pivot: { kind: 'edge' | 'corner', a: Vec3, b: Vec3 } | null   // relative to the COM
}

interface Step {
  kind: 'turn' | 'seg'
  start: number
  duration: number
  q0: THREE.Quaternion
  q1: THREE.Quaternion         // turn only
  axis: THREE.Vector3          // seg only, body frame
  angle: number
  pivot: THREE.Vector3         // seg only, body frame relative to the COM
  anchor: THREE.Vector3        // seg: world position of the pivot; turn: starting COM position
}

const DOWN = new THREE.Vector3(0, 0, -1)
const v3 = (a: Vec3) => new THREE.Vector3(a[0], a[1], a[2])
const TURN_SPEED = 2.5   // rad/s
const ROLL_SPEED = 1.4   // rad/s

// Three.js scene for the bot. Renders only when something changes.
export class Viewer {
  onShellClick?: (down: Vec3) => void
  onBodyClick?: (ray: { origin: Vec3, dir: Vec3 }) => void
  onCameraSettled?: () => void
  onAnimTime?: (t: number, total: number) => void

  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(35, 1, 0.001, 100)
  private controls: OrbitControls
  private bot = new THREE.Group()          // COM at origin, body axes
  private body = new THREE.Group()         // absolute body coordinates
  private mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null
  private shell: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null
  private shellLevel = -1
  private grid: THREE.GridHelper | null = null
  private comMarker: THREE.Mesh
  private dropLine: THREE.Line
  private support: THREE.LineLoop
  private pivot: THREE.Line
  private probeMarker: THREE.Mesh
  private pivotMarker: THREE.Mesh
  private arrow: THREE.ArrowHelper
  private hull: Float64Array = new Float64Array()      // hull vertices relative to the COM
  private hullAbs: Float64Array = new Float64Array()
  private size = 1
  private mode: ViewMode = 'poses'
  private poseQuat = new THREE.Quaternion()
  private poseHeight = 0
  private hasPose = false
  private steps: Step[] = []
  private animTime = 0
  private playing = false
  private lastFrame = 0
  private raf = 0
  private resize: ResizeObserver
  private down: { x: number, y: number, t: number } | null = null
  private shellRadius = 1
  private poseSig = ''
  private container: HTMLElement

  constructor(container: HTMLElement) {
    this.container = container
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    container.appendChild(this.renderer.domElement)

    this.camera.up.set(0, 0, 1)
    this.scene.add(this.camera)
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.6)
    hemi.position.set(0, 0, 1)
    this.scene.add(hemi)
    const key = new THREE.DirectionalLight(0xffffff, 1.4)
    key.position.set(0.4, 0.8, 0.3)
    this.camera.add(key)

    this.scene.add(this.bot)
    this.bot.add(this.body)

    const overlay = (color: string) => ({ color, depthTest: false, transparent: true })
    this.comMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshBasicMaterial(overlay('#ff3d7f')))
    this.comMarker.renderOrder = 10
    this.bot.add(this.comMarker)
    this.dropLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ ...overlay('#ff3d7f'), dashSize: 1, gapSize: 1 }))
    this.dropLine.renderOrder = 10
    this.scene.add(this.dropLine)
    this.support = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ ...overlay('#ff3d7f'), opacity: 0.9 }))
    this.support.renderOrder = 9
    this.bot.add(this.support)
    this.pivot = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial(overlay('#1b6ef3')))
    this.pivot.renderOrder = 10
    this.bot.add(this.pivot)
    this.probeMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshBasicMaterial(overlay('#1b6ef3')))
    this.probeMarker.renderOrder = 11
    this.body.add(this.probeMarker)
    this.pivotMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshBasicMaterial(overlay('#1b6ef3')))
    this.pivotMarker.renderOrder = 11
    this.bot.add(this.pivotMarker)
    this.arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0x1b6ef3)
    for (const m of [this.arrow.line.material, this.arrow.cone.material] as THREE.Material[]) {
      m.depthTest = false
      m.transparent = true
    }
    this.arrow.renderOrder = 12
    this.scene.add(this.arrow)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.addEventListener('change', () => this.requestRender())
    this.controls.addEventListener('end', () => this.onCameraSettled?.())

    const el = this.renderer.domElement
    el.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY, t: performance.now() }))
    el.addEventListener('pointerup', (e) => {
      const d = this.down
      this.down = null
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5 && performance.now() - d.t < 600) this.click(e)
    })

    this.resize = new ResizeObserver(() => this.fitCanvas())
    this.resize.observe(container)
    this.fitCanvas()
    this.applyMode()
  }

  setModel(positions: Float32Array, indices: Uint32Array, normals: Float32Array, hullVerts: Float64Array, size: number) {
    this.stop()
    if (this.mesh) {
      this.body.remove(this.mesh)
      this.mesh.geometry.dispose()
      this.mesh.material.dispose()
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    g.setIndex(new THREE.BufferAttribute(indices, 1))
    g.computeBoundingSphere()
    this.mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#c4c7cc', roughness: 0.75, metalness: 0.05 }))
    this.mesh.raycast = () => {}   // picking happens in the worker
    this.body.add(this.mesh)
    this.hullAbs = hullVerts
    this.size = size

    if (this.grid) {
      this.scene.remove(this.grid)
      this.grid.dispose()
    }
    const span0 = size * 2.5
    const raw = span0 / 16
    const pow = 10 ** Math.floor(Math.log10(raw))
    const step = [1, 2, 5, 10].map((k) => k * pow).find((s) => s >= raw)!
    const span = Math.ceil(span0 / step) * step
    this.grid = new THREE.GridHelper(span, Math.round(span / step), '#8a8f98', '#8a8f98')
    this.grid.rotateX(Math.PI / 2)
    const gm = this.grid.material as THREE.Material
    gm.transparent = true
    gm.opacity = 0.28
    gm.depthWrite = false
    this.scene.add(this.grid)

    const r = size * 0.012
    this.comMarker.scale.setScalar(r)
    this.probeMarker.scale.setScalar(r * 0.8)
    this.pivotMarker.scale.setScalar(r * 0.9)
    ;(this.dropLine.material as THREE.LineDashedMaterial).dashSize = size * 0.015
    ;(this.dropLine.material as THREE.LineDashedMaterial).gapSize = size * 0.012
    if (this.shell) {
      this.bot.remove(this.shell)
      this.shell = null
      this.shellLevel = -1
    }
    this.setProbe(null)
    this.setArrow(null)
    this.hasPose = false
    this.poseSig = ''
    this.poseHeight = 0
    this.fitCamera()
    this.requestRender()
  }

  setCom(com: Vec3) {
    this.body.position.set(-com[0], -com[1], -com[2])
    this.hull = new Float64Array(this.hullAbs.length)
    for (let i = 0; i < this.hull.length; i++) this.hull[i] = this.hullAbs[i] - com[i % 3]
    let r = 0
    for (let i = 0; i < this.hull.length; i += 3) r = Math.max(r, Math.hypot(this.hull[i], this.hull[i + 1], this.hull[i + 2]))
    if (this.shell) this.shell.scale.setScalar(r * 1.15)
    this.shellRadius = r * 1.15
    this.requestRender()
  }

  // Rests the bot in a pose. Its yaw comes from the hull's own shape, so the view
  // never depends on how the model was oriented in CAD.
  showPose(pose: PoseDisplay | null, refit: boolean) {
    // Refreshed analyses resend the same pose; leave a running animation alone then.
    const sig = pose ? `${pose.down.join()}|${pose.height}` : ''
    if (sig === this.poseSig && !refit) return
    this.poseSig = sig
    this.stop()
    if (!pose) {
      this.hasPose = false
      this.bot.quaternion.identity()
      this.bot.position.set(0, 0, 0)
      this.support.visible = false
      this.applyMode()
      this.requestRender()
      return
    }
    const up = v3(pose.down).negate().normalize()
    const helper = Math.abs(up.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
    const a = new THREE.Vector3().crossVectors(up, helper).normalize()
    const b = new THREE.Vector3().crossVectors(up, a)
    // 2D principal axis of the hull projected onto the ground.
    let saa = 0, sbb = 0, sab = 0, sa = 0, sb = 0
    const n = this.hull.length / 3
    for (let i = 0; i < n; i++) {
      const p = new THREE.Vector3(this.hull[3 * i], this.hull[3 * i + 1], this.hull[3 * i + 2])
      const x = p.dot(a), y = p.dot(b)
      sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y
    }
    sa /= n; sb /= n
    const cxx = saa / n - sa * sa, cyy = sbb / n - sb * sb, cxy = sab / n - sa * sb
    const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy)
    const e1 = a.clone().multiplyScalar(Math.cos(theta)).addScaledVector(b, Math.sin(theta))
    if (sa * Math.cos(theta) + sb * Math.sin(theta) < 0) e1.negate()
    const e2 = new THREE.Vector3().crossVectors(up, e1)
    const m = new THREE.Matrix4().set(
      e1.x, e1.y, e1.z, 0,
      e2.x, e2.y, e2.z, 0,
      up.x, up.y, up.z, 0,
      0, 0, 0, 1,
    )
    this.poseQuat.setFromRotationMatrix(m)
    this.poseHeight = pose.height
    this.bot.quaternion.copy(this.poseQuat)
    this.bot.position.set(0, 0, pose.height)
    this.support.geometry.dispose()
    this.support.geometry = new THREE.BufferGeometry().setFromPoints(pose.support.map(v3))
    const first = !this.hasPose
    this.hasPose = true
    this.updateDropLine()
    this.applyMode()
    if (refit || first) this.fitCamera()
    this.requestRender()
  }

  setMode(mode: ViewMode) {
    this.mode = mode
    if (mode !== 'basins' && this.steps.length) this.resetToPose()
    this.applyMode()
    this.requestRender()
  }

  // Colors the shell around the bot: the point in body direction u gets the color
  // of the pose the bot settles in when it starts with u pointing down.
  setBasins(level: number, dest: Int16Array) {
    const sphere = icosphere(level)
    if (!this.shell || this.shellLevel !== level) {
      if (this.shell) {
        this.bot.remove(this.shell)
        this.shell.geometry.dispose()
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(sphere.verts), 3))
      g.setIndex(new THREE.BufferAttribute(sphere.faces, 1))
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(sphere.verts.length), 3))
      this.shell = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.42, depthWrite: false }))
      this.shell.scale.setScalar(this.shellRadius)
      this.shell.renderOrder = 5
      this.bot.add(this.shell)
      this.shellLevel = level
    }
    const attr = this.shell.geometry.getAttribute('color') as THREE.BufferAttribute
    const palette = new Map<number, THREE.Color>()
    for (let i = 0; i < dest.length; i++) {
      let c = palette.get(dest[i])
      if (!c) palette.set(dest[i], (c = new THREE.Color(poseColor(dest[i]))))
      attr.setXYZ(i, c.r, c.g, c.b)
    }
    attr.needsUpdate = true
    this.applyMode()
    this.requestRender()
  }

  setHeat(colors: Float32Array | null) {
    if (!this.mesh) return
    const mat = this.mesh.material
    if (colors) {
      this.mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      mat.vertexColors = true
      mat.color.set('#ffffff')
    } else {
      this.mesh.geometry.deleteAttribute('color')
      mat.vertexColors = false
      mat.color.set('#c4c7cc')
    }
    mat.needsUpdate = true
    this.requestRender()
  }

  setProbe(p: ProbeDisplay | null) {
    this.probeMarker.visible = !!p
    this.pivot.visible = p?.pivot?.kind === 'edge'
    this.pivotMarker.visible = p?.pivot?.kind === 'corner'
    if (p) {
      this.probeMarker.position.set(...p.point)
      if (p.pivot?.kind === 'edge') {
        this.pivot.geometry.dispose()
        this.pivot.geometry = new THREE.BufferGeometry().setFromPoints([v3(p.pivot.a), v3(p.pivot.b)])
      } else if (p.pivot) {
        this.pivotMarker.position.set(...p.pivot.a)
      }
    }
    this.requestRender()
  }

  // Shows a hit direction (body frame). With `at` (body frame) the arrow ends
  // there; otherwise it ends at the bot's outline, aimed through the COM.
  setArrow(dir: Vec3 | null, at?: Vec3) {
    this.arrow.visible = !!dir
    if (dir) {
      this.bot.updateMatrixWorld(true)
      const d = v3(dir).applyQuaternion(this.bot.quaternion).normalize()
      const len = this.size * 0.3
      let tip: THREE.Vector3
      if (at) tip = v3(at).applyMatrix4(this.body.matrixWorld)
      else {
        // How far the hull reaches toward where the hit comes from.
        let reach = 0
        for (let i = 0; i < this.hull.length; i += 3) reach = Math.max(reach, -(dir[0] * this.hull[i] + dir[1] * this.hull[i + 1] + dir[2] * this.hull[i + 2]))
        tip = this.bot.position.clone().addScaledVector(d, -reach)
      }
      this.arrow.position.copy(tip).addScaledVector(d, -len)
      this.arrow.setDirection(d)
      this.arrow.setLength(len, len * 0.25, len * 0.12)
    }
    this.requestRender()
  }

  // Horizontal direction away from the camera, tilted up by `elevation`, in the body frame.
  cameraHitDirection(elevation: number): Vec3 {
    const f = new THREE.Vector3().subVectors(this.controls.target, this.camera.position)
    f.z = 0
    if (f.lengthSq() < 1e-12) f.set(1, 0, 0)
    f.normalize().multiplyScalar(Math.cos(elevation))
    f.z = Math.sin(elevation)
    f.applyQuaternion(this.bot.quaternion.clone().invert())
    return [f.x, f.y, f.z]
  }

  // Animates: turn so `down` faces the floor, then follow the recorded roll.
  playRoll(down: Vec3, segments: Segment[]) {
    this.stop()
    const steps: Step[] = []
    let t = 0
    const q = this.bot.quaternion.clone()
    const u = v3(down).normalize()
    const turn = new THREE.Quaternion().setFromUnitVectors(u.clone().applyQuaternion(q), DOWN)
    const q1 = turn.multiply(q)
    const turnAngle = 2 * Math.acos(Math.min(1, Math.abs(q.dot(q1))))
    const tDur = Math.max(0.25, turnAngle / TURN_SPEED)
    steps.push(this.step('turn', t, tDur, q, { q1, anchor: this.bot.position.clone() }))
    t += tDur
    let qc = q1.clone()
    let pos = new THREE.Vector3(this.bot.position.x, this.bot.position.y, this.heightFor(qc))
    for (const s of segments) {
      const from = v3(s.from).normalize()
      const to = v3(s.to).normalize()
      const angle = from.angleTo(to)
      if (angle < 1e-6) continue
      const axis = new THREE.Vector3().crossVectors(from, to).normalize()
      const pivot = v3(s.point)
      const anchor = pivot.clone().applyQuaternion(qc).add(pos)
      const dur = angle / ROLL_SPEED
      steps.push(this.step('seg', t, dur, qc, { axis, angle, pivot, anchor }))
      t += dur
      qc = qc.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, -angle))
      pos = anchor.clone().sub(pivot.clone().applyQuaternion(qc))
    }
    this.steps = steps
    this.animTime = 0
    this.playing = true
    this.lastFrame = performance.now()
    this.support.visible = false
    this.applyMode()
    this.requestRender()
  }

  get animDuration() {
    const last = this.steps[this.steps.length - 1]
    return last ? last.start + last.duration : 0
  }

  setAnimTime(t: number) {
    this.playing = false
    this.animTime = t
    this.applyAnim()
    this.requestRender()
  }

  replay() {
    if (!this.steps.length) return
    this.animTime = 0
    this.playing = true
    this.lastFrame = performance.now()
    this.requestRender()
  }

  resetToPose() {
    this.stop()
    this.bot.quaternion.copy(this.poseQuat)
    this.bot.position.set(0, 0, this.poseHeight)
    this.updateDropLine()
    this.applyMode()
    this.requestRender()
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.resize.disconnect()
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private step(kind: Step['kind'], start: number, duration: number, q0: THREE.Quaternion, extra: Partial<Step>): Step {
    return {
      kind, start, duration, q0: q0.clone(), q1: new THREE.Quaternion(), axis: new THREE.Vector3(), angle: 0,
      pivot: new THREE.Vector3(), anchor: new THREE.Vector3(), ...extra,
    }
  }

  private stop() {
    this.steps = []
    this.playing = false
    this.onAnimTime?.(0, 0)
  }

  // COM height when resting with the current world-down direction (support function).
  private heightFor(q: THREE.Quaternion): number {
    const u = DOWN.clone().applyQuaternion(q.clone().invert())
    let h = -Infinity
    for (let i = 0; i < this.hull.length; i += 3) h = Math.max(h, u.x * this.hull[i] + u.y * this.hull[i + 1] + u.z * this.hull[i + 2])
    return h
  }

  private applyAnim() {
    const t = this.animTime
    const s = this.steps.find((st) => t <= st.start + st.duration) ?? this.steps[this.steps.length - 1]
    if (!s) return
    const k = Math.min(1, Math.max(0, (t - s.start) / s.duration))
    if (s.kind === 'turn') {
      const e = k * k * (3 - 2 * k)
      this.bot.quaternion.slerpQuaternions(s.q0, s.q1, e)
      this.bot.position.set(s.anchor.x, s.anchor.y, this.heightFor(this.bot.quaternion))
    } else {
      this.bot.quaternion.copy(s.q0).multiply(new THREE.Quaternion().setFromAxisAngle(s.axis, -k * s.angle))
      this.bot.position.copy(s.anchor).sub(s.pivot.clone().applyQuaternion(this.bot.quaternion))
    }
    this.updateDropLine()
    this.onAnimTime?.(t, this.animDuration)
  }

  private updateDropLine() {
    const p = this.bot.position
    this.dropLine.geometry.dispose()
    this.dropLine.geometry = new THREE.BufferGeometry().setFromPoints([p.clone(), new THREE.Vector3(p.x, p.y, 0)])
    this.dropLine.computeLineDistances()
  }

  private applyMode() {
    const m = this.mode
    const animating = this.steps.length > 0
    if (this.shell) this.shell.visible = m === 'basins'
    this.support.visible = this.hasPose && m === 'poses' && !animating
    this.comMarker.visible = this.hasPose && m !== 'hits'
    this.dropLine.visible = this.hasPose && m === 'poses'
    if (m !== 'hits') {
      this.probeMarker.visible = false
      this.pivot.visible = false
      this.pivotMarker.visible = false
      this.arrow.visible = false
    }
  }

  private fitCamera() {
    const target = new THREE.Vector3(0, 0, this.poseHeight * 0.8)
    const dist = (this.size * 0.55) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    const dir = new THREE.Vector3(0.75, -1.25, 0.8).normalize()
    this.camera.position.copy(target).addScaledVector(dir, dist)
    this.camera.near = this.size / 200
    this.camera.far = this.size * 50
    this.camera.updateProjectionMatrix()
    this.controls.target.copy(target)
    this.controls.update()
  }

  private fitCanvas() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.requestRender()
  }

  private click(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    this.scene.updateMatrixWorld(true)
    if (this.mode === 'basins' && this.shell?.visible) {
      // Ray against the shell's sphere, in the bot's COM-centred frame.
      const inv = this.bot.matrixWorld.clone().invert()
      const o = ray.ray.origin.clone().applyMatrix4(inv)
      const d = ray.ray.direction.clone().transformDirection(inv)
      const b = o.dot(d)
      const c = o.lengthSq() - this.shellRadius ** 2
      const disc = b * b - c
      if (disc < 0) return
      const hit = o.addScaledVector(d, -b - Math.sqrt(disc)).normalize()
      this.onShellClick?.([hit.x, hit.y, hit.z])
    } else if (this.mode === 'hits') {
      const inv = this.body.matrixWorld.clone().invert()
      const o = ray.ray.origin.clone().applyMatrix4(inv)
      const d = ray.ray.direction.clone().transformDirection(inv)
      this.onBodyClick?.({ origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] })
    }
  }

  private requestRender() {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      if (this.playing) {
        const now = performance.now()
        this.animTime = Math.min(this.animDuration, this.animTime + (now - this.lastFrame) / 1000)
        this.lastFrame = now
        this.applyAnim()
        if (this.animTime >= this.animDuration) this.playing = false
        else this.requestRender()
      }
      this.renderer.render(this.scene, this.camera)
    })
  }
}
