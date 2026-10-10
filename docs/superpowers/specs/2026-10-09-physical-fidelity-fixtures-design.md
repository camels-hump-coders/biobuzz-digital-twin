# Physical-fidelity fixtures: what the robot taught the twin

Date: 2026-10-09. Source: the team's handoff *"BIOBUZZ digital twin: lessons from the physical robot"* (eleven
incidents G01–G11, a regression suite and a harness contract). This spec turns it into twin features. It was written
and executed without review gates at the user's standing request; every assumption is marked.

## 0. What is true on this machine

- The team checkout at `~/dev/github.com/camels-hump-coders/biobuzz` is branch `nowell/auto-30` at `bedfe9c`. The
  handoff's anchor commits (`5ffe48f` … `158869b`), `CellObservations`, `TagClusterConsensus`, the 54 ± 6 in fixed-shot
  profile, `MatchDriveFrame` and the diagnostic scenarios are **not** here and not on its remote. The twin work below
  is designed from the handoff's descriptions and verified against the local TeamCode where it applies; the fixtures
  carry over unchanged once that code is pulled.
- The local TeamCode consumes **only** `AprilTagClusterDetection` (`rawPose`, `R`, `metadata.name`,
  `percentClusterFound`, `frameAcquisitionNanoTime`). Individual-tag faults therefore have to flow through the shim's
  SDK-style grouping to reach it, which is exactly where the real contamination happened.
- The team's route finishes turns with `MIN_TURN = 0.14`, drives at `drivePower` 0.5 (session: 0.4), feeds the
  windmill at 0.2 for `feedSeconds` 0.4 and recovers 0.6 s, four balls, 28 s budget with a 10 s return reserve.

## 1. Three things kept apart

| Layer | Owner | Examples |
|---|---|---|
| World truth | `src/sim/*`, `match`, `robot` | pose, ball positions, which tags are physically covered, launches |
| Robot observations | `src/runtime/*` → host → shim | encoders, current, IMU, decoded tag IDs and poses (possibly faulty) |
| Test judgement | `scripts/twin-test.mjs` | verdict per check, infrastructure classification, manifest |

Faults are injected **downstream of correct world geometry** and are labelled as faults in every report. Nothing a
fault does changes the installed IDs (`APRILTAG.clusters`).

## 2. Drive physics (G03) — `src/sim/drivePhysics.ts`

A motor torque/speed model with battery sag, and chassis resistance (rolling, static breakaway, skid-steer scrub).
Profiles in `state.physics`:

| profile | meaning | provenance |
|---|---|---|
| `ideal` | today's kinematic model; no friction, current = 2 A × power | ideal |
| `tiles` (default for new and migrated sessions) | foam tiles, gecko wheels, 6WD: rolling 0.03, static 0.06, scrub 0.38 (band 0.30–0.50), battery 12.6 V / 0.05 Ω | **estimated** from the 2026-10-08 session: 14 % stalled a turn near the target at ≈ 1.4 A per motor, 20 % crept, 25 % completed |
| `custom` | every knob editable | user |

Motor: goBILDA 5203 datasheet (24.3 kg·cm, 9.2 A stall, 0.25 A free at 312 rpm; other free speeds scale torque
inversely). Chassis: side forces from torque / wheel radius; m dv/dt and I dω/dt with static tests (no motion until the
drive force exceeds μ_s m g, no rotation until the drive torque exceeds μ_scrub m g L/4). With the tiles numbers the
turning breakaway lands at ≈ 18 % command: 14 % stalls with stuck encoders and 1.5 A per motor, 20 % creeps, 25 %
turns. BRAKE shorts the motor at zero command; FLOAT coasts. Mecanum chassis keep the kinematic model (no
skid-steer scrub) but get the same breakaway and current; it is reported as such.

Observables: per-motor current in the sensor packet (`DcMotorEx.getCurrent` reads it), battery volts with sag
(`VoltageSensor`), a twin-side **stall watchdog** (command > 5 % with a non-turning shaft for 0.5 s) that raises a
`stall` event with motors, command, current and the breakaway the profile implies, and a HUD "Not moving" reason.

## 3. Feeder transit (G04) — `src/sim/feeder.ts`

