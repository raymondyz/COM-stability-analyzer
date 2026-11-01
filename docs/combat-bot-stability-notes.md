# Combat Bot Invertibility and Stability Analysis: Notes

Summary of a discussion on finding a combat robot's stable and unstable resting orientations, which stable pose each unstable orientation rolls to, how hard each pose is to escape, and how much of a hit it takes to flip the bot.

---

## 1. The problem

Given the bot's geometry and mass properties, we want:

- **Stable orientations:** poses the bot sits in at rest.
- **Unstable equilibria:** poses where it balances but any nudge sends it rolling.
- **Roll destinations:** for every other orientation, which stable pose it rolls to with no initial velocity.
- **Energy barriers:** how much energy it takes to knock the bot out of each pose, and into which one.
- **Hit thresholds:** the impulse or force needed to flip it when it's hit at a given point from a given direction.

This is the "stable pose" problem from parts-feeding and robotics research. The set of orientations that roll to a given pose is called its **capture region** or **basin**.

---

## 2. Existing tools

**Bottom line:** there's no SolidWorks add-in and no website for this. The free options are a Python library and a research codebase.

| Tool | What it does | Catches |
|---|---|---|
| **trimesh** (Python), `compute_stable_poses()` | Finds stable poses on a flat surface and the probability of landing in each one from a random drop. Returns a 4×4 transform per pose. | Only returns stable poses. The full topple graph is built by a private helper in `trimesh.poses`. Assumes uniform density unless you pass `center_mass`. |
| **Putting Rigid Bodies to Rest** (SIGGRAPH 2025, MIT license, C++) | Finds every stable pose and its probability. **Drop mode** gives the rolling path and final pose from any starting orientation. Polyscope GUI lets you drop the mesh and scrub the roll with a slider. | Needs to be compiled (C++20, CMake ≥ 3.16, Eigen3, Qhull). Easy on macOS or Linux; use WSL on Windows. |
| **Blender add-on** for the above | Shows each stable pose in the viewport with its probability. | Packaged for Blender 5 / Python 3.13 with a macOS-only binary. Appears to use the mesh's uniform-density COM. |
| **US Army Research Lab self-righting software** | Maps a robot's stable orientations and tip-over transitions as a graph. | Not publicly available. |
| **Browser "orientation optimizers"** | These are 3D-printing tools that rank build orientations by overhang and support volume. | A different problem. Not useful here. |

### trimesh quick start

```python
import numpy as np
import trimesh

mesh = trimesh.load("bot.stl")
com = np.array([cx, cy, cz])  # from SolidWorks Mass Properties, same frame and units

transforms, probs = mesh.compute_stable_poses(center_mass=com)
for T, p in zip(transforms, probs):
  up = T[2, :3]  # body-frame direction that points up in this pose
  print(np.round(up, 3), f"{p:.1%}")
```

### Putting Rigid Bodies to Rest with a real COM

The `drop_probs` CLI has an **undocumented `--com` flag** (confirmed in the source, `apps/main_drop_prob.cpp`). It reads a text file containing `x y z`. Passing it also skips the tool's auto-recentering, so the mesh stays in SolidWorks coordinates. Without the flag, the tool assumes uniform density, which is badly wrong for a bot full of batteries and motors.

```bash
# COM from SolidWorks Mass Properties, same frame and units as the mesh
echo "12.3 -4.5 30.1" > com.txt
./build/drop_probs --mesh bot.obj --com com.txt --probs --out bot.json
./build/drop_probs --mesh bot.obj --com com.txt --viz
```

---

## 3. SolidWorks export gotchas

- **Always supply the COM explicitly.** STL carries no mass data. Make sure purchased parts (motors, batteries, ESCs) have real masses, using mass overrides where needed, before reading the COM.
- **Keep one coordinate frame.** Export the assembly as a single STL and turn off "translate output to positive space," so the mesh coordinates match the frame the COM was measured in. Check units too.
- **3DXML** is the format trimesh's docs suggest for SolidWorks if STL gives trouble.
- **Faceting:** curved surfaces like tires and fillets become many tiny hull facets, which show up as fake, barely stable poses. Merge nearly coplanar facets and ignore poses with negligible probability or margin.

---

## 4. Building our own tool (static site, all computation client-side)

### 4.1 Correction to the original spec

Unstable equilibria aren't faces. On the convex hull:

- **Faces** are either stable (the COM projects inside the face) or not equilibria at all, since the bot just tips off them.
- **Edges** can be **saddles**: balanced on an edge with the COM directly above it.
- **Vertices** can be **maxima**: balanced on a corner.

Free sanity check (Poincaré–Hopf on the sphere), valid for any generic shape:

$$\#\text{stable} - \#\text{saddles} + \#\text{maxima} = 2$$

