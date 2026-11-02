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
| **v1** | STL and OBJ import. Mass properties from a pasted SolidWorks Mass Properties report, JSON, or manual entry. Hull, equilibria and Poincaré–Hopf check. Pose list with probability, escape barrier and tilt-to-tip angle. Basin shell with click-to-roll. Energy to reach each other pose. Hit heatmap, push mode, and a hit tester: pick a starting pose, a point, a direction and a strength (impulse, weapon or force), and see where the bot ends up. |
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
| Pivot models (per support edge and corner) | pose, mass, inertia | the pose or mass properties change |
| Heatmap | impact precompute, hit direction | the hit settings change |

Mass on its own doesn't change the statics (poses, probabilities, tilt angles); it only scales energies. Editing the mass therefore never reruns the basin map.

### 2.1 Source layout

```
src/
  core/                 pure TS: no DOM, no three.js; runs in the worker, Vitest and Node
    vec.ts  units.ts  types.ts
    io/stl.ts           binary and ASCII STL
    io/obj.ts
    io/massReport.ts    SolidWorks Mass Properties paste parser, and the JSON format
    weld.ts             hash-based vertex welding
    hull.ts             quickhull3d → polygon hull, adjacency, support queries
    displayMesh.ts      the drawn and painted mesh (§3.7)
    equilibria.ts       stable faces, edge saddles, vertex maxima
    roll.ts             quasi-static roll, per-face destination table, path recording
    sphere.ts           icosphere levels and per-vertex area weights
    barriers.ts         merge tree, simplification, escape and pairwise barriers
    tipPath.ts          planar tip path along a great circle, and a hit's tumble along it
    inertia.ts          volume moments and the fallback inertia estimate
    impact.ts           edge and corner pivot models, J_min, F_min, validity, a hit's exact path, weapon impulse
    heatmap.ts          allocation-free per-vertex kernel
    sample.ts           generated sample bot
    testShapes.ts       boxes, prisms and a tetrahedron for tests
    *.test.ts
  worker/
    protocol.ts         request and response types
    analysis.worker.ts
    client.ts           main-thread wrapper: ids, superseding, progress, partial results
  viewer/
    Viewer.ts           three.js scene, on-demand rendering, picking, roll animation
    colors.ts           pose palette and heatmap ramp
  ui/                   MassPanel, PoseList, HitControls, Overlays, format helpers
  App.tsx  main.tsx  index.css
bench/
  pipeline.ts         stage timings in Node (pnpm bench)
  ui.ts               headless Chromium screenshots and timings (pnpm ui-check)
docs/SPEC.md
```

**Dependencies:** `three` and `quickhull3d`. Dev dependencies: `vitest`, `@types/three` and `playwright` (for `bench/ui.ts`). No UI kit and no state library: app state is plain React state in `App.tsx`.

### 2.2 Conventions

- **Units:** SI internally (m, kg, s, J, N·s). Convert only at input and display. Display uses mm, g or kg, J, N·s and N.
- **Frames:** the body frame is the file's frame. Core math runs in the body frame shifted so the COM is at the origin.
- **Orientation:** described by the body-frame **down vector** `u`, a unit vector. A pose is a stable hull face, and its `u` is that face's outward normal.
- **World frame:** rendering is Z-up, with the ground at z = 0.
- **Orientation independence:** the app never asks which way is up or front, and nothing depends on how the model was oriented in CAD.
  - Poses are lettered by probability.
  - A pose is displayed with the hull's major horizontal axis (2D PCA of the hull vertices projected onto the ground) along world X.
  - Hit directions are a heading and elevation against the bot as displayed, so 0° runs along that major axis.
- **Precision:** Float64 in core, Float32 only for GPU buffers.
- **Tolerances:** relative to the bounding-box diagonal unless stated otherwise.
- **Code style:** 2-space indent, single quotes, no semicolons (matching the template), `const` over `let`.

### 2.3 Data model

The authoritative types live in `src/worker/protocol.ts` and `src/core/*.ts`. The shapes that cross the worker boundary:

```ts
interface MassProps {
  mass: number                    // kg
  com: Vec3                       // m, body frame
  inertia: Mat3 | null            // kg·m² about the COM, body axes; null → estimated
}

interface PoseInfo {              // one pose after folding shallow ones
  face: number
  down: Vec3                      // body-frame down vector
  height: number                  // COM height at rest, m
  inset: number                   // projected COM to the nearest support edge, m
  tilt: number                    // tilt-to-tip, rad
  probability: number
  escape: { lift: number, to: number } | null
  support: Vec3[]                 // support polygon, relative to the COM
  folded: number                  // shallow poses folded into this one
}

interface AnalysisResult {
  version: number                 // ties later requests (roll, heatmap, probe) to this analysis
  poses: PoseInfo[]
  lift: Float64Array              // lift[i·P + j]: COM rise from pose i to pose j, m
  euler: { stable: number, saddles: number, maxima: number }   // raw counts
  basinLevel: number
  basin: Int16Array               // pose per icosphere vertex
  final: boolean                  // false for the streamed coarse result
}
```

