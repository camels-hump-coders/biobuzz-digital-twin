# Physical-fidelity fixtures

Regression fixtures for the failures the physical robot exposed on 2026-10-08 (handoff *lessons from the physical
robot*; design and the 2026-10-10 follow-up in `docs/superpowers/specs/2026-10-09-physical-fidelity-fixtures-design.md`). They run the team's
`BioBuzz: Auto 30s + Drive` with the team's saved robot (`twinSettings: true`), so pass `--team <team repo>`:

```bash
pnpm twin-test --team ~/dev/github.com/camels-hump-coders/biobuzz scenarios/physical/*.json --out-dir /tmp/physical-reports
```

Several fixtures are **expected to fail**: that is the point. An older broad "full auto passed" test would have
missed each of them.

| fixture | shows | verdict on the team's TeamCode (`6e7a398`, saved rear-shooter robot, camera 35° up), 2026-10-10 |
|---|---|---|
| 00-route-tiles | the 25 % finishing floor turns on the estimated tiles profile without stalling | pass: TURN_ALONG_WALL → DRIVE_ALONG_WALL, no stall episode |
| 02-route-tiles-turn-15pct | the same turn capped at 15 % (the old 14 % command) stalls | **pass, by stalling**: frozen encoders and a stall current in the finishing turn, the auto runs out its budget, as the robot did at 81° |
| 01-route-ideal | the green run, labelled ideal in its manifest, with physical outcome checks on | pass: 4 pulses → 4 launches, 2 POLLEN picked in the garden, parked overlapping the loading zone |
| 10-feed-short-pulse | 0.4 s pulses: fewer launches than pulses | pass: 4 pulses, 2 launches |
| 11-feed-long-pulse | 1.0 s pulses launch | pass: 4 pulses, 4 launches |
| 12-empty-hopper | launches follow the balls aboard, not the pulses | pass: 4 pulses, 2 launches with 2 balls |
| 20-tag-cover-lower | the lowered cell covered: the raised cell must be seen alone | pass: raised blue cell acquired (h 58 in, tilt 30°), 4 launches. With the earlier saved robot (camera 17° up) this failed: the raised cluster was never visible enough from the spot and the code aimed at the lowered cell |
| 21-tag-misread-mix | lower tags decoded as upper ids while aiming, through SDK-style clusters | pass (informational): the fault engages at AIM_SHOOT; with the robot's individual-tag library the impostors are singles the consensus rejects, 4 launches |
| 22-tag-latency-500ms | stale frames from AIM_SHOOT: no shot, bounded leg | pass: no launch, AIM_SHOOT → TURN_BACK in 7.2 s (48 s on the pre-handoff code) |
| 23-tag-mix-consensus | the captured frame: raised 42/43/44/45 plus the lowered 40/41 decoding as 44/45, as six single detections | pass: the four consistent raised tags beat the two impostors in `TagClusterConsensus`, 4 launches |
| 24-tag-tie | raised ids pairwise swapped (42↔44, 43↔45): two incompatible two-tag groups, equally supported | pass: ambiguous on every frame, no launch, the fixed-spot no-shot bound ends the leg |
| 30-collect-miss | intake runs 24 in out from the garden: states visited, nothing collected | **fails by design** on the garden-pick check |
| 40-deadline-28s | physical feed timing inside 28 s | pass: 4 launches, parked in the loading zone; collection skipped for lack of time |
| 50-bind-conflict | scenario range vs. bound range | **fails at setup by design**: "expected 54, effective 72 (bound)" |
| 51-bind-conflict-nobind | same with bindings off | pass: reaches AIM_SHOOT, refuses the far shot under the 54 ± 6 in window, no launch |
| 60-unsupported-pixels | a coverage the twin cannot provide | UNSUPPORTED |
| 70-frame-front / 71-frame-rear | the shooter-first drive-out with a front and with the saved rear shooter | pass: both move 6.5 in toward the field centre and end within 3 in of the same point |
| 80-stop-mid-feed | STOP while the feeder is pulsing | pass: stopped after the third launch, every commanded output zero |

The team's own `TeamCode/twin-scenarios` run on the same host: `auto-full-plan-diagnostic` (45 s, full route, 4 shots,
garden pollen, parked), `auto-40-real-shot-range` (fixed 54 in calibration refuses the far shot and parks) and
`stationary-single-shot` pass; `auto-30s-far-side-collect-session` fires 4 and parks but skips the garden for time
inside 30 s with 1.0 s pulses, as the team's docs record.

Every report carries `manifest` (robot identity, physics and perception with provenance, every TeamCode setting with
its source), `events` (stall, feed, launch, fault, status) and `timing` (simulated/wall ratio, held packets). A run
the machine could not keep near real time is `inconclusive`, not green.