For example, a cube with a centered COM gives $6 - 12 + 8 = 2$.

### 4.2 Core algorithm

Describe an orientation by the body-frame **down vector** $u \in S^2$. With COM $c$, the COM height is the support function

$$h(u) = \max_{v \in \text{hull}} \langle v - c,\, u \rangle$$

and quasi-static rolling is gradient descent of $h$ on the sphere. The hull's Gauss map splits the sphere into regions: each face becomes a point (its normal), each edge an arc, and each vertex a spherical polygon (its normal cone).

**Classification:**

- **Stable face:** projecting $c$ onto the face plane lands inside the face polygon.
- **Saddle on an edge:** the foot of the perpendicular from $c$ to the edge line lies inside the segment, and that direction lies between the two adjacent face normals.
- **Maximum on a vertex:** $(v - c)/\lVert v - c \rVert$ lies inside that vertex's normal cone.

**Exact rolling, one contact change at a time:**

- **On a face that isn't stable:** find the point $q$ on the face polygon closest to the projected COM. If $q$ is on an edge, the bot rolls over that edge. If $q$ is a corner, it pivots on that vertex.
- **Pivoting on a vertex $v$:** $u$ moves along the great circle away from $v - c$ until a second vertex touches.
- **On an edge:** the bot rolls about the edge onto the adjacent face only if $c$ projects onto the edge line within the segment. Otherwise one end lifts and it pivots on the other vertex. Naive face-to-face "topple graphs" get this case wrong.

Because $h$ strictly decreases, every starting orientation resolves in a few steps.

**Basin map:** sample about 100k orientations on a Fibonacci sphere and roll each one. That gives a sphere colored by destination pose, plus each pose's probability under a random-orientation prior, in well under a second. The same routine drives a "click an orientation, watch it roll" animation.

### 4.3 Importing geometry and mass properties

| Option | How | Notes |
|---|---|---|
| Native SolidWorks files (.SLDASM / .SLDPRT) | Not feasible | Proprietary format with no browser parser. |
| **STEP** | `occt-import-js` (OpenCascade compiled to WebAssembly) reads STEP / IGES / BREP in the browser and returns the assembly tree with named per-part meshes ready for three.js. | Carries **no mass data**. Build a parts table with per-part density or mass overrides, then compute the COM and inertia from each part's volume via signed tetrahedra (divergence theorem). Overrides matter because purchased parts are often simplified or hollow models. Parts that aren't watertight break the volume calculation. |
| **SolidWorks macro + sidecar** (highest fidelity) | A small macro exports an STL plus a JSON file with mass, COM and inertia tensor in the same frame. | Uses SolidWorks's own numbers, including mass overrides. Almost no UI needed. |
| **Manual COM entry** | User types the COM. | Trivial. Handle units and frame mismatches. |

### 4.4 Other implementation notes

- **Facet merging:** merge hull facets within an angular tolerance, and report a **margin** per pose (energy barrier, plus how far the projected COM sits from the face boundary) rather than a yes/no. Symmetric bots tend to put the COM close to edges.
- **Performance:** run the analysis in a Web Worker. Load the OpenCascade WASM only when someone drops in a STEP file, since it's large.
- **Configurations:** let users load several exports (cam angles, weapon positions) and compare them.
- **Testing:** check Poincaré–Hopf on every model, and cross-check results against `drop_probs`. The SIGGRAPH project page has dice STL files to test with.

### 4.5 Stack and rough effort

**Stack:** three.js (rendering, plus STL / OBJ / 3MF loaders), quickhull3d (convex hull), occt-import-js (STEP), hosted on GitHub Pages or Cloudflare Pages.

| Piece | Rough effort |
|---|---|
| Core: STL + manual COM, hull, classification, basin sphere, roll animation | About a weekend |
| Energy-barrier graph, margins, facet merging, polish | A few evenings |
| STEP import with a per-part mass table | A few more days, mostly UI and messy-CAD edge cases |
| SolidWorks export macro | An evening, mostly fighting VBA |

---

## 5. Energy barriers (the most important part for combat)

### 5.1 The picture

Treat the potential energy $U(u) = mg\,h(u)$ as terrain over all orientations:

- **Stable poses** are the bottoms of wells.
- **Edge saddles** are mountain passes.
- **Vertex maxima** are peaks.

To get from one well to another, the bot must climb at least as high as the **lowest pass** between them.

### 5.2 Computing it

1. **Saddle graph.** For each saddle, nudge the orientation slightly to each side and roll it. The two rolls end at two stable poses, so each saddle becomes a link between two poses, weighted by the saddle's height $h_s$.
2. **Escape barrier of pose $A$.** Take the lowest saddle on the boundary of $A$'s basin:
   $$\Delta E_A = mg\,(h_s - h_A)$$
   This is how hard it is to knock the bot out of $A$ at all, and the link tells you where the cheapest exit leads.