Barriers are stored as COM lifts in metres and multiplied by m·g only for display, so they don't depend on the mass.

### 2.4 Worker protocol

- Every request carries an increasing `id`.
- A newer request of the same kind supersedes an older one. Long loops run in chunks, yield between chunks, and stop if a newer request has arrived.
- Each response is one of `progress` (a fraction and a stage label), `partial` (an early result), `result`, `error` or `cancelled`.
- Large arrays are passed as transferables, which hands them over without copying.

| Request | Payload | Result |
|---|---|---|
| `load` | the `File` (or none, for the sample bot), unit scale | display mesh (Float32 positions, normals, indices), hull vertices, uniform-density centroid, size |
| `analyze` | COM, threshold, basin level | `AnalysisResult`: partial at level 4, then final |
| `roll` | analysis version, starting `down` vector | path segments and the landing pose |
| `heatmap` | analysis version, pose, mass properties, hit spec | Float32Array per display vertex (J or F; NaN where the direction can't reach; Infinity where nothing flips). Worst-direction mode sends a partial after its first pass. |
| `pick` | ray in body coordinates | the hit point and its surface normal, facing the camera, or null on a miss |
| `probe` | analysis version, pose, mass properties, hit spec, point and normal, strength (impulse, weapon or force) | direction used, J_min or F_min, pivot (edge or corner), the pose a just-sufficient hit lands in, the applied impulse or force, and the result: final pose, how far it tips, energy given, the hardest landing, and the motion as segments. Or the reason nothing tips. |

Sending the `File` rather than its bytes lets a units change re-read it without the main thread keeping a 93 MB copy. The worker caches pivot models keyed by analysis version, pose, mass and inertia.

---

## 3. Algorithms

This section records what we implement and where it departs from the notes. Departures are marked **Change**.

### 3.1 Load

1. **Parse** in the worker: binary STL with a DataView, ASCII STL and OBJ line by line.
2. **Weld** duplicate vertices with a quantized hash. STL stores each vertex about six times.
3. **Hull** with quickhull3d using `skipTriangulation: true`. Its own coplanarity tolerance is far below float32 noise, so flat faces come out split into facets. Margins and roll logic need true polygons: a flat bottom left as two triangles would treat the diagonal as the nearest edge and get the inset wrong. So:
   - **Change: merge by distance, not angle.** Neighbouring faces merge when every vertex lies within 1e-6 × model size of the group's plane (the plane of its largest face; largest faces first). Merging by a 0.01° angle broke `test_1`: it accepted faces that weren't flat, and stranded a vertex between two faces, which then counted as a fake ninth peak.
   - A vertex left in exactly two faces is dropped if it lies on their shared line. If it doesn't (two faces meeting at a tiny angle), the facets around it are kept unmerged and the merge is redone.
   - The result must be closed, consistently oriented and have Euler characteristic 2; otherwise the raw hull is used.
4. **Build** adjacency (edges with their two faces, vertex neighbours) and a cube-map of seed vertices for support queries.
5. **Display mesh** for drawing, painting and picking (§3.7).

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

1. **Saddle graph.** Balanced on a saddle, a nudge either way rolls the bot about the edge onto one of its two faces, so the destination table gives the poses on each side directly. That gives a link between poses A and B. Skip links where A = B, since a saddle whose sides both drain to the same pose isn't an exit.
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
  - The same path gives the tilt-to-tip angle (the angle at h_max) and the landing pose.
  - **Change: land by following the plane.** Momentum keeps the bot tipping in the same plane past the top, so the path is followed down to the first new contact that isn't itself falling, and the quasi-static roll starts there. Rolling from rest just past the top sent most of `test_1`'s paths back into the pose they started from.
- **Threshold spin ω\***: the spin right after the hit that just carries the bot over the top. Every hit that just tips the bot over this edge leaves it spinning at ω*.
  - **Change: contact changes cost energy.** Each kink in the path is a new contact point P_k landing with speed, modelled as a plastic impact (no bounce, no slip). Angular momentum about P_k is conserved, so the spin after the impact is ω⁺ = ω⁻ (I_G,a + m r_{k−1}·r_k) / (I_G,a + m |r_k|²), where r_k is the COM's offset from P_k perpendicular to the axis.
  - ω* is found by working backward from zero kinetic energy at the top. With no kinks before the top (a flat-bottomed box), this reduces to √(2 ΔE / I_a).
  - Losses vanish as tessellation gets finer, so a finely faceted tire behaves like smooth rolling.
  - If an impact would reverse the spin, this edge can't be tipped over.
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

**Change: corner pivots.** On real bots most hits are off-centre. They lift one end of every support edge, so the bot turns about a single corner P instead. On the sample bot, almost every rising hit was "lifts a corner" before this was added. Per corner, once per pose:

- I_P (inertia about P) and its inverse.
- The corner's outward directions: the angles between the outward normals of its two edges. For 12 directions across them, a tip path, its threshold spin ω*, gravity lever arm and landing pose, using an axis through P perpendicular to that direction.

Per hit (p, d):

1. Spin per unit impulse: w = I_P⁻¹ ((p − P) × d). Angular momentum about P is conserved, because the ground acts only at P.
2. P is the pivot only if no other support vertex would sink: w · ((Q − P) × up) ≥ 0 for every other vertex Q.
3. The horizontal part of w is the tipping axis, and its size s is the spin about it per unit impulse. The tipping direction picks the tabulated sample by angle, interpolated.
4. J_min = ω* / s. The single contact must push and stay inside the friction cone.

**Result for a hit (p, d):** the smallest J_min over valid edge and corner pivots, with that pivot and the pose it lands in. If none is valid, report why: **launches** (the ground would have to pull), **slides** (friction isn't enough), **lifts** (no single contact or edge is consistent), or **returns** (it tips but lands back in the same pose).

**Slow push** (lifters, wedges driving under): F_min = m g ℓ_g / ℓ_F about the same pivots, with static equilibrium in place of the impulse balance. For a corner, the smallest F over its tabulated axes. ℓ_g is the largest gravity lever arm along the tip path.

**Weapon:**

- Effective mass of the bot at the hit point: m_eff = I_a / ℓ² for an edge, and 1 / (τᵀ I_P⁻¹ τ) with τ = (p − P) × d for a corner.
- Impulse delivered: J = (1 + e) v / (1/m_w + 1/m_eff). For a spinner, m_w = I_w / r².
- The hit flips the bot if J ≥ J_min.

**A hit of a given size** (`tumble` in `tipPath.ts`). J_min only says whether the bot leaves its pose. To say where a given hit sends it, the threshold-spin model runs forward:

- The hit starts the bot spinning about the chosen pivot at ω₀ = J ℓ / I_a for an edge, or J s for a corner (s is the horizontal part of I_P⁻¹ τ per unit impulse). It then follows the same planar tip path the threshold uses.
- Between contact changes, gravity trades kinetic energy for COM height. At each contact change, a plastic impact keeps angular momentum about the new pivot, which is the same ratio the threshold works back through. So the spin just above ω* goes over the first top, and just below it stays.
- The path goes on past the first landing: a harder hit can carry the bot over further tops.
- It ends when the energy runs out on a rise (the bot rocks back into the well it was in), or when an impact stops it dead. If it is still going after a full turn, it is past what the planar model covers, and the result is "keeps tumbling".
- From the bottom of the well it settles in, the quasi-static roll finds the final pose.
- For a corner, the forward path is traced for this hit's own tipping direction rather than read from the corner's 12-sample table. So J_min in the readout is exact, and can differ slightly from the heatmap color at that point.
- A push isn't modelled forward: F ≥ F_min pushes it over the first top, and it lands without carrying momentum on. F < F_min leaves it where it is.
- It also records the most energy any one landing absorbs. If that is more than it takes to leave the final pose, the readout warns that a real bot may bounce on: a plastic landing that absorbs hundreds of joules is the model's weakest point for hard hits.

**Known approximations.** These appear in the UI's help text and are what the v1.x sim verifies.

- **Plastic contact changes.** New contacts on the way over neither bounce nor slip.
- **Planar motion.** The bot keeps tipping about axes parallel to its starting axis; for a corner, the yaw part of the spin is ignored for the tip energy.
- **Tilt-to-tip** in the pose list uses edges only.
- **Weapon stopped.** Gyroscopic effects are ignored.

**Inertia source:**

- Use the inertia from the SolidWorks report when it's given.
- Otherwise estimate it with uniform density, taken about the user's COM and scaled to the given mass. Use the mesh volume (signed tetrahedra) if the mesh is closed and consistently oriented, and the hull volume otherwise.
- Results based on an estimate carry an "estimated inertia" badge.

### 3.7 Display mesh and heatmap

**Display mesh** (`displayMesh.ts`). CAD exports cover big flat faces with a few long triangles, and welded vertices average normals across sharp edges, so per-vertex values would smear round corners (a top face would take the color of the sides). So:

- Edges longer than size/40 are split (1 → 4, sharing midpoints), giving flat faces interior samples.
- Vertices are split along creases sharper than 35°, so each side of an edge has its own vertex and normal. Shading is smooth on curves and crisp at creases.
- On `test_1`, 735k welded vertices become 1.38M display vertices, in 173 ms.

**Heatmap:**

- **Where:** one value per display vertex, for the selected pose.
- **Shared positions:** copies split along a crease share a position, and the value at a position only depends on the direction. Only "can this direction reach it" (d·n < 0) differs per copy, so the kernel runs once per position.
- **Direction modes:**
  - **Set heading** (the default): a heading in degrees around the vertical, against the bot as displayed in its pose (0° runs along its long axis, from the hull's PCA), tilted up by the elevation. 0° elevation is horizontal (spinners, side hits from hammers), and positive elevation rises (wedges, flippers). An arrow in the viewport shows the direction. The camera has no part in it, so orbiting never changes the hit.
  - **Worst:** the lowest J_min over 12 azimuths, 30° apart, at the chosen elevation, with no per-vertex refinement. Near the best direction J grows like 1/cos(Δφ), so a miss costs at most 3.5%. It runs in two passes of 6 directions: the first pass is shown, then refined. The click probe searches 48 directions for its own number.
- **Color:** log scale of J_min in N·s (F_min in N for pushes) between the 2nd and 98th percentiles, with a legend. Red is easy to flip, and neutral grey is hard. Blue-grey means "can't flip from here", and plain grey means "faces away from the hit".
- **Hit readout:** clicking the bot raycasts in the worker (`pick`), which has the full mesh, so the main thread never scans 2M triangles. The point stays fixed after that, and each change to the hit re-runs only `probe`, which is cheap (§4.1).

### 3.8 Mass properties input

**Ways in:**

- **Paste the SolidWorks Mass Properties text** (the dialog's Copy to Clipboard button). This is the primary route. The parser reads:
  - the mass
  - the center of mass
  - the moments of inertia "taken at the center of mass and aligned with the output coordinate system" (Lxx through Lzz)

  Units are taken from the text, and decimal commas are accepted.

  SolidWorks reports products of inertia in "positive tensor notation" (Lxy = +∫xy dm), so the inertia tensor's off-diagonal entries are −Lxy, −Lxz and −Lyz. The report's other two inertia blocks give a built-in self-check that catches a wrong sign or a bad paste:
  - The tensor's eigenvalues must match the principal moments.
  - The parallel-axis theorem must reproduce the block "taken at the output coordinate system".

  The status line also shows the report's coordinate system, and any "includes hidden components" note.
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
- Parts that never reach the outside, such as electronics and internal hardware, only need to be in the mass report. They can be hidden or missing in the STL, because only the outer shell affects the geometry. `test_1` is an example: its hidden internal components add weight to the report but are absent from the STL.

---

## 4. Performance

**Target:** usable on a low-end laptop, such as an Intel N100 or Celeron-class machine. Assume one core of such a laptop is about 6× slower than the Apple M5 Pro used for the measurements.

**How to check:** worker time with `pnpm bench` (Node) × 6, and main-thread behaviour with `pnpm ui-check --throttle 6`.

Chrome's CPU throttling (CDP `Emulation.setCPUThrottlingRate`) did **not** slow the analysis worker in headless Chromium. A 6× throttled run of `test_1` loaded in 1.7 s, against 1.4 s unthrottled. So throttled browser runs only cover the main thread.

### 4.1 Measured

**Real bot: `docs/test_1.STL`.** This is a full assembly exported as one binary STL: 93 MB, 1,857,305 triangles, 516 × 213 × 351 mm. It is about the most complex model we expect. The timings are from Node 26 on the M5 Pro (`pnpm bench docs/test_1.STL docs/test_1.txt`).

| Step | Runs when | M5 Pro | Low-end (×6) |
|---|---|---|---|
| Parse binary STL | load | 22 ms | 0.13 s |
| Weld to 735,556 vertices | load | 119 ms | 0.7 s |
| Hull (346 vertices, 527 faces after merging) | load | 128 ms | 0.8 s |
| Mesh moments | load | 11 ms | 0.07 s |
| Display mesh (1.38M vertices) | load | 173 ms | 1.0 s |
| **Total load** | load | **~455 ms** | **~2.7 s** |
| Equilibria, destination table, barriers | COM or threshold change | 12 ms | 0.07 s |
| Basins at level 4 / 6 / 7 | COM or threshold change | 4 / 28 / 106 ms | 0.02 / 0.17 / 0.64 s |
| Pivot models for one pose | pose or mass change | 4 ms | 0.03 s |
| Heatmap, one direction | hit settings change | 36 ms | 0.22 s |
| Heatmap, worst direction: pass 1, then pass 2 | hit settings change | 333 ms, then 321 ms | 2.0 s, then 1.9 s |
| Hit readout at a placed point (pivot, tip path, tumble, roll to rest) | any change to the hit | 1 ms | < 0.01 s |

In the browser (headless Chromium with software WebGL, at 1440 × 900):
- From choosing `test_1.STL` to the model on screen: 1.4 s.
- From pasting the report to the pose list: 2.6 s. This includes a 150 ms debounce and two software renders of 2M triangles.
- Heatmap: 0.9 s.
- Placing a hit adds one raycast over the display mesh in the worker (tens of milliseconds on `test_1`). After that, the readout updates without it.
- The sample bot is under 0.5 s end to end.

With the COM from `docs/test_1.txt`:
- The COM sits 59.7 mm inside the hull.
- The raw counts are 7 stable faces, 13 saddles and 8 maxima, so Poincaré–Hopf passes (7 − 13 + 8 = 2).
- Folding at 0.5 mm leaves two poses, A (57%) and B (43%). Both rest on triangular support faces whose nearest edge is not a saddle.

**Synthetic bot** (measured before implementation): a filleted chassis, four tires tessellated at 1024 segments, a weapon disc and internal clutter. This is the stress case for the hull, because curved outer surfaces add hull vertices.

| Step | M5 Pro | Low-end (×6) |
|---|---|---|
| Weld 0.95M-triangle soup to 474k vertices | 119 ms | ~0.7 s |
| Hull of 474k vertices (4,326 hull vertices, 5,122 faces) | 214 ms | ~1.3 s |
| 100k hull support queries (hill climb from a cube-map seed) | 26 ms | ~0.16 s |

### 4.2 Budgets (low-end estimate)

| Budget | Target | Estimate on `test_1` |
|---|---|---|
| Load, with progress shown | ≤ 3 s | ~2.7 s ✓ |
| COM edit to updated pose list (coarse first, refined within 1 s) | ≤ 0.3 s | ~0.1 s coarse, ~0.25 s refined ✓ |
| Heatmap, one direction | ≤ 0.1 s | ~0.22 s ✗ (corner pivots roughly doubled the kernel cost) |
| Heatmap, worst direction, first paint (with progress) | ≤ 2 s | ~2.0 s, refined by ~3.9 s (borderline) |
| Main thread: no task over 50 ms; render on demand only; pixel ratio capped at 2 | | Implemented; not yet profiled on slow hardware |

### 4.3 Risks

- **GPU:** drawing 2M triangles on old integrated graphics hasn't been measured. Headless Chromium renders in software, so it can't tell us. The fallback is a decimated display mesh.
- **Heatmap kernel cost:** the next steps, if needed, are to skip vertices that no hit can reach (internal parts) or to split the work across more workers.
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
│ ■ Pose A     62%  1.6 J │                                            │
│ ■ Pose B     31%  2.1 J │                                            │
│ ■ Pose C      7%  0.4 J │                                   legend   │
│   (selected pose detail)│                                            │
└─────────────────────────┴────────────────────────────────────────────┘
```

**Responsive rules:**

- **960 px wide or more:** two columns. The panel is `clamp(280px, 26vw, 370px)` wide and the viewport fills the rest.
  - The panel scrolls on its own, and its sections collapse, so a 1366 × 768 screen fits without the page scrolling.
- **Under 960 px** (for example, a half-screen window): the layout stacks, with the viewport on top at 58vh and the panel below it.
- Checked with `pnpm ui-check` at 1280 × 720, 1366 × 768, 1440 × 900, 1920 × 1080 and 900 × 800, in light and dark themes.

**Styling:** system font, 14 px base, light and dark themes via `prefers-color-scheme`. No UI library.

### 5.2 Panel

- **Model:** file name, triangle count and units. There is no up or front axis to set (§2.2). The Model and Mass properties sections collapse once the first analysis succeeds; their summaries stay visible.
- **Mass properties:** a paste box (the primary input), JSON and manual fields. A status line shows which values are in use and any sanity warnings.
- **View settings** change with the active tab:
  - **Basins:** high precision.
  - **Hits:**
    - Starting pose: one chip per pose, the same choice as the pose list.
    - Impact or slow push.
    - Direction: a set heading (Heading slider, default 0°) or worst; elevation; μ (default 0.5).
    - Hit strength: an impulse in N·s (default 5), or a weapon (effective mass, closing speed and restitution e, default 0.3), whose impulse depends on the bot's effective mass at the point. A force in N (default 100) for pushes.
- **Pose list (always visible).** Each row shows:
  - a color swatch, matching the basin shell
  - a letter (Pose A is the most likely, then B, and so on)
  - the probability
  - the escape barrier in J, with the COM lift in mm
  - the tilt-to-tip angle

  Selecting a pose drives all three views. The selected pose expands to show its cheapest exit and where it leads, the energy to reach each other pose, the inset and the COM height.
- **Poincaré–Hopf badge** in the pose list header. Hovering shows the counts.

### 5.3 Views

- **Poses:** the bot rests in the selected pose on a ground grid. A COM marker drops a line to the ground, and the support polygon is outlined on the ground.
- **Basins:** the bot is shown in the selected pose inside a translucent shell colored by destination pose. The shell turns with the bot.
  - A point on the shell in body direction `u` means "if this side faces the floor".
  - A blue ring lying flat on the shell marks the point under the pointer, and the cursor becomes a pointer, so it's clear the shell can be clicked. It hides off the shell and during orbit drags.
  - Clicking a point plays three stages, so choosing the orientation reads apart from the roll. The bot turns that side down while rising until the shell rests on the floor at that point, gliding back to the middle of the floor as it turns, so every drop starts centred however far earlier rolls took it. After a short hold it drops onto the floor, then rolls to rest. A scrub bar replays all of it.
- **Hits:** the bot rests in the starting pose, painted with the J_min heatmap, with a legend.
  - Clicking the bot places a hit there: a dot, with an arrow for the direction. The point is on the body, so it stays when the starting pose changes. × on the card removes it.
  - The card says where the bot ends up ("Stays in", "Ends in", or "Keeps tumbling"), and how: how far it tips before rocking back, or how far it turns before it settles. It also lists:
    - the impulse or force applied, and the J_min or F_min that tips it out here, as a ratio
    - the pose a just-sufficient hit lands in, when that differs from the start
    - the energy given, next to the pose's cheapest escape energy
    - the pivot (an edge as a line, a corner as a dot)
    - a warning when one landing absorbs more energy than it takes to leave the final pose
  - Or it says why nothing tips (faces away, slides, launches, lifts, returns).
  - "Show the motion" plays the hit from rest: the tip, any further tumbling, and the roll to rest, with the same scrub bar as Basins. The bot stays centred and the floor grid slides under it, so a long tumble stays in view without the camera moving. The arrow moves with the floor.
  - The readout refreshes when anything about the hit changes. There is no hover readout: the raycast runs in the worker and takes tens of milliseconds on 2M triangles.

**Empty state:** a drop zone and a "Try the sample bot" button, which loads a generated four-wheel wedge so the app can be explored without a model.

---

## 6. Testing

**Unit tests** (`pnpm test`, Vitest, `src/core`), 30 in total:

- **Hull:** a box with triangulated faces merges back to 6 quads, 8 vertices and 12 edges.
- **Equilibria:**
  - A cube gives 6 stable faces, 12 saddles and 8 maxima; a regular tetrahedron gives 4, 6 and 4.
  - A prism with an obtuse corner loses its base pose once the COM passes the edge.
  - Poincaré–Hopf holds for 50 random interior COMs.
- **Rolling and basins:**
  - Icosphere weights sum to 1, and levels nest.
  - A cube lands on each face 1/6 of the time; probabilities sum to 1.
  - Every recorded roll segment lowers the COM.
- **Barriers:**
  - A box's escape barrier is the lift over its nearest edge.
  - Shallow wells fold into their cheapest exit.
- **Hits:**
  - The notes' §6.3 example: I_a = 0.042432, a 1.64 J barrier, 6.218 and 1.2436 N·s, sliding below μ ≈ 3.3 and 0.65.
  - An upward hit at a back corner lifts one end of the far edge.
  - The landing pose is the end face.
  - A corner pivot picks up the off-centre hit.
  - The heatmap kernel agrees with the per-point evaluation on 200 random hits, for impact and push.
  - On a rounded corner, impact losses shrink as the facets get finer, ending within 5% of lossless at 32 facets.
- **A hit of a given size** (forward tumble):
  - Just below the threshold spin the bot stays; just above it, it goes over once and lands where the tip path says.
  - Below the threshold, the tilt it reaches lifts the COM by exactly the energy given, and it rocks back to rest.
  - Three times the threshold spin carries the box over its end and onto its back.
  - A push goes over once and lands where the tip path says.
  - For an off-centre hit, the exact corner path agrees with the corner table's J_min, and agrees with itself just below and above it.
- **Input:**
  - The SolidWorks report parser reads SI values with negated products and passes both self-checks, and it rejects a paste whose products have the wrong sign.
  - The JSON format, binary and ASCII STL, and OBJ quads all parse.
- **`test_1`, when its files are present locally:** with the report's COM, the raw counts are 7 stable faces, 13 saddles and 8 maxima. Test models (`docs/test_*`) are gitignored, so this test skips when the files are absent.

**Not yet covered:**
- A tessellated-tire test for the 0.5 mm folding threshold.
- Manual cross-checks of stable poses against trimesh `compute_stable_poses(center_mass=…)` and `drop_probs --com`, using the dice models from the SIGGRAPH project page.

**Bench:**
- `pnpm bench [model.stl report.txt]` times every pipeline stage in Node (§4).
- `pnpm ui-check <out-dir> [--dev] [--throttle 6] [--dark] [--sizes …] [--model … --mass …]` drives the app in headless Chromium. It loads the model, takes screenshots of every view, sets a 45° rising hit, probes the bot, and clicks the basin shell to watch a roll.
  - By default it runs the production build. `--dev` runs it against the dev server instead, where React's StrictMode runs effects twice; run it both ways.

quickhull3d's ESM build uses extensionless imports. Vite and Vitest resolve them, but plain Node doesn't, so core imports `quickhull3d/dist/quickhull3d.js` directly (typed in `src/core/quickhull3d.d.ts`).

---

## 7. Milestones

| # | Milestone | Done when | Status |
|---|---|---|---|
| M0 | **Scaffold:** strip the template, add dependencies and Vitest, build the layout shell (header, panel, viewport, responsive rules), and set up worker plumbing with progress and superseding. | The empty app renders cleanly at 1280 × 720 and 1920 × 1080, and a worker round trip works. | Done |
| M1 | **Load and view:** STL and OBJ parsing and welding in the worker, units and axes, a viewer with orbit controls and on-demand rendering, mass properties (paste, JSON, manual) with sanity checks, a hull overlay, and the sample bot. | `test_1.STL` loads within budget, and a pasted report fills in mass, COM and inertia. | Done, without the hull overlay; there are no units or axes to set beyond file units |
| M2 | **Statics:** polygon hull, equilibria, Poincaré–Hopf check, rolling with the destination table, streamed icosphere basins, the pose list, the Poses and Basins views, and the click-to-roll animation. | Unit tests pass, and a COM edit updates the poses within budget. | Done |
| M3 | **Barriers:** saddle graph, merge tree, simplification threshold, escape barrier and cheapest exit, energy to reach each pose, inset and tilt-to-tip. | The tire-well and box tests pass. | Done; the tire-well test is still missing |
| M4 | **Hits:** inertia (given or estimated), per-edge precompute, J_min with per-endpoint checks, the heatmap (fixed and worst direction), the probe readout, push mode and the weapon calculator. | The §6.3 example test passes, and the heatmap is within budget. | Done, plus corner pivots and the hit tester (a hit of a given size, run forward); the single-direction heatmap is over budget (§4.2) |
| M5 | **Polish:** a pass at 6× throttle, help text for every number, error states, README and deployment. | Every budget is met at 6× throttle. | Partly: help, error states, README, `ui-check` and the Pages workflow are done; the first deployment and a real low-end laptop check are not |
| v1.x | Merge-tree diagram, Rapier verify sim, configuration comparison. | | Not started |

**Rough effort:** M0 half a day, M1 a day, M2 two to three days, M3 a day, M4 two days, M5 a day.

---

## 8. Open questions

- **Default μ and e** are placeholders (0.5 and 0.3). At μ = 0.5, most hits on low bots slide rather than tip. That matches the notes for metal on steel, but is pessimistic for a bot resting on rubber tires.
- **Validating corner pivots:** the corner model is the least checked part of the hit model. The v1.x Rapier sim is the way to check it.
- **GPU on old laptops** (§4.3).

---

## 9. Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-31 | Plain three.js, not react-three-fiber | The scene has only a few objects with large custom buffers, and imperative control makes on-demand rendering simpler. |
| 2026-10-31 | No Akl–Toussaint prefilter before the hull | Measured: quickhull3d alone took 214 ms on 474k vertices, and prefilter plus hull took 427 ms. |
| 2026-10-31 | Icosphere samples instead of a Fibonacci sphere | The icosphere doubles as the shell's display mesh, and its nested levels allow streamed refinement. |
| 2026-10-31 | Per-face destination table | It bounds the cost of each sample roll on finely tessellated hulls. |
| 2026-10-31 | Simplify poses by depth instead of merging facets | It works at any tessellation, and each fold removes a stable–saddle pair, so the Poincaré–Hopf count stays consistent. |
| 2026-10-31 | Planar tip path for hit energy | r_e − h0 is wrong whenever the support edge isn't a saddle, which is the normal case for wheeled bots. Confirmed on `test_1`: the nearest edge of both the upright and the inverted support face isn't a saddle. |
| 2026-10-31 | Per-endpoint reaction check | A check on the total reaction misses off-center hits that lift one end of the edge. |
| 2026-10-31 | Paste the SolidWorks Mass Properties report instead of writing a macro for v1 | It gives the same numbers with nothing to install or maintain. |
| 2026-10-31 | Merge hull faces by distance to a plane, not by angle | Angle-based merging accepted faces that weren't flat and gave `test_1` a fake ninth peak. |
| 2026-10-31 | Separate display mesh with crease splits and long-edge splits | Per-vertex values on welded CAD meshes smeared across sharp edges, and flat faces had only corner samples. |
| 2026-10-31 | Corner pivots alongside edge pivots | Off-centre hits, which are most hits, lift one end of every edge; without corners the heatmap was mostly "not modelled". |
| 2026-10-31 | Land tip paths by following the plane past the top | Rolling from rest just past the top sent most of `test_1`'s paths back into their starting pose. |
| 2026-10-31 | Worst direction: 12 azimuths in two passes, no refinement, computed once per shared position | It roughly halved the cost and gives a first paint in about 2 s at 6×. The error at the optimum is at most 3.5%. |
| 2026-10-31 | Click to probe, not hover | The raycast over 2M triangles runs in the worker and takes tens of milliseconds, too slow to follow the mouse on slow machines. |
| 2026-10-31 | Plain React state in `App.tsx`, no reducer or state library | The app is small; one component owns the state and the effects that sync it to the worker and viewer. |
| 2026-11-01 | No "from camera" hit direction: always a set heading, or worst | User request. This replaces aiming by orbiting from the 2026-10-31 orientation row. A hit stays put while the view orbits, and the same settings give the same hit. |
| 2026-11-01 | A hit tester on the Hits view: starting pose, point, direction and strength in; final pose out | User request. The threshold-spin model runs forward (§3.6), so the result agrees with J_min at the threshold and needs no new physics. Starting orientations are the resting poses, because a hit acts on a bot at rest. |
| 2026-11-01 | Report how far a hit turns the bot, not how many tops it goes over | A faceted wheel puts a small top at every facet, so on the sample bot one roll onto its back counted as 4. |
| 2026-11-01 | Hit animations keep the bot centred and slide the floor | A hard hit can tumble the bot 0.5 m or more, out of view. The camera stays still, as asked for Basins. The grid repeats, so it only shifts by less than one cell. |
| 2026-11-01 | GitHub Pages, served at `raymondz.dev/tools/stability-analyzer/` through the portfolio's Cloudflare Worker | It is the portfolio's "external project" setup, the same as the shuffler. `base: './'` lets one build work at both addresses. A build served under that path was checked end to end: the worker, analysis and heatmap all ran with no failed requests. |
| 2026-11-01 | The analysis worker starts on first use; `dispose()` only stops it | StrictMode's mount, unmount, remount in development terminated an eagerly created worker, so `pnpm dev` hung at "Reading file". The production build was unaffected, which is why the build-only UI check missed it. |
| 2026-10-31 | Playwright as a dev dependency | It gives repeatable screenshots at laptop sizes and both themes, plus browser timings. |
| 2026-10-31 | Orientation-independent UI: no up or front axis | User requirement. Poses get letters, display yaw comes from the hull's PCA, and hit directions come from the camera. |
| 2026-10-31 | Plastic impacts at contact changes along the tip path | This replaces "lossless plus a warning flag": it costs little and is exact for the planar model, and losses vanish as tessellation gets finer. |
| 2026-10-31 | Negate SolidWorks products of inertia | The report uses positive tensor notation. Checked on `test_1.txt`: with negated products the eigenvalues match the principal moments, and the parallel-axis theorem reproduces the origin block (Ixy 2,882,563 vs 2,882,566 reported; with the other sign it would be −1,264,302). |
