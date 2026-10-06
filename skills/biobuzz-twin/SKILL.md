---
name: biobuzz-twin
description: Use when changing FTC TeamCode (OpModes, drive, intake, shooter, AprilTag aiming) and you want to run it before touching the robot. Runs the code headlessly in the BIOBUZZ digital twin (simulated field, robot, sensors, gamepads) and reports telemetry, shots, position and errors. Also covers checking the twin is installed and set up.
---

# BIOBUZZ digital twin as a test bed

The twin runs the team's **unmodified** Java TeamCode on a desktop JVM against a simulated FTC BIOBUZZ field. Motors,
servos, encoders, IMU, AprilTag detections and gamepads are simulated; the robot drives in a 3D field with scripted
partner/opponent robots, hives that tip, pollen/nectar and the real game rules for pinning. Use it to check a code
change before anyone loads it on the robot.

## 0. Keeping this skill current

Installed with `npx skills add camels-hump-coders/biobuzz-digital-twin --skill biobuzz-twin` (or `pnpm skill:install`
from a twin checkout). `npx skills update` refreshes it; the twin itself updates with `git pull` in its checkout followed
by `pnpm install`.

## 1. Locate the twin and check it is set up

1. Read `.biobuzz-twin.json` in the team repo root; `twinPath` is the twin checkout. If the file is missing, look for a
   sibling directory named `biobuzz-digital-twin` or `biobuzz`; otherwise clone it:
   `git clone git@github.com:camels-hump-coders/biobuzz-digital-twin.git` next to the team repo, then write
   `.biobuzz-twin.json` with `{ "twinPath": "<absolute path>" }`.
2. In the twin directory check, in order:
   - `node --version` is 22+, `pnpm --version` is 12+ (if `flox` is installed, prefix commands with `flox activate --`
     inside the twin directory and both are provided; so is a JDK).
   - A JDK 17+: `java -version`, or `JAVA_HOME` set, or Android Studio installed (its bundled JDK is found automatically).
   - `pnpm install` has run (`node_modules/` exists) and Chromium for Playwright is present:
     `pnpm exec playwright install chromium` (one-time, ~150 MB).
3. If anything is missing, fix it (or tell the user exactly what to install) before running tests.

## 2. Run an OpMode against the twin

From the twin directory:

```bash
pnpm twin-test --team <team repo root> --scenario <scenario.json> --out <report.json>
```

- `--team` accepts the project root, the TeamCode module, or `TeamCode/src/main/java`.
- The first run compiles the team code with Gradle (minutes); later runs take ~30 s plus the scenario length.
- It uses ports 5190/8790, so a human's `pnpm sim` session on 5173/8765 is not disturbed.
- Add `--headed` to watch the browser; `--screenshot out.png` for a final picture.
- Exit code 0 means every `expect` check passed. The console prints each check, the final telemetry and the report path.

Scenario files live in the twin's `scenarios/` folder (`scenario.schema.json` documents the format). Keep team-specific
scenarios in the team repo, e.g. `TeamCode/twin-scenarios/*.json`, and pass their path. Minimal scenario:

```json
{
  "opMode": "My TeleOp",
  "alliance": "red",
  "robotPreset": "starterbot6wd",
  "hardwarePreset": "camelsHump",
  "durationS": 8,
  "inputs": [ { "t": 0.5, "pad": 1, "set": { "ly": -1 } }, { "t": 3, "pad": 1, "set": { "ly": 0 } } ],
  "expect": { "noErrors": true, "movedAtLeastIn": 12 }
}
```

- `inputs` set gamepad fields at simulated seconds after START and hold them until changed: sticks `lx ly rx ry`
  (−1..1, FTC convention: `ly` = −1 is stick forward), triggers `lt rt`, buttons `a b x y lb rb back start guide
  (Home/PS) du dd dl dr ls rs`.
- `assetOverrides` merge values into the team's JSON assets at INIT without touching the files (asset path → dotted key →
  value), e.g. enable a safety-gated feature for the sim.
- `expect`: `noErrors`, `shotsFired`/`shotsHit`/`fouls` comparisons like `">=1"`, `telemetryIncludes` (regexes that
  must match some telemetry line during the run), `telemetryFinalIncludes`, `movedAtLeastIn`, `poseNear`.

## 2b. Debugging a human's live session (agent API)

When the user has `pnpm sim` running, query their session directly instead of asking for screenshots. The host serves
a local HTTP API at the WebSocket port + 1 (default `http://127.0.0.1:8766/`; the Runtime panel shows it; `GET /`
lists endpoints; if it refuses, the host is not running or uses another `--host-port`):

