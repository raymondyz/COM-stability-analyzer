# Stability Analyzer: Spec

This is the living design doc. When a decision changes, update the section it affects and add a line to the [decision log](#9-decision-log).

Background math and derivations are in [combat-bot-stability-notes.md](./combat-bot-stability-notes.md). This file covers what we build and how.

---

## 1. Goal and scope

A static web page that takes a combat robot's geometry and mass properties and answers three questions:

1. Which poses can the bot rest in, and how likely is each after a random tumble?
2. How much energy knocks it out of each pose, and where does it go?
3. Where, from which direction, and how hard does it have to be hit to flip?

Everything runs in the browser, with no server, uploads or accounts.

**Principles**

- **Clean over complete.** The UI has three views, one pose list and a short inputs panel. Features that don't fit that shape wait.
- **Never block the UI thread.** All geometry work runs in a Web Worker, so the page stays responsive on a low-end laptop.
- **Show units and assumptions next to every number**, for example "estimated inertia", "quasi-static" or "weapon stopped".
- **Pure, tested core.** The math lives in `src/core` with no DOM or three.js imports, so Vitest can run it in Node.

**Non-goals for v1:** native SolidWorks files, STEP, a dynamics simulation, gyroscopic effects of a spinning weapon, and tuned phone layouts. Narrow screens stack and stay usable, but nothing is designed for them.

### 1.1 Releases

| Release | Contents |
|---|---|
| **v1** | STL and OBJ import. Mass properties from a pasted SolidWorks Mass Properties report, JSON, or manual entry. Hull, equilibria and Poincaré–Hopf check. Pose list with probability, escape barrier and tilt-to-tip angle. Basin shell with click-to-roll. Energy to reach each other pose. Hit heatmap with a hover probe, push mode and a weapon calculator. |
| **v1.x** | Merge-tree (disconnectivity) diagram. Rapier click-to-verify sim. Side-by-side comparison of several configurations, such as cam angles. |
| **Later, if needed** | STEP import with a per-part mass table. A SolidWorks export macro, only if pasting the Mass Properties report turns out not to be enough. |

---

## 2. Architecture

```
  main thread                                   worker
 ┌─────────────────────────────┐  messages    ┌──────────────────────────────┐
 │ React UI          src/ui    │ ───────────▶ │ analysis.worker.ts           │
 │ App state         state.ts  │ ◀─────────── │   core pipeline:             │
 │ Viewer (three.js) src/viewer│ transferable │   parse → weld → hull        │
 └─────────────────────────────┘ buffers      │   → equilibria → basins      │
                                              │   → barriers → impact        │
                                              └──────────────────────────────┘
```

The worker keeps the loaded model and each stage's results, and reruns only the stages whose inputs changed:

| Stage | Inputs | Rerun when |
|---|---|---|
| Parse, weld, hull | file, units | a new file is loaded or the units change |
| Equilibria, destination table, basins, barriers | hull, COM, shallow-pose threshold | the COM or the threshold changes |
| Impact precompute (per support edge) | pose, mass, inertia, μ | the pose, mass properties or μ change |
| Heatmap | impact precompute, hit direction | the hit settings change |

Mass on its own doesn't change the statics (poses, probabilities, tilt angles); it only scales energies. Editing the mass therefore never reruns the basin map.

### 2.1 Source layout

```
src/
  core/                 pure TS: no DOM, no three.js
    vec.ts              Vec3 helpers
    units.ts
    io/stl.ts           binary and ASCII STL
    io/obj.ts
    io/massReport.ts    SolidWorks Mass Properties paste parser
    io/sidecar.ts       JSON mass properties format
    weld.ts             hash-based vertex welding
    hull.ts             quickhull3d → polygon half-edge Hull
    equilibria.ts       stable faces, edge saddles, vertex maxima
    roll.ts             quasi-static roll, per-face destination table, path recording
    sphere.ts           icosphere levels and per-vertex area weights
    basins.ts
    barriers.ts         saddle graph, merge tree, simplification, margins
    tipPath.ts          planar tip path along a great circle
    inertia.ts          fallback inertia estimate
    impact.ts           per-edge precompute, J_min, validity, F_min, weapon impulse
    heatmap.ts
    sample.ts           generated sample bot
  worker/
    protocol.ts         request and response types
    analysis.worker.ts
    client.ts           main-thread wrapper: ids, superseding, progress
  viewer/               three.js, imperative, renders on demand
    Viewer.ts
    botMesh.ts  hullOverlay.ts  supportOverlay.ts  basinShell.ts  rollAnimator.ts  heatmap.ts
  ui/                   React components
  state.ts              app state and reducer
  App.tsx  main.tsx  index.css
bench/                  Node timing scripts
docs/SPEC.md
```

**Dependencies:** `three` and `quickhull3d`. Dev dependencies: `vitest` and `@types/three`. No UI kit and no state library.

### 2.2 Conventions

- **Units:** SI internally (m, kg, s, J, N·s). Convert only at input and display. Display uses mm, g or kg, J, N·s and N.
- **Frames:** the body frame is the file's frame. Core math runs in the body frame shifted so the COM is at the origin.
- **Orientation:** described by the body-frame **down vector** `u`, a unit vector. A pose is a stable hull face, and its `u` is that face's outward normal.
- **World frame:** rendering is Z-up, with the ground at z = 0.
- **Precision:** Float64 in core, Float32 only for GPU buffers.
- **Tolerances:** relative to the bounding-box diagonal unless stated otherwise.
- **Code style:** 2-space indent, single quotes, no semicolons (matching the template), `const` over `let`.

### 2.3 Data model

```ts
type Vec3 = [number, number, number]

interface MassProps {
  mass: number                   // kg
  com: Vec3                      // m, body frame
  inertia: Sym3 | null           // kg·m² about the COM, body axes
  source: 'report' | 'json' | 'manual'
}

interface Hull {
  verts: Float64Array            // xyz, COM at origin
  faces: HullFace[]              // convex polygons, CCW seen from outside, no collinear verts
  edges: HullEdge[]              // each edge once: verts a, b; faces left, right
  // plus CSR adjacency: vertex → edges, vertex → faces
}

interface Pose {
  id: number
  face: number
  down: Vec3
  height: number                 // COM height at rest, m
  probability: number            // share of orientations that roll here
  inset: number                  // m, projected COM to the nearest support-polygon edge
  tiltToTip: number              // rad, smallest tilt that tips it (§3.6)
  escape: { lift: number, to: number } | null
  merged: number[]               // raw poses folded in by simplification
}

interface Saddle { edge: number, down: Vec3, height: number, sides: [number, number] }
interface Maximum { vertex: number, down: Vec3, height: number }

interface Analysis {
  poses: Pose[]                  // after simplification, sorted by probability
  saddles: Saddle[]
  maxima: Maximum[]
  euler: { stable: number, saddles: number, maxima: number, ok: boolean }  // raw counts
  tree: MergeNode[]              // lift(A → B) = join height − height(A)
  basinLevel: number
  basin: Int16Array              // destination pose per icosphere vertex
}
```

Barriers are stored as COM lifts in metres and multiplied by m·g only for display, so they don't depend on the mass.

### 2.4 Worker protocol

- Every request carries an increasing `id`.
- A newer request of the same kind supersedes an older one. Long loops run in chunks, yield between chunks, and stop if a newer request has arrived.
- Each response is one of `progress` (a fraction and a stage label), `result` or `error`.
- Large arrays are passed as transferables, which hands them over without copying.

| Request | Payload | Result |
|---|---|---|
| `load` | file bytes, format, unit scale | render mesh (indexed Float32 positions), hull summary, bounding box |
| `analyze` | COM, threshold, basin level | `Analysis`, streamed: coarse level first, then refined |
| `roll` | starting `down` vector | path keyframes |
| `heatmap` | pose, mass properties, μ, hit spec | Float32Array per render vertex (J or F; `Infinity` where nothing pivots) |
| `probe` | pose, mass properties, μ, e, point, normal, hit spec | per-edge breakdown for the readout |

The worker caches the per-edge impact precompute, keyed by pose, mass properties and μ.

---

## 3. Algorithms

This section records what we implement and where it departs from the notes. Departures are marked **Change**.

### 3.1 Load

1. **Parse** in the worker: binary STL with a DataView, ASCII STL and OBJ line by line.
2. **Weld** duplicate vertices with a quantized hash. STL stores each vertex about six times.
3. **Hull** with quickhull3d using `skipTriangulation: true`. Then merge adjacent faces whose normals differ by less than 0.01°, refit each polygon's plane, and drop collinear polygon vertices. This turns each flat face that the STL split into triangles back into a single polygon. Margins and roll logic need true polygons: a flat bottom left as two triangles would treat the diagonal as the nearest edge and get the inset wrong.
4. **Build** the half-edge `Hull`.

### 3.2 Equilibria

All tests below follow the notes (§4.1–4.2), with the COM at the origin.

- **Stable face:** the COM's projection lies inside the polygon by more than ε. A projection within ε of the boundary is treated as not stable and flagged as marginal.
- **Edge saddle:** the foot of the perpendicular from the COM to the edge line lies inside the segment, and the direction to that foot lies strictly between the two face normals on the edge's Gauss arc.
- **Vertex maximum:** `v / |v|` lies inside the vertex's normal cone.
- **Poincaré–Hopf check:** on the raw counts, stable − saddles + maxima must equal 2. A failure means a degenerate input (for example, the COM exactly above an edge) or a hull bug. Show a warning with the counts, but don't block the analysis.

### 3.3 Rolling

The roll follows the state machine in the notes (§4.2):

- **On a face:** an unstable face rolls over an edge or pivots on a vertex.
- **Vertex pivot:** `u` moves along the great circle away from `v` until it reaches the boundary of that vertex's normal cone.
- **On an edge:** the bot rolls about the edge if the COM projects inside the segment. Otherwise it pivots on the endpoint nearest that projection.

**Change: per-face destination table.** A roll that starts at rest on a face is fully determined by that face. So, once per COM, compute `faceDest[f]` for every face with memoized recursion. A sample roll then only runs the continuous part, the vertex pivots from an arbitrary `u`, until it reaches a face, and reads the rest from the table.

This matters for finely tessellated tires. Without the table, rolling across a 1024-segment tire visits hundreds of faces per sample.

The same routine, with recording switched on, produces the keyframes for the roll animation.

### 3.4 Basins and probabilities

- **Samples:** icosphere vertices. Each level contains every vertex of the level before it, so refining reuses earlier work. The worker streams level 4 (2,562 samples) first, then level 6 (40,962) by default. Level 7 (163,842) is a "High precision" setting.
- **Weights:** each vertex is weighted by its barycentric dual area, one third of each adjacent spherical triangle, divided by 4π. The weights are computed once per level and cached.
- **Probability:** the sum of the weights of every vertex that rolls to the pose.
- **Display:** the same icosphere is the mesh for the basin shell, so shell colors map one-to-one onto samples.

A probability means: start at a uniformly random orientation, release at rest, and roll quasi-statically. It is not a drop-and-bounce probability.

### 3.5 Barriers, simplification and margins

1. **Saddle graph.** For each saddle, step a small angle each way along its edge's arc and roll each side. That gives a link between poses A and B. Skip links where A = B, since a saddle whose sides both drain to the same pose isn't an exit.
2. **Merge tree.** Sort the saddles by height and merge poses with union-find (Kruskal's algorithm). Each merge creates a tree node at that saddle's height.
   - The lift from A to B is the height of the node where A and B join, minus A's height.
   - A's escape barrier is the lowest saddle that has A on exactly one side.
3. **Change: simplify by depth instead of merging facets.** Faceted curves such as tires and fillets create many wells only fractions of a millimetre deep. Repeatedly take the shallowest pose: if its escape lift is below the threshold, fold it into the pose its cheapest exit drains to and add its probability there.
   - This is persistence simplification on the merge tree, and it works the same at any tessellation.
   - Default threshold: 0.5 mm of COM lift, adjustable by the user. For a tire of radius r split into n segments, the wells are r(1 − cos(π/n)) deep: 0.19 mm for a 40 mm radius at 32 segments, and 0.77 mm at 16.
   - The Poincaré–Hopf check always uses the raw counts.
4. **Margins** per pose:
   - **Inset:** the distance from the projected COM to the nearest support-polygon edge.
   - **Tilt-to-tip:** the smallest angle, over all support edges, at which the planar tip path (§3.6) reaches its top.

### 3.6 Hits

**Inputs:** the resting pose A, mass m, inertia I_G, COM G, friction μ and restitution e, plus the hit point p, its surface normal n, and the unit hit direction d. Directions are in the world frame with the bot resting in A. Only directions with d·n < 0 count, because a hit pushes into the surface.

**Per support edge of A, computed once per pose.** Each edge has endpoints q1 and q2, length L, and a unit axis â along it. â is oriented so that positive rotation lifts the COM, tipping the bot outward over the edge.

- Moment of inertia about the edge: I_a = âᵀ I_G â + m r_e².
- **Change: take the energy from the planar tip path, not from r_e − h0.**
  - Rotate `u` from A's normal about â and follow h(u) along that great circle to its first maximum h_max. Then ΔE = m g (h_max − h0).
  - To do this, walk the Gauss map along the great circle. Inside each vertex region, h is a·cos θ + b·sin θ, so its maximum there has a closed form.
  - For a flat-bottomed box this equals the notes' r_e − h0. For a bot resting on tessellated tires, the bottom face's front edge isn't a saddle: the bot rolls onto the next tire facet long before the COM passes over that edge, so r_e − h0 is badly wrong.
  - The same path gives the tilt-to-tip angle (the angle at h_max) and the landing pose (roll from just past h_max).
- Threshold spin: ω* = √(2 ΔE / I_a). Every hit that just tips the bot over this edge leaves it spinning at ω*.
- Constant parts of the reaction:
  - m v_G = m ω* â × r
  - H_q1 = (I_G â + m r × (â × r)) ω*
  - where r = G − q1.

**Per hit (p, d) and support edge**, which is only a handful of dot and cross products:

1. **Lever arm:** ℓ = â · ((p − q1) × d). Skip the edge if ℓ ≤ 0.
2. **Threshold impulse:** J_min = I_a ω* / ℓ.
3. **Reactions.** These extend the notes' §6.2 to each end of the edge:
   - Total ground reaction: R = m v_G − J d.
   - Angular impulse about q1 gives â × R2 = (H_q1 − (p − q1) × J d) / L. That fixes R2 except for its component along the edge.
   - The other end: R1 = R − R2.
4. **Validity.** The edge is a valid pivot if both of these hold:
   - Both endpoint normal forces are non-negative: n1, n2 ≥ 0.
   - Friction can be shared between the ends: t_i² ≤ (μ n_i)² for each across-edge component t_i, and |R·â| ≤ Σ √((μ n_i)² − t_i²).

Every reaction term scales with J, so validity doesn't depend on the impulse size. It is a property of (p, d, edge) alone. Gravity's impulse during the hit is neglected.

**Result for a hit (p, d):** the smallest J_min over valid edges, with that edge and the pose it lands in. If no edge is valid, report why, checked in this order:

1. **Launches:** both endpoint normals are negative on every edge.
2. **Lifts a corner:** one endpoint would have to pull. Corner pivots aren't modelled.
3. **Slides:** friction isn't enough.

**Slow push** (lifters, wedges driving under): F_min = m g ℓ_g / ℓ_F about the same edges, with static equilibrium in place of the impulse balance.

**Weapon:**

- Effective mass of the bot at the hit point: m_eff = I_a / ℓ².
- Impulse delivered: J = (1 + e) v / (1/m_w + 1/m_eff). For a spinner, m_w = I_w / r².
- The hit flips the bot if J ≥ J_min.

**Known approximations.** These appear in the UI's help text and are what the v1.x sim verifies.

- **Lossless contact changes on the way over.** A path that crosses a sharp hull edge before its top loses energy there, so the real threshold is higher. Flag any path whose largest crossed exterior angle is more than 10°.
- **Planar motion.** The model assumes the bot keeps tipping about axes parallel to the starting edge.
- **Corner pivots** are reported but not computed.
- **Weapon stopped.** Gyroscopic effects are ignored.

**Inertia source:**

- Use the inertia from the SolidWorks report when it's given.
- Otherwise estimate it with uniform density, taken about the user's COM and scaled to the given mass. Use the mesh volume (signed tetrahedra) if the mesh is closed and consistently oriented, and the hull volume otherwise.
- Results based on an estimate carry an "estimated inertia" badge.

### 3.7 Heatmap

- **Where:** one value per render-mesh vertex, for the selected pose.
- **Rendering:** the mesh is indexed and drawn with `flatShading`, so CAD edges stay crisp while values sit on welded vertices.
- **Direction modes:**
  - **Fixed:** an azimuth relative to the bot's front, plus an elevation. 0° is horizontal (spinners, side hits from hammers). Positive elevation rises (wedges, flippers).
  - **Worst:** the lowest J_min over 24 azimuths at the chosen elevation, then refined around the best one for each vertex.
- **Color:** log scale of J_min in N·s, with a shared legend. Grey means no valid pivot, and hovering says why.

### 3.8 Mass properties input

**Ways in:**

- **Paste the SolidWorks Mass Properties text** (the dialog's Copy to Clipboard button). This is the primary route. The parser reads:
  - the mass
  - the center of mass
  - the moments of inertia "taken at the center of mass and aligned with the output coordinate system" (Lxx through Lzz)

  Units are taken from the text, and decimal commas are accepted.
- **JSON sidecar.** Inertia is about the COM, in body axes. A future SolidWorks macro would write this file.

  ```json
  {
    "units": { "length": "mm", "mass": "g" },
    "mass": 1360,
    "com": [12.3, -4.5, 30.1],
    "inertia": [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  }
  ```
- **Manual fields**, with a unit selector.

**Sanity checks:**

- The COM is inside the convex hull. A COM outside it almost always means a frame or unit mismatch.
- The inertia tensor is positive definite and satisfies the triangle inequalities.

**Export gotchas:**

- The Mass Properties dialog and the STL export each have an output coordinate system option. Both must use the same one; the default is the model origin.
- In the STL export options, tick "Do not translate STL output data to positive space".

---

## 4. Performance

**Target:** usable on a low-end laptop, such as an Intel N100 or Celeron-class machine. Assume one core of such a laptop is about 6× slower than the Apple M5 Pro used for the measurements. Verify this with Chrome DevTools CPU throttling set to 6×.

### 4.1 Measured

These were measured in Node 26 on the M5 Pro, using a synthetic bot: filleted chassis, four tessellated tires, a weapon disc and internal clutter. The low-end column is the measurement × 6.

| Step | Runs when | M5 Pro | Low-end (est.) |
|---|---|---|---|
| Weld 0.95M-triangle soup to 474k vertices | load | 119 ms | ~0.7 s |
| Hull of 474k vertices (gives 4,326 hull vertices, 5,122 faces) | load | 214 ms | ~1.3 s |
| 100k hull support queries (hill climb from a cube-map seed) | basis for roll cost | 26 ms | ~0.16 s |
| Heatmap, one direction, 474k vertices | hit settings change | 9 ms | ~55 ms |
| Heatmap, worst of 24 directions, 474k vertices | hit settings change | 236 ms | ~1.4 s |

### 4.2 Estimated (benchmarks arrive in M2)

| Step | M5 Pro | Low-end |
|---|---|---|
| Parse a 1M-triangle binary STL | ~50 ms | ~0.3 s |
| Equilibria, destination table and barriers | < 10 ms | < 60 ms |
| Basins at level 6 (41k samples) using the destination table | ~20–40 ms | ~0.15–0.25 s |
| Roll path for the animation | < 1 ms | < 5 ms |

### 4.3 Budgets (at 6× throttle)

- **Load a 1M-triangle STL:** 3 s or less, with progress shown.
- **COM edit to updated pose list:** 300 ms or less. Coarse basins come first and are refined within 1 s.
- **Heatmap:** 100 ms or less for a single direction. 2 s or less for worst-direction, with progress shown.
- **Main thread:** no task over 50 ms. Render only on demand (no idle render loop), and cap the pixel ratio at 2.

### 4.4 Risks

- **GPU:** old integrated graphics drawing 1M+ triangles hasn't been measured. The fallback is a decimated display mesh.
- **Very fine hulls:** more than 20k hull vertices would slow the vertex pivots.

---

## 5. UI

### 5.1 Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ Stability Analyzer      bot.stl · 412k tris · mm          [Open] [?] │
├─────────────────────────┬────────────────────────────────────────────┤
│ ▸ Model                 │  [ Poses ] [ Basins ] [ Hits ]             │
│ ▸ Mass properties       │                                            │
│ ▸ View settings         │                                            │
│─────────────────────────│               3D viewport                  │
│ Poses           check ✓ │                                            │
│ ■ Upright    62%  1.6 J │                                            │
│ ■ Inverted   31%  2.1 J │                                            │
│ ■ Left side   7%  0.4 J │                                   legend   │
│   (selected pose detail)│                                            │
└─────────────────────────┴────────────────────────────────────────────┘
```

**Responsive rules:**

- **960 px wide or more:** two columns. The panel is `clamp(280px, 24vw, 360px)` wide and the viewport fills the rest.
  - The panel scrolls on its own, and its sections collapse, so a 1366 × 768 screen fits without the page scrolling.
- **Under 960 px** (for example, a half-screen window): the layout stacks, with the viewport on top at 55vh and the panel below it.

**Styling:** system font, 14 px base, light and dark themes via `prefers-color-scheme`. No UI library.

### 5.2 Panel

- **Model:** file name, triangle count, units, up axis and front axis. The up axis defaults to +Y, SolidWorks' default. The axes drive pose names and the initial camera.
- **Mass properties:** a paste box (the primary input), JSON and manual fields. A status line shows which values are in use and any sanity warnings.
- **View settings** change with the active tab:
  - **Basins:** show saddles, high precision.
  - **Hits:** impulse or push, elevation, a fixed azimuth or worst direction, μ (default 0.5), e (default 0.3), and the weapon calculator.
- **Pose list (always visible).** Each row shows:
  - a color swatch, matching the basin shell
  - a name, generated (Upright, Inverted, Nose down, Left side, and so on) and editable
  - the probability
  - the escape barrier in J, with the COM lift in mm
  - the tilt-to-tip angle

  Selecting a pose drives all three views. The selected pose expands to show its cheapest exit and where it leads, the energy to reach each other pose, the inset and the COM height.
- **Poincaré–Hopf badge** in the pose list header. Hovering shows the counts.

### 5.3 Views

- **Poses:** the bot rests in the selected pose on a ground grid. A COM marker drops a line to the ground, and the support polygon is outlined on the ground. A hull overlay is optional.
- **Basins:** the bot is shown in its modelled orientation inside a translucent shell colored by destination pose.
  - A point on the shell in body direction `u` means "if this side faces the floor".
  - Clicking a point turns that side down and rolls the bot to rest. A scrub bar replays the roll.
- **Hits:** the bot rests in the selected pose, painted with the J_min heatmap, with a legend.
  - Hovering shows J_min, the pivot edge (highlighted) and the landing pose, or why the bot doesn't pivot. Clicking pins the readout.
  - The weapon calculator compares the impulse delivered at the pinned point with J_min there.

**Empty state:** a drop zone and a "Try the sample bot" button, which loads a generated four-wheel wedge so the app can be explored without a model.

---

## 6. Testing

**Unit tests** (Vitest, `src/core`):

- Cube and box: 6 stable faces, 12 saddles and 8 maxima, Poincaré–Hopf passes, and probabilities are symmetric.
- Regular tetrahedron.
- Box with an off-center COM: poses disappear as the COM moves past an edge.
- A triangulated flat face merges back into one polygon.
- The notes' §6.3 worked example: I_a = 0.0424, a 1.64 J barrier, 6.2 and 1.2 N·s, μ ≈ 3.3 and 0.65.
- The per-endpoint check rejects an off-center hit that lifts one end of the edge.
- Tessellated tire wells disappear under the 0.5 mm threshold.
- The SolidWorks report parser on real pasted samples.

**Property tests:**

- Poincaré–Hopf holds on random convex polytopes with a random interior COM.
- Probabilities sum to 1.
- Every roll strictly decreases h.

**Manual cross-checks:** compare stable poses with trimesh `compute_stable_poses(center_mass=…)` and `drop_probs --com`, using the dice models from the SIGGRAPH project page.

**Bench** (`bench/`, run with Node): reproduces the §4 tables on synthetic bots.

quickhull3d's ESM build uses extensionless imports. Vite and Vitest resolve them, but plain Node doesn't, so bench scripts import `quickhull3d/dist/quickhull3d.js` directly.

---

## 7. Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | **Scaffold:** strip the template, add dependencies and Vitest, build the layout shell (header, panel, viewport, responsive rules), and set up worker plumbing with progress and superseding. | The empty app renders cleanly at 1280 × 720 and 1920 × 1080, and a worker round trip works. |
| M1 | **Load and view:** STL and OBJ parsing and welding in the worker, units and axes, a viewer with orbit controls and on-demand rendering, mass properties (paste, JSON, manual) with sanity checks, a hull overlay, and the sample bot. | A 1M-triangle STL loads within budget, and a pasted report fills in mass, COM and inertia. |
| M2 | **Statics:** polygon hull, equilibria, Poincaré–Hopf check, rolling with the destination table, streamed icosphere basins, the pose list, the Poses and Basins views, and the click-to-roll animation. | Unit tests pass, and a COM edit updates the poses within budget. |
| M3 | **Barriers:** saddle graph, merge tree, simplification threshold, escape barrier and cheapest exit, energy to reach each pose, inset and tilt-to-tip. | The tire-well and box tests pass. |
| M4 | **Hits:** inertia (given or estimated), per-edge precompute, J_min with per-endpoint checks, the heatmap (fixed and worst direction), the probe readout, push mode and the weapon calculator. | The §6.3 example test passes, and the heatmap is within budget. |
| M5 | **Polish:** a pass at 6× throttle, help text for every number, error states, README and deployment. | Every budget is met at 6× throttle. |
| v1.x | Merge-tree diagram, Rapier verify sim, configuration comparison. | |

**Rough effort:** M0 half a day, M1 a day, M2 two to three days, M3 a day, M4 two days, M5 a day.

---

## 8. Open questions

- **Products of inertia:** what sign convention does the SolidWorks report use for Lxy and the other off-diagonal terms? Confirm with an asymmetric test part before trusting them.
- **Test inputs:** a real pasted Mass Properties report (for the parser) and one real bot STL (for tests and the bench).
- **Hosting:** GitHub Pages or Cloudflare Pages. This sets Vite's `base` path.
- **Defaults for μ and e:** the current values are placeholders until we have arena numbers.

---

## 9. Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-31 | Plain three.js, not react-three-fiber | The scene has only a few objects with large custom buffers, and imperative control makes on-demand rendering simpler. |
| 2026-10-31 | No Akl–Toussaint prefilter before the hull | Measured: quickhull3d alone took 214 ms on 474k vertices, and prefilter plus hull took 427 ms. |
| 2026-10-31 | Icosphere samples instead of a Fibonacci sphere | The icosphere doubles as the shell's display mesh, and its nested levels allow streamed refinement. |
| 2026-10-31 | Per-face destination table | It bounds the cost of each sample roll on finely tessellated hulls. |
| 2026-10-31 | Simplify poses by depth instead of merging facets | It works at any tessellation, and each fold removes a stable–saddle pair, so the Poincaré–Hopf count stays consistent. |
| 2026-10-31 | Planar tip path for hit energy | r_e − h0 is wrong whenever the support edge isn't a saddle, which is the normal case for wheeled bots. |
| 2026-10-31 | Per-endpoint reaction check | A check on the total reaction misses off-center hits that lift one end of the edge. |
| 2026-10-31 | Paste the SolidWorks Mass Properties report instead of writing a macro for v1 | It gives the same numbers with nothing to install or maintain. |