3. **Barrier from $A$ to a specific pose $B$.** Find the bottleneck path: the path through the graph whose highest saddle is as low as possible. To get all pairs at once, sort saddles by height and merge poses with union-find (basically Kruskal's algorithm). The result is a tree called a **disconnectivity graph** (a merge tree). Each stable pose is a leaf at its well height, and two poses join at the height of the lowest pass between them, so $\Delta E_{A \to B}$ can be read straight off the tree.

**Dynamic reading:** if the bot is still tumbling with leftover energy $E$ above $A$, every pose that joins $A$'s branch below that level is still reachable, and wells shallower than $E$ can't hold it.

### 5.3 Correction to an earlier formula

An early version of this discussion gave a per-edge tipping energy, $\Delta E = mg \min_e (r_e - h)$ over the edges of the resting face. That's the energy to tip over one particular edge. It misses cases where the bot tips onto an unstable face and keeps rolling, sometimes right back to where it started. **The saddle graph supersedes it.**

### 5.4 Design implications

- Make the good poses (upright, inverted) **deep** wells.
- Make the bad poses (on its side, resting on the weapon) **shallow**, or better, **not wells at all**: add a hump or rollbar so the COM never projects inside that hull face.
- The barrier from a bad pose back to a good one is the energy your own mechanism must supply to recover. For the shuffler, that's what the cam-driven feet have to rock it through.

### 5.5 Limitation

A barrier is the **minimum** energy needed, but having that much energy isn't enough. It has to arrive as rotation about the right axis, and most of a hit's energy usually goes into shoving the bot across the arena. That's what Section 6 handles.

---

## 6. Hits at a specific point and direction

This also requires the **inertia tensor** $I_G$ about the COM. SolidWorks Mass Properties reports it, and the STEP-plus-densities route can compute it from the same tetrahedra as the COM.

### 6.1 Impulsive hit model (spinners, hammers)

Treat the hit as an instantaneous impulse $\mathbf{J} = J\hat{\mathbf{d}}$ at body point $\mathbf{p}$. Assume the bot pivots about a support edge with unit direction $\hat{\mathbf{a}}$ through point $\mathbf{q}$. The ground only pushes along that edge, so it has no moment about it, and angular momentum about the edge is conserved through the impact:

$$I_a\,\omega = J\,\ell, \qquad \ell = \hat{\mathbf{a}} \cdot \big( (\mathbf{p} - \mathbf{q}) \times \hat{\mathbf{d}} \big), \qquad I_a = \hat{\mathbf{a}}^\top I_G\, \hat{\mathbf{a}} + m\,r_e^2$$

where:

- $\ell$ is the hit's lever arm about the edge.
- $I_a$ is the moment of inertia about the edge (parallel axis theorem).
- $r_e$ is the distance from the COM to the edge line.
- $h_0$ is the COM height at rest.

The bot tips over the edge if $\tfrac{1}{2} I_a \omega^2 \ge mg\,(r_e - h_0)$, so the minimum impulse is

$$J_{\min} = \frac{\sqrt{2\, I_a\, m g\, (r_e - h_0)}}{|\ell|}$$

### 6.2 Validity checks (does it actually pivot?)

Linear momentum gives the ground's reaction impulse ($\mathbf{G}$ is the COM position):

$$\mathbf{R} = m\,\omega\,\hat{\mathbf{a}} \times (\mathbf{G} - \mathbf{q}) - \mathbf{J}$$

- **It must push, not pull** ($R_z \ge 0$). If it would have to pull, the edge lifts instead.
- **It must stay in the friction cone:** $|R_{\text{horiz}}| \le \mu R_z$. If it needs more friction than the floor has, the bot slides.

For a 3D hit, try each support edge as the pivot and keep the one that passes both checks. If none does, report "slides" or "launches" instead of a number. Strictly, this is the linear complementarity problem physics engines solve, but with only a handful of candidate edges, brute force is fine.

### 6.3 Worked example

A uniform 300 × 60 mm, 1.36 kg box (roughly beetleweight), tipping about its far bottom edge. Here $I_a = 0.0424\ \text{kg·m}^2$ and the barrier is $1.64\ \text{J}$.

| Hit | Lever arm | $J_{\min}$ | Friction needed |
|---|---|---|---|
| Horizontal, top of the back face | 60 mm | 6.2 N·s | $\mu \approx 3.3$ |
| Upward, at the back bottom edge | 300 mm | 1.2 N·s | $\mu \approx 0.65$ |

**Takeaways:**

- No arena floor has $\mu = 3.3$, so a horizontal hit anywhere on the side of a flat bot slides it rather than pivoting it cleanly.
- For a hit perpendicular to the edge, the only height where a horizontal hit pivots with zero friction is $z^* = I_a / (m h_0)$. Here that's about 1 m, far above the bot.
- The upward hit has 5× the lever arm, needs about a fifth of the impulse, and pivots with a realistic $\mu$. That's a big part of why wedges and flippers are such efficient flippers.

### 6.4 Slow pushes (wedges and lifters driving under you)

This case is quasi-static:

$$F_{\min} = \frac{mg\,\ell_g}{\ell_F}$$

where $\ell_g$ is the horizontal distance from the COM to the pivot edge and $\ell_F$ is the push's lever arm about that edge.

### 6.5 Converting to weapon specs

The bot's effective mass at the hit point is $m_{\text{eff}} = I_a / \ell^2$. Suppose a weapon with effective mass $m_w$ (for a spinner, $I_w / r^2$) hits at closing speed $v$, with restitution $e$. The impulse it delivers is

$$J = \frac{(1+e)\,v}{1/m_w + 1/m_{\text{eff}}}$$

That answers "would this opponent's spinner flip us if it hit here?"

### 6.6 Visualization: vulnerability heatmap

Because $J_{\min}$ is closed form, compute it at every point on the mesh instantly and paint it on the model for a chosen hit direction, or for the worst direction at each point. That shows exactly where the bot is vulnerable. **Proposed headline feature.**

---

## 7. Where the analytic model stops

- **Quasi-static assumption:** the basin analysis assumes the bot rolls slowly into the nearest well. After a hit, it has momentum and can blow straight through shallow wells. Barriers and margins address this partly.
- **Airborne tumbling:** once a hit launches the bot, the landing is chaotic. Basin probabilities are the honest answer for where it ends up.
- **Click-to-verify simulation:** run a real rigid-body sim in the browser with **Rapier** (a physics engine compiled to WebAssembly), using a convex hull collider and an impulse applied at a point. Searching for the impulse that just barely flips the bot gives a simulated threshold to compare against the formula. It also catches effects the formula ignores, like the edge lifting mid-roll.
- **Guessed inputs:** floor friction $\mu$ and restitution $e$ have to be estimated, so expose them as sliders.
- **Spinning weapons:** gyroscopic effects dominate how the bot tumbles while the weapon is spun up. Treat all of these results as the weapon-stopped case.
- **Shuffler-specific:** the cam-driven feet change the convex hull as the cam turns. Run the analysis at several cam angles. A pose that's stable at one phase may be unstable at another, which shows whether the bot can walk itself out of a bad orientation.

---

## 8. Proposed feature list

**Core**

- STL import with manual COM entry
- Convex hull, with stable faces, saddles and maxima classified
- Poincaré–Hopf check
- Basin sphere, colored by destination pose, with probabilities
- Click-to-roll animation

**Combat**

- Saddle graph and escape barrier per pose
- Disconnectivity graph (barrier tree)
- Vulnerability heatmap ($J_{\min}$ per surface point, for a chosen hit direction or the worst direction)
- Weapon-spec calculator ("would this spinner flip us here?")

**Import**

- STEP via occt-import-js, with a per-part mass and density table
- SolidWorks macro that exports an STL plus a JSON sidecar (mass, COM, inertia tensor)

**Verification and comparison**

- Rapier click-to-verify sim, with $\mu$ and $e$ sliders
- Multi-configuration comparison (cam angles, weapon positions)

---

## Sources

- [trimesh `compute_stable_poses` docs](https://trimesh.org/trimesh.base.html)
- [trimesh `poses.py` source](https://github.com/mikedh/trimesh/blob/main/trimesh/poses.py)
- [Putting Rigid Bodies to Rest: project page](https://hbaktash.github.io/projects/putting-rigid-bodies-to-rest/index.html)
- [Putting Rigid Bodies to Rest: code](https://github.com/hbaktash/resting-rigid-bodies)
- [Blender add-on](https://github.com/alecjacobson/putting-rigid-bodies-to-rest-blender-plugin)
- [Let Them Fall Where They May: Capture Regions of Curved Objects and Polyhedra](https://vision.ucsd.edu/sites/default/files/publications/pdfs/Let%20Them%20Fall%20Where%20They%20May%20-%20Capture%20Regions%20of%20Curved%20Objects%20and%20Polyhedra.pdf)
- [US Army: "I've fallen and can't get up" (ARL self-righting software)](https://www.army.mil/article/220434)
- [Methods for robotic self-righting (US Patent 8977485)](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/8977485)
- [occt-import-js README](https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/README.md)
- [occt-import-js on npm](https://npmjs.com/package/occt-import-js)
- [iamRapid Print Orientation Optimizer](https://iamrapid.com/tools/print-orientation-optimizer-support-calculator/) (example of the unrelated 3D-printing tools)