```bash
A=http://127.0.0.1:8766
curl -s $A/api/status                          # IDLE/INIT/RUNNING/STOPPED/ERROR, current OpMode, error, OpMode list
curl -s "$A/api/snapshot?seconds=60"           # Markdown: context, events (status, buttons, exceptions, shots, fouls), telemetry
curl -s $A/api/state                           # pose, match phase/clock, score, inventory, hives, telemetry, scripted robots
curl -s $A/api/telemetry; curl -s "$A/api/log?tail=300"      # OpMode prints / RobotLog / stack traces
curl -s "$A/api/timeline?seconds=60"           # raw 10 Hz samples + events (JSON) when the snapshot is not enough
curl -s $A/api/knobs; curl -s $A/api/overrides # twin knob values; manual + bound asset overrides
curl -s $A/api/run                             # recorded runs (INIT->STOP), the latest one, the replay cursor
curl -s "$A/api/replay?offset=12.5&scrub=false" # the recorded moment 12.5 s into the latest run: pose, other robots, balls, hive tilts, telemetry, sticks, score, nearby events
curl -s $A/api/runs; curl -s "$A/api/runs?file=<name>"   # runs saved on disk by the host (whole run: context, 10 Hz samples, events)
```

To step through what the program did, walk `/api/replay` with `offset` (seconds into the run; negative counts from
its end) or `step` (±samples, 0.1 s each) and compare `sample.telemetry`, `sample.pose`, `sample.scene.sticks` (what
the driver/agent commanded) and `events` from one moment to the next. Without `scrub=false` each call also moves the
human's field view to that moment (the live sim pauses); `POST /api/replay {"live": true}` resumes. Say so when you
leave their view scrubbed.

Read the snapshot's Context block first, then the events, then the telemetry around them. To change the session:

```bash
curl -s -X POST $A/api/overrides -d '{"biobuzz/robot-profile.json": {"matchAuto.startPosition": "FAR_SIDE"}}'  # TeamCode settings (applied at INIT)
curl -s -X POST $A/api/twin -d '{"alliance": "red", "hive.red": "scoring", "robot.launcher.elevationDeg": 52}'   # twin settings (whitelisted paths)
curl -s -X POST $A/api/match -d '{"action": "init", "opMode": "BioBuzz: Drive + Auto Aim"}'   # then {"action":"start"|"stop"|"reset"}
curl -s -X POST $A/api/gamepad -d '{"pad": 1, "values": {"guide": true}, "holdMs": 300}'       # press Home for 300 ms
curl -s -X POST $A/api/pose -d '{"xIn": 0, "zIn": 36, "headingDeg": 90}'
```

Everything you set appears in the human's panel and timeline (as an "agent set …" note), so say what you changed. Do
not run twin-test against the human's ports (5173/8765); it uses its own (5190/8790).

**Conveying settings when you cannot reach the session** (different machine, no host running): print them as
`"dotted.key": value` lines under the asset file name, e.g.

```
biobuzz/robot-profile.json
"matchAuto.startPosition": "FAR_SIDE",
"matchAuto.loadingZoneDistanceIn": 72
```

The human pastes that into *TeamCode settings → Paste settings from an agent*; the panel picks the file (by name or by
which file already has those keys/sections) and applies them as overrides.

## 3. Read the report

The JSON report has `start`, `final` and per-second `samples` with telemetry lines, pose (inches, degrees), shots fired
and hit, carried game pieces, hive loads/tips, fouls, and `pageErrors`/`hostLogTail` for crashes. Typical failures:

- OpMode not found: the name must match the `@TeleOp(name=...)`/`@Autonomous(name=...)` string; the error lists the names.
- `Unable to find a hardware device with name "X"`: the sim's hardware map lacks that name. Use `hardwarePreset`
  (`camelsHump` has Left Drive, Right Drive, Intake, Firing Mechanism, Windmill Feeder, Front Right/Left Feeder, imu,
  Webcam 1) or ask the user to add the device in the twin's Hardware map panel and export the robot config.
- Compile errors: printed from Gradle. Files that import Android-only classes are skipped automatically; add
  `--exclude "glob,glob"` for others, or give those classes a sim stand-in under `TeamCode/src/sim/java` (same package
  and class name; it replaces the main file only in the sim build).
- Telemetry shows the robot never arms/aims/shoots: check the gates in the team's own settings assets (often disabled
  until calibrated) and supply `assetOverrides`.
- `⚠ fps` / sim slower than real time: harmless headless rendering speed; inputs are scheduled in simulated time.

Snapshots and the `__twin.score()` hook carry the match scoreboard (Competition Manual Table 10-2: HIVE TIP 20, LEAVE 3,
AUTO PARK 5, TELEOP PARK 5, 2 per ball left in an up cell, 1 per GARDEN ball; FLOWER points not modelled). `score.robots`
lists LEAVE / AUTO PARK / PARK per robot, so an autonomous scenario can assert `red.auto` or `robots.player.leave`.
LEAVE and AUTO PARK latch when the clock passes 2:00 left; PARK latches when the match stops.

## 4. Keep robot measurements bound to the twin

The twin is the single source of truth for the robot's physical facts. Any setting the code reads that describes
the robot or the match situation, rather than a strategy or a driver preference, must be bound in
`TeamCode/twin-bindings.json` so the sim feeds it automatically and the two can never disagree. That covers:
dimensions, wheel diameter, ticks per revolution, track width, encoder signs, camera mount position and angles,
shooter direction, alliance, start pose. Rules:

