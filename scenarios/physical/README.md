# Physical-fidelity fixtures

Regression fixtures for the failures the physical robot exposed on 2026-10-08 (handoff *lessons from the physical
robot*; design and the 2026-10-10 follow-up in `docs/superpowers/specs/2026-10-09-physical-fidelity-fixtures-design.md`). They run the team's
`BioBuzz: Auto 30s + Drive` with the team's saved robot (`twinSettings: true`), so pass `--team <team repo>`:

```bash
pnpm twin-test --team ~/dev/github.com/camels-hump-coders/biobuzz scenarios/physical/*.json --out-dir /tmp/physical-reports
```

Several fixtures are **expected to fail**: that is the point. An older broad "full auto passed" test would have
missed each of them.

| fixture | shows | verdict on the team's TeamCode (`a962746`, saved rear-shooter robot, camera 35° up), 2026-10-10 |
|---|---|---|
| 00-route-tiles | the 25 % finishing floor turns on the estimated tiles profile without stalling | pass: TURN_ALONG_WALL → DRIVE_ALONG_WALL, no stall episode |
| 02-route-tiles-turn-15pct | the same turn capped at 15 % (the old 14 % command) stalls | **pass, by stalling**: frozen encoders and a stall current in the finishing turn, as the robot did at 81° |
| 01-route-ideal | the green run, labelled ideal in its manifest, with physical outcome checks on | pass: 4 pulses → 4 launches, garden pollen picked, parked overlapping the loading zone |
| 10-feed-short-pulse | 0.4 s pulses: fewer launches than pulses | pass: 4 pulses, 2 launches |
| 11-feed-long-pulse | 1.0 s pulses launch | pass: 4 pulses, 4 launches |
| 12-empty-hopper | launches follow the balls aboard, not the pulses | pass: 4 pulses, 2 launches with 2 balls |
| 20-tag-cover-lower | the lowered cell covered: the raised cell must be seen alone | pass: raised blue cell acquired (h 58 in, tilt 30°), launches |
| 21-tag-misread-mix | lower tags decoded as upper ids while aiming, through SDK-style clusters | pass (informational): with the robot's individual-tag library the impostors are singles the consensus rejects |
| 22-tag-latency-500ms | stale frames from AIM_SHOOT: no shot, bounded leg | RERUN22 |
| 23-tag-mix-consensus | the captured frame: raised 42/43/44/45 plus the lowered 40/41 decoding as 44/45, as six single detections | pass: the four consistent raised tags beat the two impostors in `TagClusterConsensus` |
| 24-tag-tie | raised ids pairwise swapped (42↔44, 43↔45): two incompatible two-tag groups, equally supported | RERUN24 |
| 25-spot-45in-no-shot | **SG-002**: the real packaged profile (solver required, 60°), bindings off, standing 45 in from the opening | pass: raised cell locked and centred, code reports 44 in (truth 45.5), range gate asks for more distance, **flywheel never commanded**, leg ends on the 5 s bound in 6 s |
| 26-spot-12in-departure | **SG-002**: the current 12 in departure, measured | pass: the spot stands 55.6 in from the opening, the code reports 54 (within 2 in of truth on every sample), the solver accepts and 4 balls launch; departure measured 13.5 in |
| 27-upgrade-saved-profile | **SG-001**: a profile saved before the solver keys existed is what the code reads | pass: `launchAngleDeg / launchAngleMeasured / adaptivePower` reach the code missing (manifest `profile.mode: persisted`, three missing keys), telemetry says `solver unavailable: launch angle is unmeasured`, no flywheel, leg ends on the bound |
| 29-bind-reject | **SG-001**: a real-profile parity run with bindings on | **fails at setup by design**: names the 8 bound calibration keys (shotRangeIn, shotPower, launchAngleDeg, exitHeightIn, targetHeightIn, powerTable, launchAngleMeasured, minShotRangeIn) |
| 30-collect-miss | intake runs 24 in out from the garden: states visited, nothing collected | **fails by design** on the garden-pick check |
| 31-garden-contact | **SG-005**: the along-wall leg runs the full hopper into a pile on the wall | RERUN31 |
| 40-deadline-28s | physical feed timing inside 28 s | RERUN40 |
| 41-practice-timers-stop | **SG-007**: `pauseAimTimers` on at the 45 in spot | pass: `Aim timers : PAUSED - PRACTICE`, still in AIM_SHOOT after 30 s with the flywheel never commanded, every output zero after STOP |
| 50-bind-conflict | scenario range vs. bound range | **fails at setup by design**: "expected 54, effective 72 (bound)" |
| 51-bind-conflict-nobind | same with bindings off | RERUN51 |
| 60-unsupported-pixels | a coverage the twin cannot provide | UNSUPPORTED |
| 70-frame-front / 71-frame-rear | the shooter-first drive-out with a front and with the saved rear shooter | pass: both end at the same field point |
| 80-stop-mid-feed | STOP while the feeder is pulsing | pass: every commanded output zero after STOP |

Every match fixture sets `matchAuto.pauseAimTimers: false` explicitly: the team's bundled profile now ships the practice
clock on, and twin-test warns (`warnings` in the report, `timing.practiceTimers`) when a fixture inherits it, because a
paused aim deadline invalidates every "leg ends within N s" expectation.

The team's own `TeamCode/twin-scenarios` on the same host (`a962746`): `auto-full-plan-diagnostic`,
`stationary-single-shot`, `auto-solver-shot` and `auto-approach-stall` pass; `auto-30s-far-side-collect-session` fires 4
and skips the garden for time inside 30 s, as their docs record; `auto-40-real-shot-range` and
`auto-approach-stall-no-tags` fail **because of their own bundled `pauseAimTimers = true`**: both expect the 5 s no-shot
bound, which the practice clock pauses. Their ledger (SG-007) says timer fixtures must set it explicitly; the harness
warning names it in both reports.

Every report carries `manifest` (robot identity, physics and perception with provenance, every TeamCode setting with
its source), `events` (stall, feed, launch, fault, status) and `timing` (simulated/wall ratio, held packets). A run
the machine could not keep near real time is `inconclusive`, not green.