One ball at a time travels a throat of length `throatM` from the hopper to the flywheel. `state.feed`:
`throatM` 0.09, `feedMps` 0.65 at full servo power (so 0.2 → 0.13 m/s → 0.69 s; **estimate** bracketed by the 0.4 s
pulse that failed and the 1.0 s pulse that launched), `deadband` 0.08, `strokeS` 0.25 for positional servos,
`rpmDropFrac` 0.08 per launch, `minLaunchRpm` 1200 (below it the ball drops out as today). Rules: the ball only moves
while the feeder role device is powered past the deadband (CR) or a positional stroke is in progress; stopping
leaves it where it is; reverse backs it up; an empty hopper feeds nothing. Counters kept apart: `feederPulses`
(command rising edges), `launches` (balls that reached the wheel), `shotsHit` (scored). The HUD shows the ball's
throat position and the three counters; `/api/state` carries them; the recorder logs `feed` events.

## 4. Vision levels and faults (G06) — `src/runtime/visionFaults.ts`, `state.perception`

| level | what TeamCode receives |
|---|---|
| `ideal` | today's geometry → SDK clusters, Gaussian pose noise `tagNoiseIn` |
| `faults` | the same observations passed through configurable faults: `dropoutProb`, `latencyMs` (acquisition stamps preserved, delivery delayed), `poseNoiseIn`, `misreadIds` (`{"44":"45"}` decoded-ID substitutions), `duplicateIds` (a tag seen twice), `blurAboveDps` (no detections while turning faster than this), `minPixels` |
| `singles` | every tag as `AprilTagSingleDetection` (the pre-existing sim-only builder switch); documented for teams that assemble clusters themselves |
| `pixels` | **unsupported** (no camera frames exist); reported as unsupported, never downgraded silently |

**Tag covers** (`state.tagCovers: number[]`) are world truth: a grey plate over the sticker, drawn in the scene and
treated as an occluder, so covering the lower cell's tags changes the observation through occlusion, not remapping.

## 5. Effective configuration and run manifest (G01, G02)

At every INIT the browser builds a **manifest**: twin git revision and dirty flag (from the build), TeamCode path
and revision (host reports), robot identity (preset, dimensions, drivetrain, intake side and kind, cameras with mount
and intrinsics, launcher, hardware map with roles, ports and mirrored side), physics profile with provenance,
perception level and faults, clock mode (`wall`) and, per asset key, the **effective value with provenance**:
`packaged` (the file), `scenario`/`manual` (panel or scenario override) or `bound` (twin bindings). It is exposed at
`GET /api/manifest`, shown in the Runtime section ("Effective configuration"), stored with the run and copied into
every twin-test report. A scenario may state `requireEffective: {"<asset>": {"<key>": value}}`; setup fails with a
clear reason when the effective value differs (P0 BIND, P0 CONFIG).

## 6. Harness contract (G09, G10, G11) — `scripts/twin-test.mjs`

- `GET /api/capabilities`: schema version, perception levels, physics profiles, assertion names, `clock: "wall"`.
- Scenario additions: `seed`, `physics` (profile name or object), `perception` (level + faults), `tagCovers`,
  `faults: [{at: {telemetry: regex} | {t: s}, durationS, camera: {...}}]` (event-relative), `requireEffective`,
  `coverage: {perception, physics}` (unsupported → verdict `unsupported`).
- New `expect` checks: `launches`, `feederPulses`, `collectedAtLeast` (inventory delta), `footprintInside`
  (`{xMinIn,xMaxIn,zMinIn,zMaxIn}` or a named zone: the four start squares / loading zones), `outputsZeroAfterStop`,
  `eventWithin: [{after: regex, event: "launch"|"stall"|regex, withinS}]` (bounded fallback), `noStall`.
- Verdicts: every check is `pass | fail | inconclusive | unsupported`. A run whose simulated/wall ratio is below
  0.8, that held packets for more than 2 s in total, or whose page threw, is classified **infrastructure**: physical
  checks become `inconclusive`, never pass or fail. `PASS` requires every check `pass`.
- Reports gain `manifest`, `events` (launches, feeder pulses, stalls, status changes, faults applied) and `verdict`.

Out of scope, stated as such: a deterministic fixed-step clock (TeamCode timers are JVM wall clock), pixel decoding,
leases for concurrent clients beyond the existing single-driver rule, pause/single-step under a running OpMode.

## 7. Interactive controls (§4 of the handoff)

Panel: **Physics** section (profile, battery, friction knobs, "what breakaway means for this robot" readout),
**Camera faults** section (level, each fault, tag covers per cell), feeder knobs under Launcher, and the Runtime
section's effective-configuration readout. HUD: "Not moving: …" with current and breakaway, feeder throat position
and the three counters. Everything is also reachable by agents through `POST /api/twin` (whitelist extended),
`POST /api/faults` and the manifest.

