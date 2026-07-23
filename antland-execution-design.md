# Antland: Post-Phase-8 Execution Design

**Audience:** coding AI and project owner
**Baseline reviewed:** `main` at commit [`592cc6f`](https://github.com/GeoDuckedup/antland/commit/592cc6f775cfd1dde6a8db7ee2f3ed9a77219ec7), 2026-07-14
**Live build reviewed:** [Formicarium — A Living Study](https://geoduckedup.github.io/antland/)
**Status:** execution in progress; Phases 9A–9E complete, Phase 9F next

---

## 1. Executive decision

The repository is verified through **Phase 8E**. Phase 8 did not implement the earlier proposed warfare phase. It implemented a different and more foundational program:

- **8A:** a shared, pressure-driven living nest architecture for mature and descendant colonies;
- **8B:** resource- and space-driven population dynamics with high technical ceilings separated from biological limits;
- **8C:** capacity-aware foraging, persistent exploration, shared surface spacing, interior reserves, and chamber circulation;
- **8D:** a coherent ecological clock, food/storage accounting, long-horizon calibration hooks, and visual level of detail;
- **8E:** queen aging, colony maturity, orphan decline, territorial vacancy, recolonization, lineage replacement, and the regional census.

The implementation and progress record explicitly mark Phase 8 complete. See [`progress.md`, Phase 8A–8E](https://github.com/GeoDuckedup/antland/blob/592cc6f775cfd1dde6a8db7ee2f3ed9a77219ec7/progress.md#L99-L137).

The code review supports making **Phase 9 a refactoring, performance, and observability-foundation phase**. This is not housekeeping for its own sake. It is the enabling work required to add causal visualization and all-colony warfare without multiplying the existing Amber-, Slate-, and descendant-specific paths.

The post-8 roadmap is:

| Phase | Name | Primary outcome |
|---|---|---|
| 9 | Refactor, measure, and optimize | A modular, deterministic, colony-general engine with stable performance |
| 10 | Observation and causal data | A read-only snapshot, event stream, decision reasons, and causal chains |
| 11 | Individual and living-nest legibility | Ants and nest state explain themselves through behavior and physical evidence |
| 12 | Information, ecology, and time made visible | Trails, recruitment, rain loss, plant/seed loops, and seasons become readable |
| 13 | Territoriality and emergent warfare | Generalized recognition, local escalation, alarm, economic conflict, and de-escalation |
| 14 | Founding, succession, and lineage presentation | The Phase 8E life history becomes a visible generational story |
| 15 | Camera, interaction, mobile, sound, and accessibility | The exhibit becomes discoverable and coherent across devices |
| 16 | Empirical calibration and long-run validation | Biological targets, scenario sweeps, and stability gates govern future tuning |

Phase 13 is an unused number and is the correct home for warfare. The base harvester-ant profile will emphasize foraging-range encounters, recognition, avoidance, local fighting, and shifting frontiers. Nest invasions, brood theft, slave raiding, and supercolony behavior are species-gated extensions, not universal defaults.

---

## 2. What Phase 8 actually shipped

### 2.1 Phase 8A — Shared living nest architecture

The repository now gives every registered colony an expandable architecture with procedural nodes and edges, pressure-driven chamber selection, worker assignment, excavation progress, capacity, depth, circulation, and spoil output. Mature Amber and Slate nests retain their legacy scans as visual bases, while descendants receive a real founding chamber and future expansion.

The core is present in [`main.js`, shared nest architecture](https://github.com/GeoDuckedup/antland/blob/592cc6f775cfd1dde6a8db7ee2f3ed9a77219ec7/main.js#L2327-L2924). Capacity pressure includes worker/brood load, reserves, storage pressure, and brood pressure. New nodes can be nursery, granary, resting, ventilation, or shaft spaces.

Important qualification: the architecture is shared at the data-flow level, but it is not yet a pure simulation model. Its records directly own `THREE.Group`, meshes, materials, `CatmullRomCurve3`, and geometries. Legacy Amber and Slate presentation also remains alongside the new graph. Phase 9 must separate the graph from its presenter before more systems depend on it.

### 2.2 Phase 8B — Resource-driven demography

Former low worker caps were removed as biological rules. The current 900/900/600 colony ceilings and 1,800 global ceiling are explicitly technical safeguards; worker space, brood space, stores, nutrition, nursing, season, crowding, queen vitality, and mortality now regulate growth. The safeguards are defined near the top of [`main.js`](https://github.com/GeoDuckedup/antland/blob/592cc6f775cfd1dde6a8db7ee2f3ed9a77219ec7/main.js#L39-L49).

Completed pupae remain viable when a technical ceiling is reached rather than disappearing. This corrects the earlier pupa-loss edge case.

### 2.3 Phase 8C — Foraging, exploration, and circulation

Foraging sectors now track live food availability, recruitment capacity, congestion, staleness, commitments, private source memory, route confidence, search fans, and persistent exploratory labor. Mature colonies retain an interior reserve instead of placing nearly every adult outside. A shared spatial field handles surface spacing across registered colonies. Completed architecture edges support representative chamber-to-chamber inspection.

Important qualification: the shared registry does not yet mean one shared worker runtime. Amber, Slate, and descendants still have substantially different creation, movement, food-transfer, rendering, and mortality paths. This is the largest blocker to generalized conflict.

### 2.4 Phase 8D — Ecological clock, equilibrium, and LOD

Worker and alate ages use the compressed ecological calendar; food is constrained by storage; reserves drive outside labor; depleted food records retire; half-season checkpoints summarize equilibrium; `horizon` can advance one to four years; and adaptive visual detail reduces animation, terrain-normal, shadow, and underground representative work without merging simulated individuals.

This Phase 8D is not warfare. The phase name must not be reused.

### 2.5 Phase 8E — Colony succession

Each colony has a life history. Queens have deterministic longevity and senescence; colonies mature reproductively; queen death produces an orphan period rather than immediate deletion; vacant territories persist; foundresses can claim them; replacements retain ancestry; and a 12-year census records worker totals and succession events. The live build visibly shows the new regional census card.

---

## 3. Current repository and live-build review

### 3.1 Strengths to preserve

- The fixed-step, seeded simulation and deterministic report are unusually valuable. They make regression testing, scenario replay, and causal visualization feasible.
- The colony registry, shared pheromone storage, shared architecture, lineage ledger, and succession record are strong foundations.
- Instancing, visual LOD, technical ceilings, bounded histories, and query-driven scenarios show good performance and testing instincts.
- The live build has a coherent natural-history identity: muted palette, specimen-note typography, miniature landscape, and restrained interface.
- The simulation already stores much of the information needed for observation: task history, navigation memory, food provenance, chamber pressure, lineage, mortality, census, and ecological flows.

### 3.2 Why Phase 9 must come first

The latest `main.js` is **8,425 lines and 374 KB**, with roughly **233 top-level functions**, **268 top-level `const` declarations**, and **24 top-level `let` declarations**. It combines simulation, rendering, input, UI, reporting, asset loading, tuning, and scenario execution in one native module.

The problem is deeper than file length:

1. **Simulation and rendering are mutually embedded.** The living nest graph stores Three.js groups, materials, meshes, and curve geometry. A chamber cannot be simulated headlessly without creating presentation objects.
2. **Colony generalization is incomplete.** Amber uses `updateAnt`, Slate uses `updateRivalAnt`, and descendants use `updateYoungWorker`; their renderers and cargo paths are also separate.
3. **Current combat is a special-case Amber–Slate interaction.** Each Slate worker scans the Amber worker array, recognizes an opponent immediately by proximity, applies cooldown-based health subtraction, and emits only a visual signal. Descendant colonies do not participate through the same rules. See [`updateRivalAnt`](https://github.com/GeoDuckedup/antland/blob/592cc6f775cfd1dde6a8db7ee2f3ed9a77219ec7/main.js#L5548-L5790).
4. **Fixed-step work contains repeated whole-population scans.** The surface spatial index is rebuilt multiple times per 30 Hz update, and some counts repeatedly reduce every colony's worker array.
5. **Hidden visuals are still synchronized.** Architecture visuals are updated for every living colony even when only one nest can be focused.
6. **Transient rendering allocates aggressively.** Signals, spoil clods, and some construction geometry create and dispose geometries/materials repeatedly instead of using pools or instancing.
7. **The live build logs repeated texture warnings.** On initial load, cloned atlas textures are marked for update before source image data is ready. This is consistent with `atlasTexture()` cloning and setting `needsUpdate` immediately after asynchronous `TextureLoader.load()` calls.
8. **The selected-ant note exposes data but not causality.** It shows raw trait values, state, role, health, cargo, and route confidence, but not a clear destination, decision reason, recent causal history, or colony contribution.
9. **The live nest is visually attractive but semantically opaque.** The wireframe graph shows topology and moving ants; it does not yet show which chamber is crowded, why a new tunnel opened, what traffic is congested, or how stores and brood changed the growth drive.
10. **Controls remain keyboard-first.** The live page advertises a compact keyboard hint; there is no contextual lens, event focus, touch-specific interaction model, or discoverable experiment drawer.

### 3.3 Live-build observations

The reviewed public build matches Phase 8E and loads the regional census with two colonies and approximately 206 initial workers. Surface composition is readable at colony scale, and the underground toggle reveals the expanded living architecture. There were no fatal page errors during the review, but the console produced many identical texture-update warnings on startup.

The most visible gap is exactly the project's stated priority: the simulation has strong causal depth, while ordinary observation primarily reveals moving ants, topology, and a compact census. The next presentation work should reveal causes through the world, not add a permanent strategy HUD.

---

## 4. Non-negotiable design rules

Every phase after 8 must obey these rules.

1. **World evidence first.** A state change should first alter ants, trails, chambers, stores, brood, traffic, vegetation, or remains. Text explains evidence; it does not replace it.
2. **No presentation writes to simulation state.** Lenses and notes consume snapshots and events. They cannot become hidden control logic.
3. **One colony model.** New behavior must work for Amber, Slate, descendants, successors, and future colonies without ID checks.
4. **One worker lifecycle.** Colony and species parameters may vary; core movement, encounter, injury, observation, and rendering contracts may not branch by legacy identity.
5. **Determinism is a feature.** New randomness comes from owned seeded streams. Iteration order, visual sampling, and frame rate must not change biological outcomes.
6. **Rendering LOD never changes biology.** Hiding, sampling, or aggregating visuals cannot remove workers, skip deaths, alter routes, or change conflict.
7. **Local conflict, no global combat mode.** Warfare is a spatial pattern of encounters, recognition, alarm, reinforcement, and withdrawal.
8. **Species traits gate behavior.** The default harvester profile does not inherit slave raids, supercolonies, venom, formic acid, stinging, or nest occupation merely because another ant species exhibits them.
9. **Visual intensity follows causal importance.** Ambient deliveries stay quiet; a lost queen, first worker, outbreak, invasion, or lineage replacement can claim more attention.
10. **Bound every history and transient pool.** Events, path traces, incidents, remains, visual signals, and report samples must have explicit retention policies.

---

## 5. Target architecture

Use native ES modules so GitHub Pages can continue serving the repository without a required build step. A bundler may be added later only if measurement proves it useful.

```text
index.html
main.js                         # thin bootstrap; imports src/app.js

src/
  app.js                        # composition root and frame loop
  config/
    simulation.js               # clock, limits, scenario defaults
    species.js                  # biology and conflict profiles
    visuals.js                  # presentation-only tuning

  simulation/
    world.js                    # authoritative simulation container
    clock.js                    # fixed step and ecological calendar
    random.js                   # named deterministic streams
    colonies.js                 # registry and shared colony records
    workers.js                  # shared worker lifecycle/update
    labor.js
    foraging.js
    pheromones.js
    spatial-index.js
    nests/
      nest-graph.js             # pure nodes, edges, pressure, capacity
      excavation.js
      circulation.js
    ecology/
      plants.js
      food.js
      seed-banks.js
    lifecycle/
      brood.js
      reproduction.js
      founding.js
      succession.js
    health/
      disease.js
      injury.js
      mortality.js
    conflict/                   # created in Phase 13
      recognition.js
      territory.js
      encounters.js
      alarm.js
      combat.js
      invasion.js

  observation/
    events.js
    snapshot.js
    decisions.js
    causal-chains.js
    metrics.js

  presentation/
    renderer.js
    assets.js
    terrain.js
    ants.js
    nests.js
    ecology.js
    effects.js
    overlays.js
    camera.js

  ui/
    field-note.js
    colony-plate.js
    census.js
    study-lens.js
    controls.js

  input/
    pointer.js
    keyboard.js
    touch.js

  diagnostics/
    profiler.js
    debug-overlay.js
    scenario-runner.js
```

The authoritative update boundary is:

```js
world.update(FIXED_DT);
const observation = observationService.read(world);
presenter.sync(observation, interpolationAlpha);
```

The presenter may retain object references and interpolated transforms, but simulation records may not contain Three.js objects.

---

## 6. Phase 9 — Refactor, measure, and optimize

### Objective

Create a modular, testable, colony-general engine without intentionally changing Phase 8 biological outcomes. Remove known scaling hazards and startup warnings. Preserve the current live presentation while establishing the contracts needed by Phases 10–13.

### Non-goals

- No new biological subsystem.
- No redesigned field note or Study Lens yet.
- No warfare expansion.
- No wholesale rewrite.
- No switch to a framework merely to split files.

### 9A — Freeze the Phase 8E baseline

**Deliverables**

- Record the reviewed commit and current file metrics.
- Add a small profiling harness for simulation step, render, spatial index, pheromones, architecture simulation, architecture presentation, and snapshot/report generation.
- Add deterministic fixtures for these scenarios:
  - normal year;
  - `?demography=abundance`;
  - `?demography=scarcity`;
  - `?succession=amber&flight=force`;
  - `?succession=maturity`;
  - founding stress;
  - young-colony collapse;
  - focused mature and descendant nests.
- Capture seed, query, simulation time, colony totals, stores, brood, plants, nest topology, census, and mortality.
- Add `?debug=1` with p50/p95 timings, update backlog, allocations or object counts, draw calls, simulated/rendered workers, and active visual mode.

**Acceptance criteria**

- Baseline fixtures can be regenerated deliberately and compared automatically.
- The profiler itself costs less than 3% frame time when visible and effectively nothing when disabled.
- A failed deterministic comparison names the subsystem and changed metrics.

### 9B — Establish module boundaries

**Migration order**

1. Extract config and deterministic random helpers.
2. Extract observation/report-only functions without changing their inputs.
3. Extract input and UI DOM code.
4. Extract presentation resources and render functions.
5. Extract pure ecology and lifecycle functions.
6. Leave orchestration in `main.js` until the final step, then make it a thin bootstrap.

Every extraction must be behavior-preserving. Avoid moving and redesigning the same subsystem in one commit.

**Compatibility requirements**

- Preserve `window.advanceTime` and `window.render_game_to_text` until equivalent test APIs are documented.
- Preserve all current query parameters.
- Preserve static hosting with relative imports.
- Preserve the fixed 30 Hz biological step.

**Acceptance criteria**

- `main.js` contains bootstrap and composition only and is below 300 lines.
- No circular module imports.
- Simulation modules do not query DOM elements.
- Presentation modules do not mutate population, stores, brood, routes, or life history.

### 9C — Separate the nest graph from the nest presenter

**Implemented 2026-07-15.** Amber's legacy scan, Slate's legacy scan, and every shared descendant/mature expansion now use pure Map-backed graph records. Three.js curve, tube, chamber, and digging-front resources live in a revision-aware presenter with an explicit release path.

Create pure records:

```js
NestGraph = {
  colonyId,
  entranceNodeId,
  nodes: Map<NodeId, ChamberNode>,
  edges: Map<EdgeId, TunnelEdge>,
  activeProjectIds: [],
  capacity,
  pressure,
  statistics
}
```

`ChamberNode.position` is a serializable `{x, y, z}` record. `TunnelEdge` stores control points or topology, not a `THREE.CatmullRomCurve3`. The presenter builds and caches curves and meshes from graph revisions.

Use a monotonic `graphRevision`. Rebuild geometry only when topology or project progress crosses a meaningful presentation threshold. Do not regenerate tube geometry every frame.

**Acceptance criteria**

- A nest graph can be created, updated, serialized, and tested in Node without DOM or Three.js.
- The live Amber, Slate, and descendant nests match the current topology and appearance within intentional visual tolerance.
- Extinct or replaced nest presentation resources can be released without deleting historical simulation records.

### 9D — Unify worker and colony runtime paths

Define one canonical worker record and one shared update pipeline. Colony/species policy is data:

```js
updateWorker(world, colony, worker, dt);
```

Migrate in this order:

1. shared identity, age, health, energy, cargo, position, and inside/outside location;
2. shared food pickup and delivery contracts;
3. shared navigation and spacing;
4. shared mortality and removal;
5. shared render lookup;
6. role and policy differences expressed through colony/species profiles.

Legacy adapters may exist during migration, but there must be a removal checklist. Do not retain `updateAnt`, `updateRivalAnt`, and `updateYoungWorker` as permanent peer engines.

**Acceptance criteria**

- Every registered colony uses the same worker update entry point.
- Any two foreign colonies can encounter each other through the same spatial query.
- Descendant workers can be selected above and below ground through the same lookup.
- Amber/Slate visual identity remains parameterized, not hard-coded into behavior.

**Implementation result**

- All registered colonies now enter one canonical `updateWorker(world, colony, worker, dt)` runtime. Identity, age, location, position mirrors, cargo synchronization, mortality, removal, foreign-contact lookup, and render lookup are shared.
- Amber, Slate, and descendant decision policies are selected by `colony.workerRuntimePolicy`; visual palettes remain separate `colony.workerPresentation` data and cannot select behavior.
- Surface instances and every underground worker sprite resolve through the same runtime UID index. Underground architecture representatives are restricted to workers whose canonical location is actually underground.

**Temporary policy-adapter removal checklist**

- [x] Remove the former `updateAnt`, `updateRivalAnt`, and `updateYoungWorker` entry points and direct call sites.
- [x] Isolate the remaining `updateAmberWorkerPolicy`, `updateSlateWorkerPolicy`, and `updateDescendantWorkerPolicy` callbacks behind the single canonical runtime.
- [ ] Move those decision-policy bodies from `simulation-app.js` into DOM-free role/profile modules after Phase 9E establishes the final shared scheduling and spatial-query contracts.
- [ ] Replace any colony-specific navigation or delivery branch still embedded in those policy bodies with shared world operations when parity can be checked at the new schedule boundary.
- [ ] Delete the adapter callbacks after the full Phase 9A fixture matrix passes against the extracted role/profile modules; do not keep a second worker engine as fallback.

### 9E — Fix update scheduling and spatial costs

**Work**

- Maintain cached living-worker counts instead of reducing all worker arrays inside technical-cap checks.
- Replace the current repeated surface-grid rebuild pattern with a documented schedule:
  1. build or incrementally refresh before movement;
  2. update all surface workers;
  3. rebuild once for final overlap/contact resolution.
- Use the shared spatial index for food pickup, local encounters, predators, sanitation, and future recognition where beneficial.
- Move low-frequency colony summaries, life-history checks, and architecture pressure calculations to explicit schedules such as 2–4 Hz when per-frame accuracy is unnecessary.
- Update nest presentation only for the focused/transitioning colony; continue simulating all graphs.
- Guard the fixed-step loop against an unbounded catch-up spiral and report dropped or deferred backlog.

**Acceptance criteria**

- No full Amber-array scan is performed for every Slate worker.
- Surface-index rebuild count is visible in debug mode and does not exceed the documented schedule.
- Normal-speed deterministic outcomes remain within the predeclared parity tolerance.
- Four-year horizon runs do not show unbounded memory growth.

**Implementation result (2026-07-16)**

- A birth/death-maintained worker census now supplies regional totals and technical-cap checks without repeatedly reducing every colony array. Registration is idempotent and exact across eclosion, mortality, removal, and colony creation.
- The canonical surface-worker index now performs exactly two full builds per fixed step: one before surface movement and one before final symmetric spacing/contact resolution. Bounded worker refreshes preserve the former between-group visibility boundaries without rebuilding the whole index.
- Deterministic spatial hashes now serve food, remains, local opponent, predator, spider, and sanitation queries. Slate workers no longer scan the full Amber array for routine opponent selection; their rare entrance-delivery qualification retains its sequential same-colony scan because the movement index is intentionally stale until final resolution.
- Low-frequency UI summaries run at 4 Hz. Nest biology continues at the fixed step, architecture pressure reuses revision-aware capacity data, and presentation work is limited to the focused or transitioning underground colony while every nest graph continues simulating.
- The animation loop now caps catch-up work at 16 fixed steps per frame, retains at most four deferred steps, drops older excess, and reports deferred and dropped backlog. Direct deterministic horizon stepping remains unbounded by the display guard.
- Debug diagnostics report full index builds and local refreshes separately. The final normal run recorded 23,604 builds across 11,802 fixed steps (exactly 2.0 builds/step), fixed-step p50 0.8 ms and p95 1.1 ms, spatial p95 0.1 ms, and zero deferred or dropped steps.
- All nine Phase 9A fixtures pass with zero deterministic differences. A four-year run ended with 210 workers across seven active colonies, bounded event/checkpoint histories, bounded transient counts, and nest graphs below their 50-node safety limit.

### 9F — Rendering and resource cleanup

**Work**

- Load sprite atlases before cloning/cropping textures, or use a texture-array/material strategy that never marks an image-less clone dirty.
- Eliminate all startup texture warnings.
- Instance or pool excavation spoil, signals, remains, and other repeated transient visuals.
- Share geometry/materials where variation can be expressed by transforms or instance colors.
- Add explicit resource ownership and disposal for extinct colony presenters, abandoned projects, and replaced lineages.
- Keep surface and underground representative counts separate from biological totals.

**Acceptance criteria**

- Zero console warnings and errors on a clean live load.
- Transient object counts plateau during long runs.
- Draw calls and renderer memory are reported in debug mode.
- Visual LOD does not change deterministic reports.

### 9G — Phase 9 completion gate

Phase 9 is done only when:

- all baseline scenarios pass;
- the simulation can run headlessly without constructing a renderer;
- all colonies use the shared worker runtime;
- nest graphs are presentation-free;
- startup console output is clean;
- normal, abundance, scarcity, founding, succession, predator, and underground interaction regressions pass;
- the documented reference device meets the performance budget established in 9A;
- `progress.md` describes intentional parity changes and removes temporary adapters from the TODO list.

---

## 7. Phase 10 — Observation and causal data

### Objective

Make all later presentation consume a stable, read-only description of the simulation and a bounded event history. Record why decisions changed, not merely the resulting state.

### 10A — Observation snapshot

Create multi-rate snapshots:

- world and selected-worker data: each render;
- colony summaries: 4 Hz;
- ecology and regional summaries: 1 Hz or on revision;
- expensive history aggregates: event-driven.

Suggested shape:

```js
{
  time, calendar, weather, visualMode,
  colonies: [{
    id, lineageId, status, nestPosition,
    population, brood, stores, reserveRatio,
    stress, priority, labor,
    nest: { topologyRevision, capacity, pressure, congestion, projects },
    foraging: { sectors, routes, traffic, failures },
    conflict: { territoryPressure, alarm, recentLosses }
  }],
  selectedWorker,
  plants,
  predators,
  vacancies,
  recentEvents
}
```

Do not deep-copy every worker every frame. Use stable IDs, revision numbers, and focused detail.

### 10B — Normalized event stream

```js
emitObservationEvent({
  id,
  type,
  importance,        // ambient | notable | major | historic
  time,
  position,
  colonyId,
  workerIds,
  entityIds,
  causeEventIds,
  facts
});
```

Initial types include food discovery/delivery, task change, route establishment/loss, excavation start/completion, eclosion, death, infection, outbreak, predator attack, season change, flight, founding, queen death, vacancy, and replacement. Phase 13 adds conflict types.

Use a bounded ring buffer and per-type rate limits. Aggregate routine deliveries instead of emitting thousands of independent UI events.

### 10C — Decision reasons

Whenever a worker changes task, navigation mode, or emergency response, record a semantic reason and the strongest supporting factors:

```js
worker.decision = {
  reason: 'private-food-memory',
  destination: { type: 'food-source', id: 'plant-N07' },
  startedAt,
  factors: { confidence: 0.76, socialTrail: 0.18, hunger: 0.42 }
};
```

Reasons include food scent, private memory, social recruitment, exploration, failed search, congestion reroute, low energy, rain retreat, predator escape, brood demand, sanitation demand, excavation demand, alarm response, and disengagement.

### 10D — Causal chains and relevance

Link events where the simulation already has a real cause:

```text
plant crop decline
→ route failures
→ lower return activity
→ wider exploration
→ stores fall
→ laying slows
→ excavation pauses
```

The observation layer may summarize this chain, but it may not invent causes based only on correlation. If a cause is inferred rather than explicit, label it as an inference in developer/debug output and use conservative language in the exhibit.

### Acceptance criteria

- UI and lenses do not inspect arbitrary simulation globals.
- Every major lifecycle transition emits exactly one normalized event.
- Selecting a worker exposes current action, destination, reason, condition, and recent history.
- Snapshot and event generation does not alter deterministic outcomes.

---

## 8. Phase 11 — Individual and living-nest legibility

### Objective

Make individual behavior and colony condition readable through movement, cargo, location, and physical nest evidence before adding broad scientific lenses.

### 11A — Field note: “the ant knows why”

Default view:

```text
Worker A143
Amber colony · minor · 19 days

RETURNING WITH NEEDLEGRASS SEED
Following a familiar western route.

Destination  entrance cache
Condition    healthy · energy adequate
History      7 deliveries · 2 failed searches
Contribution stores recovery
```

Exact genome values move behind optional specimen details. Default traits become slow/typical/fast, vulnerable/typical/resilient, timid/balanced/aggressive, and ordinary/keen foraging acuity.

### 11B — Visible task language

Roles must be recognized through cargo, cadence, and geography:

- returning forager: visible seed/food and direct motion;
- scout/patroller: broad search, stops, reversals, boundary inspection;
- transfer worker: cache-to-store load;
- excavator: soil pellet and work-front traffic;
- sanitation worker: remains/refuse load;
- nurse: chamber-local brood movement;
- callow: paler, slower, hesitant;
- alarm responder: rapid, sharp, locally directed movement.

Avoid painting workers with bright role colors.

### 11C — Micro-behavior presentation layer

Add pause, antennal sweep, brief nestmate contact, cargo adjustment, grooming, fork hesitation, rain testing, injury stumble, and alarm recoil. Initially these are presentation timers over existing decisions and must not affect biology.

### 11D — Nest as a physical status display

- Granary objects and pile volume derive from actual species/count composition.
- Nursery composition visibly distinguishes eggs, larvae, pupae, and sexual brood.
- Chamber floor exposure shows low stores or underuse.
- Worker density and route movement show congestion.
- Excavation face, soil color, and traffic show active expansion.
- Waste/remains show sanitation load.
- Queen vitality and orphaning alter immediate nest activity.

### 11E — Focused colony plate

Show only when a nest is focused:

```text
Population — contracting
Stores — low
Brood — reduced
Condition — pressured
```

Each item expands into one causal sentence. This is a spatial museum label, not a permanent corner HUD.

### Acceptance criteria

- A 30-second observation reveals at least four worker activities without selection.
- A focused nest can be classified as supplied/stressed, crowded/open, growing/contracting, reproductive/orphaned without reading exact numbers.
- The field note answers who, what, where, why, recent history, and colony contribution.

---

## 9. Phase 12 — Information, ecology, and time made visible

### 12A — Natural trail evidence

Derive subtle ground wear from recent traffic and route confidence: polished soil, reduced loose debris, bent grass, disturbed grains, footprint/dust density, and moving traffic pulses. Keep the evidence faint and reversible under rain and abandonment.

For the current harvester reference, avoid making every foraging direction a permanent trunk trail. Field research reports dispersed fan-shaped foraging and changing daily directions, with cleared trunk trails relatively uncommon. See [Gordon, “The development of an ant colony’s foraging range”](https://stanford.edu/~dmgordon/old2/Gordon1995.pdf).

### 12B — Study Lens

Modes:

1. Natural
2. Chemical — food/recruitment and later alarm channels
3. Traffic — recent density and direction
4. Nest pressure — worker/brood/storage pressure and congestion
5. Foraging memory — explored, successful, stale, failing, recruited sectors
6. Ecology lineage — plant source, carried seed, granary origin, discard cohort, descendant plant
7. Territory — added in Phase 13 as overlapping activity/pressure, never hard borders

Lenses reveal existing state and never change it.

### 12C — Recruitment and rain causality

Make returner contact and departure pulses visible through movement. During rain, show pause, retreat, chemical weakening, memory-led route attempts, hesitation, rediscovery, and route recovery or collapse.

### 12D — Plant and seed loop

Show crop depletion on the plant, seed pickup provenance, cache transfer, granary composition, damp sprouting/discard, germination, and ant-dispersed descendants. A completed loop may receive one temporary natural-history annotation.

### 12E — Seasonal behavior

Make the season recognizable through colony and ecological behavior before its label: nursery and germination in spring, mature seed production and alates in summer, collection/litter in autumn, clustering and store depletion in winter.

### Acceptance criteria

- Established and collapsing information routes are visible in Natural mode.
- Each Study Lens maps to authoritative snapshot fields.
- An observer can follow one complete seed-to-descendant-plant chain.
- Rain provides a repeatable visible experiment in information loss and recovery.

---

## 10. Phase 13 — Territoriality and emergent warfare

### Objective

Replace the current Amber–Slate proximity-damage special case with an all-colony system driven by identity, learned neighbors, spatial overlap, local economics, alarm communication, injury, and withdrawal. Preserve small encounters as the common outcome; allow larger battles only when local feedback sustains them.

### Biological scope for the default profile

The current code names a harvester-ant reference and specifically comments on *Pogonomyrmex barbatus*. Research on that species supports these defaults:

- colonies compete over foraging area;
- encounters with neighbors can reduce foraging toward the encounter site;
- neighboring colony odors can be learned through repeated contact;
- many non-nestmate interactions do not become fights;
- individual workers can specialize in interaction or fighting;
- foraging ranges shift and unused areas can be taken by neighbors.

See [Brown & Gordon, “Individual Specialisation and Encounters between Harvester Ant Colonies”](https://web.stanford.edu/~dmgordon/old2/BrownGordon1997.pdf) and [Gordon, “The development of an ant colony’s foraging range”](https://stanford.edu/~dmgordon/old2/Gordon1995.pdf).

Cuticular hydrocarbon recognition is represented as a compact signature/threshold model, not a claim that the simulator reproduces real chemistry molecule by molecule. Experimental work supports colony-specific hydrocarbon cues and threshold-like aggression responses; see [Martin et al., “Deciphering the Chemical Basis of Nestmate Recognition”](https://pmc.ncbi.nlm.nih.gov/articles/PMC2895867/) and [Yusuf et al., nestmate recognition in *Pachycondyla analis*](https://pubmed.ncbi.nlm.nih.gov/20349337/).

### 13A — Recognition and learned neighbors

```js
colony.conflictProfile = {
  chemicalSignature: Float32Array(6),
  recognitionTolerance,
  strangerAggression,
  neighborAggression,
  retreatBias,
  pursuitDistance,
  alarmSensitivity,
  attackProfile
};
```

Workers inspect only at close range. Encounter states:

```text
detected → approach/avoid → antennal inspection
→ accepted / uncertain / recognized neighbor / stranger
→ disengage / challenge / grapple
```

Each exterior worker keeps a very small neighbor-memory cache: colony ID or signature centroid, encounter count, recent outcome, and familiarity decay. Colony-level shared memory may aggregate repeated encounters without giving every worker omniscience.

**Acceptance criteria**

- No worker identifies a foreign colony at long range.
- Related or chemically similar colonies use the same threshold logic; no lineage-specific branch.
- Descendant/successor colonies participate immediately through their profiles.
- Most default-profile contacts can terminate without injury.

### 13B — Dynamic territory and encounter memory

Use a low-resolution field aligned with the existing world/spatial systems:

```js
TerritoryCell = {
  presenceByColony,
  trafficByColony,
  encounterPressure,
  casualtyPressure,
  foodValue,
  danger,
  lastUpdated
};
```

Territory is the area a colony repeatedly visits and can continue using. It is not an ownership polygon. Presence decays; food depletion, rain, season, losses, orphaning, and route abandonment can contract it. Neighbor withdrawal allows gradual incursion.

### 13C — Local encounter and injury state machine

Replace continuous adjacent hit-point exchange with discrete interaction states and pulses:

- threat posture;
- mandible contact;
- grapple/hold;
- bite or species-configured chemical/sting attack;
- pin with local numerical support;
- escape attempt;
- disengage;
- injury/death.

The default attack profile must use only biologically appropriate capabilities. Injury reuses and extends the existing persistent health system: locomotion, carrying, antennal sensing, and future combat response can be impaired.

An escalation score may include worker aggression, fighter/patroller specialization, local ally advantage, nest proximity, resource value, learned-neighbor history, recent casualties, injury, and isolation. Do not expose the score to the ordinary UI.

### 13D — Alarm channel and reinforcement

Generalize pheromones to named channels. At minimum:

```js
pheromones[colonyId] = {
  food,
  alarm,
  dangerAvoidance
};
```

Use bilinear sampling and the existing local probes. Alarm is localized, short-lived, and intensity-dependent. It changes response probabilities; it does not remotely assign an army.

Reinforcements must travel from their real positions. Guards/patrollers respond most strongly; exterior foragers respond conditionally; nurses remain underground unless a breach threatens the nest. Excess alarm can cause congestion and economic loss.

### 13E — Resource contests and colony economics

```js
contestValue = remainingNutrition
  * scarcityModifier
  * routeConfidence
  / (travelCost + casualtyRisk + congestionCost);
```

Colonies allocate patrol/defense labor through the same demand system as foraging, nursing, transfer, sanitation, and excavation. Defense must reduce other work. A colony can abandon a rich source when replacement cost is too high.

Default progression:

```text
overlapping foraging fans
→ repeated inspection
→ reduced flow or local challenge
→ temporary alarm
→ withdrawal, divided access, or sustained skirmish
```

### 13F — Nest defense and species-gated invasion

The shared nest graph enables real chokepoint defense, but the default *P. barbatus*-like profile should keep `nestRaidProbability` and `broodTheft` disabled unless research/tuning supports them.

The generic framework may support, for profiles that enable it:

- entrance pressure and blockade;
- graph-edge defender advantage;
- brood relocation away from threatened nodes;
- queen-chamber priority;
- retreat before total loss;
- food or brood theft;
- rare occupation or collapse.

Slave raiding, permanent mixed-species labor, and supercolony tolerance are later species modules. They are not part of Phase 13 completion.

### 13G — Aftermath and de-escalation

Conflict ends locally through falling alarm, distance, injury, numerical disadvantage, source depletion, route loss, weather, seasonal shutdown, or colony stress. There is no global peace timer.

Aftermath connects to existing systems:

- sanitation retrieves remains;
- injury reduces labor;
- casualties raise replacement cost;
- foraging shifts away from dangerous areas;
- midden and disease pressure rise;
- brood/laying/excavation respond to lost labor and stores;
- frontier memory decays over time.

### 13H — Warfare presentation

**Individual**

```text
Inspecting an unfamiliar worker
Signature differs from known neighbors
Local support: 2 workers
Response: challenge, retreat still possible
```

**Colony**

```text
Western range — contested
Defense burden — elevated
Recent losses — 8 workers
Needlegrass route — reduced
```

**Landscape**

- inspection pauses and hesitation zones;
- patrol concentration;
- detoured or abandoned routes;
- localized reinforcement streams;
- remains and sanitation traffic;
- overlapping territory pressure in the optional lens;
- no hard red/blue border.

### Phase 13 completion gate

- Conflict works between any registered pair of colonies.
- Recognition requires local sensory contact.
- Most normal-profile encounters remain nonlethal.
- Alarm recruits real nearby workers and decays cleanly.
- Defense measurably reduces other labor.
- Valuable overlap can escalate; marginal overlap often ends in withdrawal.
- Casualties affect stores, brood, excavation, and future territorial pressure.
- Default harvester colonies do not perform species-inappropriate raids.
- Conflict is understandable in Natural mode before opening the lens.
- No global combat mode or Amber/Slate branch remains.

---

## 11. Phase 14 — Founding, succession, and lineage presentation

Phase 8E already simulates the history. This phase makes it visible.

### 14A — Nuptial flight spectacle

Show pre-flight alate gathering, suitable weather/light convergence, release from multiple nests, regional swarm, mating/descent, shed wings, and divergent founding outcomes. Do not force the camera; offer a focus prompt.

### 14B — Foundress journal

Selected queen note: site quality, reserves, chamber status, brood, threats, recent milestones, ancestry, stored sire count, and vacancy claim where applicable.

### 14C — Colony milestones

Record and briefly annotate chamber sealing, first egg/larva/pupa/nanitic, entrance opening, first forage, first delivery, establishment, maturity, first alates, queen death, orphaning, vacancy, and replacement.

### 14D — Regional lineage sheet

An optional natural-history genealogy shows parent colony, failed foundations, living descendants, extinct lineages, vacated territories, and replacements. It is a study document, not a management tree.

### Acceptance criteria

- A colony can be followed from foundress to mature reproductive colony or collapse.
- Succession at a vacated territory is visually attributable to the former and replacement lineages.
- Historic annotations are sparse, ranked, and retained in a bounded history.

---

## 12. Phase 15 — Camera, interaction, mobile, sound, and accessibility

### 15A — Contextual camera

Frame the selected worker and destination direction; follow entrance transitions; lower to foundress scale; widen for flights; focus conflict only on request; adjust pitch for lenses.

### 15B — Surface/underground continuity

Follow a worker through the entrance, pass through soil with particles and muffled ambience, preserve selection and orientation, and reveal the actual connected graph progressively.

### 15C — Contextual controls

Bottom-center strip:

- Surface / Below
- Colony focus
- Time
- Study Lens
- Events / experiments

Keyboard shortcuts remain accelerators. Events expose food, rain, predator, and flight interventions without presenting them as debugging secrets.

### 15D — Touch

- tap ant: inspect;
- one-finger drag: orbit;
- two-finger drag: pan;
- pinch: zoom;
- double-tap terrain: focus;
- long press: contextual observation/intervention wheel.

### 15E — Sound and accessibility

Use restrained soil, traffic, rain, chamber, web, predator, and flight textures. Add reduced-motion behavior, contrast review, keyboard focus for UI controls, non-color lens cues, and a text alternative for the selected event/worker.

---

## 13. Phase 16 — Empirical calibration and long-run validation

### 16A — Declare the reference profile

Resolve the current ambiguity between generic “harvester-ant reference population” and *Pogonomyrmex barbatus*. Document real units, compressed visual time, intentionally stylized parameters, and which warfare behaviors are enabled.

### 16B — Automated sweeps

Run multiple seeds across normal, abundance, scarcity, drought, rain, predator, disease, high competition, isolated colony, high founding success, orphaning, and succession. Track population, nest capacity, stores, brood survival, routes, plants, conflict contacts/fights/deaths, defense labor, founding, vacancy, performance, and memory.

### 16C — Failure-mode gates

- no unbounded plant, food-record, event, nest-graph, or visual-object growth;
- colonies can grow, equilibrate, decline, and recover;
- scarcity can kill colonies without hidden caps;
- predators/disease/conflict matter without guaranteeing extinction;
- descendant colonies can mature and reproduce;
- orphan decline and replacement remain possible but not guaranteed;
- conflict produces stable boundaries and withdrawal more often than extermination in the default profile;
- LOD and headless acceleration stay within defined biological tolerances.

---

## 14. Cross-phase verification matrix

Every implementation package must run the relevant subset.

| Scenario | Required checks |
|---|---|
| Clean load | no errors/warnings; assets ready; surface visible |
| Normal 1 year | deterministic totals; routes; stores; brood; ecology |
| Abundance 2–4 years | growth beyond old caps; memory plateau; visual LOD |
| Scarcity 2 years | laying pause, brood/adult loss, no hidden population deletion |
| Rain | retreat, pheromone decay, route recovery/loss |
| Predator and spider | flee, injury/death, sanitation, route effects |
| Founding stress | failure path, retained site history, no false registration |
| Young collapse | worker/queen/brood loss, persistent site, registry consistency |
| Succession | queen death, orphan decline, vacancy, claim/release/replacement |
| Underground focus | topology, capacity, circulation, selection, no hidden visual work |
| Multi-colony conflict | all-colony recognition, alarm, withdrawal, casualties, labor cost |
| Mobile viewport | controls, selection, orbit/pan/zoom, readable notes |

Minimum commands/checks remain:

```text
node --check main.js and all extracted modules
deterministic fixture comparison
headless horizon run
browser smoke and console inspection
surface and underground screenshots at representative load
interaction regression for food, obstacle, rain, pause, time, nest focus, and selection
```

Do not declare a phase complete from a screenshot alone. Do not declare presentation complete from state JSON alone.

---

## 15. Coding-AI execution protocol

For every subphase:

1. Read this document, current `progress.md`, and the files in scope.
2. State the behavior invariants and performance metrics that must not regress.
3. Implement one bounded package; avoid opportunistic simulation additions.
4. Keep compatibility adapters explicit and list their removal condition.
5. Run syntax, deterministic, long-horizon, interaction, console, and visual checks proportional to the change.
6. Record exact query parameters, seed, simulated time, and results.
7. Update `progress.md` with what was implemented, what was intentionally unchanged, verification evidence, and remaining adapters.
8. Stop if a parity change cannot be explained by the intended work.

### Required coding conventions

- Prefer plain records and functions over deep class hierarchies.
- Pass `world`, `colony`, and explicit services rather than reading globals.
- Use stable IDs at subsystem boundaries.
- Keep simulation coordinates as plain numeric data; convert to Three.js types in presentation.
- Own random streams by subsystem to avoid unrelated sequence drift during refactors.
- Never key generalized behavior on `amber`, `slate`, `HOME_COLONY_ID`, or `RIVAL_COLONY_ID`.
- Treat technical ceilings as safeguards and report blocks explicitly.
- Comment the reason for a tuning formula and its unit/scale, not a paraphrase of the code.

---

## 16. Immediate work order: Package 9A.1

The first coding-AI assignment should be narrow:

### Deliverables

1. Add `src/diagnostics/profiler.js` with named timing scopes and bounded rolling p50/p95 samples.
2. Add `?debug=1` overlay showing:
   - fixed-step and render time;
   - update backlog;
   - surface-index builds;
   - simulated/rendered surface and underground workers;
   - living colonies;
   - draw calls, geometries, textures;
   - active visual LOD;
   - event and transient counts where available.
3. Add a deterministic fixture exporter using the existing report hook.
4. Save baseline fixtures for normal, abundance, scarcity, and succession scenarios at pinned simulated times.
5. Fix no behavior and move no major subsystem in this package.

### Definition of done

- The Phase 8E baseline is reproducible.
- Debug mode is hidden by default.
- Profiling does not change deterministic state.
- The clean live load, underground toggle, selection, pause, and accelerated horizon still work.
- Existing startup warnings are captured as a Phase 9F issue, not silently ignored.

After 9A.1, execute 9B module extraction. Do not begin warfare or Study Lens implementation until the shared worker runtime, pure nest graph, and observation contract are in place.

---

## 17. Final product thesis

Antland should not become compelling by adding the largest possible list of ant behaviors. It should become compelling because a viewer can watch the simulation's invisible logic become physical history:

```text
a plant sets seed
→ a worker discovers it
→ returner contacts activate departures
→ a route strengthens
→ stores and brood rise
→ crowding opens a new chamber
→ neighboring foraging fans overlap
→ inspectors recognize a familiar rival
→ traffic withdraws or a local alarm escalates
→ casualties change labor and future growth
→ rain erases part of the information network
→ the colony adapts, contracts, or recovers
→ a later generation inherits the altered landscape
```

Phase 8 created the living regional system. Phase 9 must make that system safe to extend. Phases 10–15 must make it perceptible. Phase 16 must keep it honest.
