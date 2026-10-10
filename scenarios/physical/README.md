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
| 22-tag-latency-500ms | stale frames from AIM_SHOOT: no shot, bounded leg | pass: no launch, AIM_SHOOT → TURN_BACK in 6.3 s (the match clock stated; under the inherited practice clock the leg never ends, which the harness warns about) |
| 23-tag-mix-consensus | the captured frame: raised 42/43/44/45 plus the lowered 40/41 decoding as 44/45, as six single detections | pass: the four consistent raised tags beat the two impostors in `TagClusterConsensus` |
| 24-tag-tie | raised ids pairwise swapped (42↔44, 43↔45): two incompatible two-tag groups, equally supported | pass: ambiguous on every frame, no launch, the no-shot bound ends the leg in 6.2 s |
| 25-spot-45in-no-shot | **SG-002**: the real packaged profile (solver required, 60°), bindings off, standing 45 in from the opening | pass: raised cell locked and centred, code reports 44 in (truth 45.5), range gate asks for more distance, **flywheel never commanded**, leg ends on the 5 s bound in 6 s |
| 26-spot-12in-departure | **SG-002**: the current 12 in departure, measured | pass: the spot stands 55.6 in from the opening, the code reports 54 (within 2 in of truth on every sample), the solver accepts and 4 balls launch; departure measured 13.5 in |
| 27-upgrade-saved-profile | **SG-001**: a profile saved before the solver keys existed is what the code reads | pass: `launchAngleDeg / launchAngleMeasured / adaptivePower` reach the code missing (manifest `profile.mode: persisted`, three missing keys), telemetry says `solver unavailable: launch angle is unmeasured`, no flywheel, leg ends on the bound |
| 29-bind-reject | **SG-001**: a real-profile parity run with bindings on | **fails at setup by design**: names the 8 bound calibration keys (shotRangeIn, shotPower, launchAngleDeg, exitHeightIn, targetHeightIn, powerTable, launchAngleMeasured, minShotRangeIn) |
| 30-collect-miss | intake runs 24 in out from the garden: states visited, nothing collected | **fails by design** on the garden-pick check |
| 31-garden-contact | **SG-005**: the along-wall leg runs the full hopper into a pile on the wall | pass: `contact` 0.9 s into the leg (chassis held by the chain, shafts stalled on the tiles grip), the code's own `STALL_SETTLE` 2.8 s in ("approach stalled in DRIVE_ALONG_WALL: less than 0.25 in progress in 1.0 s"), then aiming from there |
| 40-deadline-28s | physical feed timing inside 28 s | pass: 4 launches, parked overlapping the loading zone inside 28 s; collection skipped for lack of time |
| 41-practice-timers-stop | **SG-007**: `pauseAimTimers` on at the 45 in spot | pass: `Aim timers : PAUSED - PRACTICE`, still in AIM_SHOOT after 30 s with the flywheel never commanded, every output zero after STOP |
| 50-bind-conflict | scenario range vs. bound range | **fails at setup by design**: "expected 54, effective 72 (bound)" |
| 51-bind-conflict-nobind | same with bindings off | pass: reaches AIM_SHOOT with the scenario's 54 in effective; on the solver-required code the 55.6 in spot is accepted and 4 balls launch (the fixed window no longer decides) |
| 60-unsupported-pixels | a coverage the twin cannot provide | UNSUPPORTED |
| 70-frame-front / 71-frame-rear | the shooter-first drive-out with a front and with the saved rear shooter | pass: both end at the same field point |
| 80-stop-mid-feed | STOP while the feeder is pulsing | pass: every commanded output zero after STOP |

**Speed raise (team commits `d8dd552` then `796f2e1`: drive/turn 0.8, spot legs 0.6 then 0.45, approach gain 0.12, collect
where the pile holds the robot), same day.** The fixtures now take the drive and turn powers from the team's profile instead
of pinning 0.4. On the tiles profile, before → 0.6 legs → 0.45 legs: the 12 in departure 1.3 s / 0.9 s / 1.0 s with the
encoder reading 12.8 / 15.0 / 14.1 in at the shot (target 12), the 90° turn 1.5 / 1.0 / 1.2 s settling inside the 3°
tolerance without hunting, the 20 in along-wall leg 1.7 / 1.1 / 1.2 s reading 21.3 / 23.3 / 23.1 in. The overshoot grew
with the approach gain (ramp from 3.75 in at 0.12), not with the leg power. No stall on the route, 4 launches, parked. In
the garden the chassis is now held by the row's outer balls (outside the intake mouth, squeezed on the wall) and the
code's new collect watchdog collects where it was held: 3 POLLEN aboard at PARKED on tiles, 2 on ideal; STALL-OK's
no-stall check therefore covers the route up to the shot. GARDEN-CONTACT (0.3 approach power) trips `STALL_SETTLE` 1.3 s
into the leg and the robot ends with 4 POLLEN; at 0.6 the chassis shoved the single-ball column aside instead. Three twin
faults surfaced and were fixed on the way: a running intake with room was being held by balls it was swallowing, a
squeezed ball knocked the chain behind it loose, and a quarter-second block latch let the encoders creep against a pile
that stops real wheels dead. Of the team's twelve scenarios eleven pass; `auto-30s-range-blocked` still fails on its own
expectations (the 55 in drive-out ends at the pollen row with "wall behind, cannot back away", the camera sees the cell
from the mark so "no sighting yet" never prints, and no "BLOCKED" wheel-spin watchdog line appears).

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