## 8. Fixtures (`scenarios/physical/`)

Run against the local team repo with `twinSettings: true`:

| id | fixture | expected verdict |
|---|---|---|
| STALL | route turn with `matchAuto.turnPower` 0.14 on `tiles` | stall event, turn never settles, no shot (fail by design, documented) |
| STALL-OK | same at 0.25 | turn completes, `noStall` passes |
| FEED-SHORT | 0.4 s windmill pulses at 0.2 | `feederPulses >= 1`, `launches == 0` |
| FEED-LONG | 1.0 s pulses | `launches >= 1` |
| EMPTY | four pulses with capacity 2 | `launches <= 2` |
| TAG-COVER | lower cell's tags covered | observation changes; route still shoots the raised cell |
| TAG-MIX | `misreadIds` 44→45 plus 42→45 | contaminated cluster; report shows the fault and the team's rejection telemetry |
| COLLECT-MISS | intake heading 0 instead of 180 | states visited, `collectedAtLeast 1` fails |
| DEADLINE | physical feed timing, 28 s | collection skipped, documented |

The ideal fast tests keep running with `physics: "ideal"` and are labelled so in their manifest.

**Outcome (2026-10-09, local TeamCode bedfe9c):** 9 pass, 3 fail, 1 unsupported, all at 1.0× real time. The three
failures are the ones the fixtures exist to show: TAG-COVER (the saved 17° camera never sees enough raised-cell tags
from the spot; the green run was aiming at the lowered cell), SEARCH (the local no-shot timer bug: 48 s in AIM_SHOOT
with stale frames), BIND (setup refused because the bound 72 in beat the scenario's 54 in). COLLECT-MISS fails by
design once the intake sweeps empty floor. Two pre-existing twin faults surfaced on the way and were fixed: a settings
file saved with Auto-RPM omits the launcher RPM and froze the first frame after START (NaN arc), and the harness clicked
a panel INIT button the workspaces hide. See `scenarios/physical/README.md` for the per-fixture evidence.

## 9. Follow-up with the updated TeamCode (2026-10-10, team checkout `6e7a398`)

The team pulled the handoff's later work: `CellObservations` / `TagClusterConsensus`, `MatchDriveFrame`, the stationary
shot and camera-layout OpModes, a 25 % finishing floor (30 % near-target cap), 40 % search, 1.0 s feed pulses, the fixed
54 ± 6 in shot, the fixed-spot no-shot timer, and a saved twin robot that is the physical one (6WD, intake front, shooter
and camera rear, camera 35° up). Three things in the twin followed from reading it.

**The shim ignored the tag library (fixed).** `DriverControl` now builds its `AprilTagProcessor` with
`CellObservations.individualLibrary()` (IDs 30–45 as plain 3.25 in tags) so the robot receives `AprilTagSingleDetection`s
and runs its own consensus. The shim grouped by id whatever the library, so that code path never ran in the twin (the
handoff said so: "synthetic cluster passthrough bypasses the individual-tag path"). Now a tag carries its season cluster
only when its metadata comes from the game database; a Builder-made library yields singles with their own poses and
timestamps; a tag outside the library has no pose. `singles` as a perception level still forces singles for any library.

**The cluster pose was the wrong point (fixed).** The SDK library places each tag at
(x = −6.5/−2.75/2.75/6.5 by `(id − 30) % 4`, y = 7.1874, z = −5.622) inches from the cluster origin in the tag's own axes
(x right, y down, z into the face; the team's `docs/LOCALIZATION.md` states the same). `test/tagClusterOrigin.test.ts`
shows the twin's four stickers on every cell recover one common origin with these offsets, and that origin lies in the
plane of the cell opening, 1.5 in below the opening centre: for the raised cell 58.2 in above the floor. The shim used to
report the sticker-strip centre, 7.19 in behind the opening and 5.6 in lower (49.8 in). A cluster's `rawPose`/`ftcPose`
is now the SDK origin, averaged over the visible tags, so a half-visible cluster reports the same point. **For the team:**
the robot's physical capture read the raised cell at 59.8 in, which the twin now reproduces (telemetry `h 58 in`), while
`HiveTargeting.CLUSTER_BEHIND_OPENING = 9.938 − 2.75` still treats the origin as the strip centre; the 38.7 in range the
code computed against a 45 in tape measure on 2026-10-08 is consistent with that constant being applied to an origin that
is already at the opening. Re-derive it against the SDK origin (the twin's manifest and `test/tagClusterOrigin.test.ts`
give the numbers); the twin's own geometric range at the spot is 63.7 in where the code reports 62.

**Fixtures.** Every `twinSettings` fixture now starts the saved robot facing the wall (chassis −90°, shooter into the
field). STALL split into 00 (25 % floor, must not stall) and 02 (turn capped at 15 %, must stall). New: 23 TAG-MIX
through the robot's consensus (the lowered cell's 40/41 decode as 44/45: four raised tags beat two impostors, the route
shoots), 24 TAG-TIE (pairwise-swapped raised ids give two incompatible two-tag groups 18 in apart: ambiguous, no shot,
bounded leg), 70/71 FRAME (the team's front/rear shooter-first drive-outs), 80 STOP (stopped after the third launch, all
outputs zero). A first TAG-TIE built from the lowered cell's tags fired anyway: those stickers leave the camera's view
while the robot turns and one clean frame starts the shot. The manifest now lists roles carried by several devices (the
saved map holds both the stock names and the robot's).

**Outcome against `6e7a398`:** see `scenarios/physical/README.md`. TAG-COVER passes with the 35° camera (it failed with the
17° one), SEARCH ends in 7.2 s (48 s before), 00 turns without a stall at 25 %, 02 stalls at 15 %, TAG-MIX shoots through
the consensus, TAG-TIE is ambiguous and does not fire, FRAME front/rear end at the same field point, STOP is clean.
COLLECT-MISS and BIND fail by design; pixels are unsupported. The team's own `auto-full-plan-diagnostic`,
`auto-40-real-shot-range` and `stationary-single-shot` pass unchanged; `auto-30s-far-side-collect-session` skips the
garden for time inside 30 s with 1.0 s pulses, as the team's docs already record.

## 10. The team's simulator-gap ledger (2026-10-10, team checkout `a962746`, SG-001 … SG-010)

The team now keeps `SIMULATOR_GAPS.md`, an incident ledger with ten open gaps and acceptance criteria. Their code moved
again (solver-required autonomous, a 60° measured profile, a fixed 12 in departure, a pre-shot stall watchdog with
`STALL_SETTLE`, a practice flag `matchAuto.pauseAimTimers` that the bundled profile ships **on**, detector decimation 1).
What the twin added, gap by gap; what it declines, and why.

**SG-001, the profile the robot saved (P0).** On the hub the code reads the profile it last *saved* (SQLite row 1), not
the packaged asset; a profile saved by an older build has none of the keys added since, so the committed 60° did
nothing while `launchAngleMeasured` was absent. The team's sim stub of `RobotDashboard` re-reads the asset at every INIT,
so the twin had no way to express that. Now: `state.persistedAssets` (per asset, the whole saved document) travels with
the overrides to the host, and the shim's `AssetManager` serves it in place of the packaged file as the base the
overrides merge into, so a key it lacks reaches the code missing and the parser fallback applies. `effectiveConfig.ts`
reports every key as `packaged | persisted | manual | bound | missing` (schema keys no source carries, distinct from
`null` and `false`) plus `manifest.profile` (`clean-install` vs `persisted`, the missing keys, and whether bindings
supply any shot-calibration key: `synthetic (twin bindings)` vs `as configured`). Scenarios: `persisted: {asset: {base:
"packaged" | "rev:<sha>" | "file:<path>", drop, set}}`, `requireEffective … "<missing>"`, `bindingsPolicy: "reject"`
(a bound calibration fails setup; `reject-all` for any bound key). Panel: *Saved hub profile (upgrade case)* under
TeamCode settings; the Runtime readout lists the missing keys in amber.

**SG-002, 45 in and no flywheel (P0).** The world truth is now beside the telemetry: `__twin.truth()` gives the robot
centre and launcher exit distance to the target opening, the bearing and the opening height, and every twin-test sample
carries it; `rangeConsistency` compares the code's `Target / range` line with it, `flywheelMaxPower` makes "the flywheel
never spun" a claim about outputs. The reconstruction (SPOT-45, real packaged profile, bindings off, the start moved so
the robot stands where the 24 in departure stood) and the measurement the ledger asked for (SPOT-12, the current
departure) are fixtures. The gate breakdown itself (which of eligible / fresh / aligned / solver / range / power / ready
blocked the shot) is in the team's status JSON, not in telemetry; the twin cannot add gates to their code.

**SG-003, perception.** `fpsCap` holds each processed frame until the detector's next one, so acquisition stamps age as
on the robot (12 fps at decimation 1); the latency queue now keeps the last delivered frame instead of an empty one.
There is no preview JPEG in the twin, so no second, throttled age exists to confuse with the detector's; the
capabilities say so. Ideal / faults / singles stay labelled; pixels stay unsupported.

**SG-004, SG-006.** Already modelled (§2, §3); the ledger's "never make 14 % universally fail" is the scrub band and the
breakaway readout. Jams remain `jams: false` in the capabilities: no evidence to fit one to.

**SG-005, garden contact (P1).** The twin pushed loose balls out of the chassis with no reaction, through the wall if
need be. Now a ball the chassis pushes against the perimeter, or against a chain of balls that ends on it, refuses the
motion (`match.refuse`, chain-aware); the refused travel comes back out of the pose and the drive model takes an
immovable contact: translation into it is impossible and a new `tractionMu` (1.2 for gecko wheels on foam, an estimate)
decides stalled shafts with a rising current (the StarterBot) or wheels spinning in place with the encoders counting.
`contact` events carry the ball count and position. Scenarios can place loose balls (`balls`). GARDEN-CONTACT runs the
along-wall leg into three POLLEN stacked on the wall with the hopper full and expects the code's own
`STALL_SETTLE`. The team's code caps that leg short of the twin's garden row, which is why the pile is placed.

**SG-007, clocks.** One documented contract (runtime/README.md → *Clock contract*): wall clock everywhere, acquisition
stamps never re-stamped, held packets and sub-real-time runs reported and classified inconclusive. twin-test warns when
an autonomous fixture inherits `pauseAimTimers = true` from the profile instead of setting it, and reports which clock
ran. PRACTICE-CLOCK shows the pause keeps aiming past every match bound while STOP still zeroes everything. Fixed-step
execution and pause under an OpMode remain out of scope (§6).

**SG-008, SG-010.** `travelBetween` asserts measured displacement and heading change between two telemetry moments,
`telemetryBefore` puts a deadline on a state; FRAME front/rear and the collection, footprint and score checks were
already there. **SG-009.** Reports carry a `runId`, the scenario path and seed, TeamCode and twin revisions with dirty
flags, the manifest, and the warnings above.

**Outcome against `a962746` (2026-10-10):** 19 of 25 physical fixtures pass, 1 unsupported (pixels), 3 fail by design
(COLLECT-MISS, BIND, BIND-REJECT); the remaining two first failed only because they inherited the team's practice clock,
and pass with the match clock stated. SPOT-45 reproduces the physical no-flywheel outcome (44 in reported, truth 45.5,
tags locked and centred, flywheel 0 %, leg over in 6 s); SPOT-12 measures the current departure: the spot stands 55.6 in
from the opening, the code reports 54 (within 2 in of truth on every sample), the solver accepts and four balls launch,
so the 12 in departure is not the 45 in case. UPGRADE reads the saved profile without the three solver keys and refuses
with the team's own reason. GARDEN-CONTACT trips the team's `STALL_SETTLE` from a collision, not a friction fault.
PRACTICE-CLOCK holds AIM_SHOOT past 30 s with no flywheel and zero outputs after STOP. Of the team's seven scenarios,
four pass, `auto-30s-far-side-collect-session` skips the garden as before, and `auto-40-real-shot-range` and
`auto-approach-stall-no-tags` fail on their own bundled `pauseAimTimers = true` (both expect the 5 s no-shot bound);
the harness warning names it in their reports. One twin fault surfaced on the way: the first contact model held the
robot while its running intake was taking garden balls on the wall; a running intake with room now swallows them.

**Speed raise follow-up (same day, team `d8dd552` → `796f2e1`).** Leg times roughly halved, turns settle, no route stall;
the spot-leg overshoot (about 3 in at 0.6, still 2–3 in at 0.45) tracks the approach gain, which the team now owns.
Three contact-model faults found by the runs are fixed: an active intake is not held by balls it is taking; a squeezed
ball stays put instead of knocking the chain loose; the block holds while the chassis stays put (5 mm, 10°) so encoders
cannot creep against a pile. `noStall` takes `{before}` so STALL-OK judges the route, not the garden hold the team's new
collect watchdog now handles ("held short of the wall; collecting here"). Numbers in `scenarios/physical/README.md`.
