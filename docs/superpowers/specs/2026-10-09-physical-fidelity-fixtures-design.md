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
