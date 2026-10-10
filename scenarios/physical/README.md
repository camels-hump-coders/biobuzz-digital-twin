# Physical-fidelity fixtures

Regression fixtures for the failures the physical robot exposed on 2026-10-08 (handoff *lessons from the physical
robot*; design in `docs/superpowers/specs/2026-10-09-physical-fidelity-fixtures-design.md`). They run the team's
`BioBuzz: Auto 30s + Drive` with the team's saved robot (`twinSettings: true`), so pass `--team <team repo>`:

```bash
pnpm twin-test --team ~/dev/github.com/camels-hump-coders/biobuzz scenarios/physical/*.json --out-dir /tmp/physical-reports
```

Several fixtures are **expected to fail**: that is the point. An older broad "full auto passed" test would have
missed each of them.

| fixture | shows | verdict on the local TeamCode (`nowell/auto-30` @ bedfe9c), 2026-10-09 |
|---|---|---|
| 00-route-tiles | finishing turns at the 15 % floor stall on the estimated tiles profile | **pass**: stall at 2.3 s into TURN_ALONG_WALL (77° of 90°), 15 %, 1.6 A per motor, encoders frozen; the auto ends "ABORTED (time budget used)" exactly like the robot |
| 01-route-ideal | the old green run, labelled ideal in its manifest, with physical outcome checks on | pass: 4 pulses → 2 launches (0.4 s pulses), 2 POLLEN picked in the garden, parked overlapping the loading zone |
| 10-feed-short-pulse | 0.4 s pulses: fewer launches than pulses | pass: 4 pulses, 2 launches |
| 11-feed-long-pulse | 1.0 s pulses launch | pass: 4 pulses, 4 launches |
| 12-empty-hopper | launches follow the balls aboard, not the pulses | pass: 4 pulses, 2 launches with 2 balls |
| 20-tag-cover-lower | the lowered cell covered: the raised cell must be seen alone | **fails, a finding**: with the saved robot (camera 17° up, 13 in high) the code never sees enough raised-cell tags from the 20 in spot; in the green run it was aiming at the LOWERED cell ("tier 2, raised cell inferred"), so covering it removes the only target and nothing fires. The handoff's physical camera is 35° up: the manifest shows the mismatch |
| 21-tag-misread-mix | lower tags decoded as upper ids while aiming | pass (informational): the fault engages at AIM_SHOOT, the blended BLUE SCORING cluster is rejected, no launch |
| 22-tag-latency-500ms | stale frames from AIM_SHOOT: no shot, bounded leg | **fails as predicted**: no launch, but the leg lasts 48 s instead of a 5 s bound (the no-shot timer only counts at a wall; handoff c8d5ed0 fixes it) |
| 30-collect-miss | intake runs 24 in out from the garden: states visited, nothing collected | **fails by design** on the garden-pick check (a wrong-end variant still brushed a corner ball while turning: the twin's contact intake is unforgiving but not blind) |
| 40-deadline-28s | physical feed timing inside 28 s | pass: 4 launches, parked; collection skipped for lack of time |
| 50-bind-conflict | scenario range vs. bound range | **fails at setup by design**: "expected 54, effective 72 (bound)" |
| 51-bind-conflict-nobind | same with bindings off | pass: reaches AIM_SHOOT, refuses the 72 in shot under the 54 ± 6 in window, no launch |
| 60-unsupported-pixels | a coverage the twin cannot provide | UNSUPPORTED |

Every report carries `manifest` (robot identity, physics and perception with provenance, every TeamCode setting with
its source), `events` (stall, feed, launch, fault, status) and `timing` (simulated/wall ratio, held packets). A run
the machine could not keep near real time is `inconclusive`, not green.