1. When you add such a setting to a JSON asset, add a binding in the same change: `{ "asset", "key", "twin" }` with a
   `note` on units and sign conventions. Get knob names from the twin's knob catalogue (TeamCode settings panel →
   *Download twin knob catalogue*, or `window.__twin.knobs()` in the twin page). Prefer the camera knobs under
   `hardware.<webcam device name>.*` so the binding follows the hardware-map assignment.
2. If a twin knob for the fact does not exist, say so in the summary (and in `_not_bound` of the bindings file) so the
   twin can grow a knob; do not invent a value in two places.
3. Keep strategy tuning (powers, timeouts, distances to drive) and feature switches (enabled flags) unbound; those are
   set per run in the TeamCode settings panel or stay in the asset.
4. After changing bindings, run a scenario: binding errors appear in the twin-test report's telemetry/pageErrors and in
   the panel; unknown knob names are the usual mistake.
5. The committed asset values still drive the real robot. When the twin's measurement changes, export the merged file
   from the TeamCode settings panel (*Export* per file, or *Export N changed files*) and commit it; the export keeps the
   file's key order and indentation so only the changed values show in the diff. From a script: `applyOverrides` /
   `exportChangedAssets` in `src/runtime/assetExport.ts` with `link.assets`, `state.assetOverrides`, `link.bound.overrides`.

## 4a. Describe every setting in the asset's schema sidecar

Each JSON asset has (or should get) a JSON Schema sidecar next to it: `robot-profile.schema.json` for
`robot-profile.json`. The twin's settings panel renders it (help text, dropdowns for `enum`, sliders for
`minimum`/`maximum`, red flags for violations) and `GET /api/schema?file=robot-profile.json` returns it with the
current violations. Rules:

1. When you add, rename or re-range a setting in the Java that parses it (`number(a,"key",fallback,min,max)`,
   `valueOf(...)` enums, `validate()` ranges), update the sidecar in the same change: `description` (what it does, units,
   sign convention, what happens at the extremes), `type`, `enum`, `minimum`/`maximum`, `default`, `"type": ["number","null"]`
   when null is meaningful. Keep the schema's ranges identical to the Java's; the schema is documentation of the code,
   not a second source of truth.
2. Nested objects use `properties`; arrays use `items`; maps of similar entries use `additionalProperties`.
3. Before INIT, run `curl -s "$A/api/schema?file=robot-profile.json" | jq .invalid` (or read the file badge) so a
   value the code will reject at startup is caught here first.

## 4b. Shooter calibration: make the twin shoot like the robot

The twin's launcher knobs (`launcher.efficiency`, `launcher.elevationDeg`, `launcher.exitHeightIn`, backspin, the
flywheel's `freeRpm`) are measured, not guessed, with the **Shooter calibration** wizard (Launcher section of the panel)
and the `Twin: Shooter Calibration` OpMode (`runtime/samples/.../TwinCalibration.java`, copied into TeamCode as
`opmodes/TwinCalibration.java`). Humans fire the robot at a wall and type/click where each ball hit; the fitter tunes
the knobs until the twin's flight model reproduces every impact.

- If a human reports shots ("power 0.6 from 48 in hit the wall 70 in up"), enter them via `window.__twin.state.calibration`
  (`shots[]` of `{id, power, rpm?, distanceM, kind: "wall"|"floor", measuredM}`; `distanceM` is exit-to-wall, see
  `exitToWallDistance` in `src/ballistics/calibration.ts`), then read the fit in the panel or call `fitCalibration` from
  the module directly. Apply with the panel button or by writing the launcher fields and calling the Launcher change.
- When the calibration OpMode runs in the twin, each shot's simulated impact is at `window.__twin.calibration.lastImpact()`;
  adding those as shots must reproduce the current launcher values (RMS ≈ 0): that is the wizard's self-test.
- The wizard's TeamCode block (`launchAngleDeg`, `exitHeightIn`, `targetHeightIn`, `shotRangeIn`/`shotPower`, `powerTable`)
  is what `tagTracking` in `robot-profile.json` wants; the scalar ones are also bound (see twin-bindings.json), the
  `powerTable` array must be pasted into the asset by hand.
- The OpMode's `POWERS` must equal the wizard's "Powers to test" list.

## 5. Workflow for a code change

1. Make the change in the team repo.
2. Run the relevant scenario(s); for a new feature write a scenario that exercises it (inputs + expectations).
3. Fix until `PASS`, then summarise for the user what the twin saw (final telemetry, shots, position) and what still
   needs checking on the real robot (anything the twin does not model: motor current, real camera exposure, battery sag,
   mechanical jams).
4. Commit the scenario next to the code so it runs again later.

The host also serves the real FTC Panels dashboard at http://localhost:8001 (socket 8002) while it runs, fed by the
team's own Panels calls; a quick way to see what the code publishes is to open it in a browser or read the socket.

Humans can open the same thing interactively: `pnpm sim --team <path>` in the twin directory (browser opens, INIT/START
/STOP from the Runtime panel; INIT parks all robots at their start positions, START releases the match).
