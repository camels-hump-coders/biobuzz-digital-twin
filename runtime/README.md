# BIOBUZZ virtual runtime

Run your **unmodified FTC TeamCode OpModes** against the 3D twin, no robot needed.

```
browser twin (pnpm dev)  <── ws://127.0.0.1:8765 ──>  JVM host (this folder)
  physics, cameras, AprilTags,                         loads your OpMode classes compiled
  gamepad / keyboard, telemetry view                   against sdk-shim, runs INIT/START/STOP
```

## Quickest start

From the repo root, `pnpm sim --team /path/to/FtcRobotController` does everything below in one go (host with auto-rebuild on save, twin, browser). The rest of this file is the manual route and the details.

## Quick start (sample OpModes)

```bash
cd runtime
./gradlew :host:run            # starts the host with the sample OpModes (StarterBot TeleOp, auto-aim, shooter calibration)
# in another terminal, from the repo root:
pnpm dev                        # open http://localhost:5173
```

In the browser: **Runtime** panel → tick *Connect to runtime host* → pick an OpMode → **INIT** → **START**.
Telemetry appears in the panel. With no gamepad plugged in, the keyboard is gamepad1:

| Keyboard | Gamepad |
|---|---|
| W / A / S / D | left stick |
| Q / E | right stick X |
| Space | A |
| B, X, Y | B, X, Y |
| Z / C | left / right bumper |
| Shift / Ctrl | right / left trigger |
| G | Home / guide (the goBILDA logo button, `gamepad1.guide` / `gamepad1.ps`) |
| Enter / Backspace | Start / Back |
| V / N | left / right stick click |
| arrows | d-pad |

Press **Tab** to switch the keyboard between gamepad1 and gamepad2 (the HUD shows which), so two-driver OpModes can be exercised by one person. A physical gamepad (Xbox or PS layout, standard mapping, including the goBILDA kit controller) is used automatically when connected; a second one becomes gamepad2. The kit controller's Home button arrives as `guide` (button 16 in the browser's standard mapping).

## Running your own TeamCode

1. Point the `team` module at your TeamCode sources:
   ```bash
   ./gradlew :host:run -PteamCode=/path/to/FtcRobotController/TeamCode/src/main/java
   ```
   The sources are compiled against `sdk-shim` on the desktop JVM. Files that use SDK classes the shim does not have yet fail to compile and are listed; either exclude them (`-PteamExclude="**/RoadRunner/**,**/Experimental*.java"`) or add the missing class to `sdk-shim` (same package and signature as the real SDK) — most are a few lines.
2. In the browser's **Hardware map** panel make the device names match what your code passes to `hardwareMap.get(...)`, and set each motor's role (which wheel, flywheel, intake), ticks/rev and free RPM, each servo's role (feeder fires a ball on a rising edge past the threshold; hood maps 0..1 to the hood angle range), and which camera mount each webcam name uses.
3. INIT / START / STOP from the panel, exactly like the Driver Station.

## When your code uses things the shim does not have

`pnpm sim` scans your sources first. Files that import Android-only or robot-only packages (`android.graphics`, `android.database`, `org.opencv`, NanoHTTPD, `com.qualcomm.ftccommon`, `org.firstinspires.ftc.robotcore.internal`, the Panels camera-stream and field plugins) are skipped automatically and listed. If an OpMode needs one of them, give it a **sim version**: create `TeamCode/src/sim/java/<same package path>/<SameName>.java` with the same public API; the sim build uses that file in place of the main one and your production build never sees it. The Camels Hump repo does this for `dashboard/RobotDashboard.java` and `dashboard/DashboardCamera.java`.

**Describe your settings (schema sidecars):** put `foo.schema.json` next to `foo.json` in the assets folder, JSON Schema style, and the panel turns into a proper settings editor: `description` becomes help text under the row (and is searchable), `enum` becomes a dropdown, `minimum`/`maximum` become a slider with an exact box (`"type": "integer"` snaps), `default` is shown, values outside the schema are flagged red with the reason and the file badge counts them. Nested objects use `properties`; arrays use `items`; maps of similar entries (`bindings.*`) use `additionalProperties`. Agents read the same schema through `GET /api/schema?file=robot-profile.json` and are asked to keep it in step with the Java that parses the setting (see the skill). The Android app ignores the extra file.

**Sim-only asset overrides:** the browser panel *TeamCode settings (assets)* lists every JSON file in your `assets` folder with its values as checkboxes and fields. Anything you change there is stored in the browser (and in the exported session), sent to the host and merged into the file the next time an OpMode INITs; your repo files are never modified, and *Clear overrides* returns to them. Use it for settings that are safety-gated on the real robot (verified servo modes, auto-shoot enabled, shot ranges). File-based alternative: a `something.sim.json` next to `something.json` is served instead of the original.

**FTC Panels.** The host runs the real Panels library (`com.bylazar:fullpanels` 1.0.13's core and plugins, unpacked from its Maven AARs by the `panels` Gradle module) on the usual ports: web UI on 8001, socket on 8002. It gets the same contract the robot controller gives it: a `Context` whose assets are your TeamCode assets plus Panels' own web UI, an `FtcEventLoop` whose `OpModeManagerImpl` is the host's runner (so Panels' OpMode control starts and stops OpModes in the twin, and INIT/START/STOP notifications reach every plugin), `RegisteredOpModes` from the scanner, and `android.graphics.Bitmap`/`Base64` stand-ins so the camera-stream plugin compiles and runs. No camera frames are produced: AprilTag detections are synthetic (geometry, not pixels), so a camera-stream widget shows nothing. Two Panels classes are shadowed by same-named classes in `runtime/panels/src`: the APK dex class scanner (replaced by a classpath scanner) and the robot-controller screen text. `pnpm sim --no-panels` (or `-PsimPanels=false`) runs without it, and a host that finds 8001/8002 already taken by another host skips Panels on its own; `pnpm twin-test` always runs without it. `SIM_DEBUG=true pnpm sim` prints Panels' own logs and the lifecycle notifications.

**After pulling a new version of this repo, restart `pnpm sim`** so the host picks up the rebuilt shim; a host started before an update can fail at INIT with `NoClassDefFoundError` for a class that was added since.

Already covered without any changes on your side: `org.json` (the reference implementation), `android.content.Context` from `hardwareMap.appContext` with `getAssets()` reading `TeamCode/src/main/assets` (a JSON asset is served with the browser's overrides merged in, and, when the twin simulates a profile the robot SAVED on the hub, that saved document replaces the packaged file as the base, so keys it lacks reach the code missing, as on the robot) and `getSharedPreferences()` persisting under `runtime/.sim-prefs`, `android.util.Size`, Panels `JoinedTelemetry` / `PanelsTelemetry` / `TelemetryManager` (telemetry is accepted, there is no dashboard), `DcMotor.getPortNumber()` and `getController()` (configure ports in the Hardware map panel; every device reports the one simulated Control Hub), SDK 12 `AprilTagSingleDetection` / `AprilTagClusterDetection` with `percentClusterFound`, `metadata.name` (`RED SCORING`, `RED AUDIENCE`, `BLUE AUDIENCE`, `BLUE SCORING`, as in the SDK), `ftcPose`, `rawPose` (OpenCV frame, `R` as `MatrixF`) and `robotPose`.

## If the host hangs or will not start

- **"OpModes found" and then nothing:** the host prints `sim-host pid N port P` first; if it is not listening after 60 s it dumps its threads to the launcher output and exits, so `pnpm sim` / `pnpm twin-test` fail fast with the cause instead of waiting. Please report that dump.
- **Leftover host JVMs:** the host runs under the Gradle daemon, not under the launcher, so an interrupted run used to leave `org.biobuzz.sim.host.Main` alive. `pnpm sim` now ends its own host (TERM, then KILL) on exit, and `pnpm twin-test` ends orphaned hosts (parent PID 1) before it starts and refuses to run when something else already listens on its `--host-port`. To check by hand: `ps -axo pid,ppid,command | grep sim.host.Main`.

## What the shim supports

`OpMode`, `LinearOpMode` (`waitForStart`, `opModeIsActive`, `opModeInInit`, `isStopRequested`, `sleep`, `idle`), `HardwareMap` (`get`, `tryGet`, `getAll`, `dcMotor`/`servo`/`crservo` mappings), `DcMotor`/`DcMotorEx` (power, run modes, `STOP_AND_RESET_ENCODER`, `RUN_TO_POSITION` busy flag, `setVelocity`/`getVelocity` in ticks/s or angle units, direction, zero-power behaviour), `Servo`/`ServoImplEx`/`CRServo`, `IMU` (`getRobotYawPitchRollAngles`, `resetYaw`, `getRobotOrientation`, angular velocity), `DistanceSensor`, `TouchSensor`, `VoltageSensor`, `Gamepad` (all buttons, sticks, triggers, PS aliases, rumble no-ops), `Telemetry` (items, lines, functions, retained, log, actions), `ElapsedTime`, `Range`, `RobotLog`, `VisionPortal` + builder, `AprilTagProcessor` + builder (`getDetections`, `getFreshDetections`), `AprilTagDetection` and its SDK 12 subclasses `AprilTagSingleDetection` / `AprilTagClusterDetection` (BIOBUZZ returns one cluster detection per visible cell cluster, like the real SDK; `new AprilTagProcessor.Builder().setEmitSingleDetections(true)` is a sim-only switch for pre-12 style code) with `ftcPose` (x right, y forward, z up; yaw/pitch/roll; range, bearing, elevation), `rawPose` and `robotPose`, `AprilTagGameDatabase.getCurrentGameTagLibrary()` with the BIOBUZZ IDs 30–45 and `getBiobuzzClusters()`, `WebcamName`, `android.util.Size`, `@TeleOp`/`@Autonomous`/`@Disabled`.

Not supported: raw camera frames into custom `VisionProcessor`s (accepted so code compiles, never called), `LynxModule` bulk reads, Road Runner internals, Blocks/OnBot OpModes.

## Sensor model

- Drive motors of a tank chassis go through a torque/speed model (goBILDA 5203 datasheet scaled to the free RPM) against the surface profile in the twin's *Physics & feeding* section: rolling resistance, static breakaway and skid-steer turning scrub. Below the breakaway the chassis does not move, the encoders stay still and `DcMotorEx.getCurrent()` returns the stall current for that command (about 1.5 A at 14 % on the *tiles* profile, as measured on the robot); `VoltageSensor` sags with the current. The *ideal* profile keeps the old kinematic model (first-order lag, 0.12 s). Other motors integrate the commanded speed with the same lag; `setVelocity` is tracked directly.
- An immovable contact (a loose ball squeezed between the chassis and the perimeter, or against a ball already on it) holds the chassis: translation into it is impossible and the profile's grip (`tractionMu`, estimate 1.2 for gecko wheels on foam) decides whether the shafts stall (encoders frozen, current up) or the wheels spin on the floor (encoders count, no progress). The ideal profile stops kinematically with the encoders still integrating the command.
- A feeder-role CR servo or servo does not launch on a rising edge: it moves a ball along a throat (twin *Physics & feeding* → Feeder transit); the ball launches when it reaches the flywheel, and the twin counts pulses, launches and scored balls separately.
- IMU yaw is the robot heading, CCW positive, zeroed when the OpMode is initialised or on `resetYaw()`.
- AprilTag detections come from the twin's camera analysis (in frame, facing the camera, not occluded by the hive, frame, flowers, other robots or a tag cover) with optional Gaussian position noise (*AprilTag noise* in the Hardware map panel, default 0.3 in). With the perception level *faults*, the twin's camera faults (dropout, latency, pose noise, misread and duplicate ids, blur, size) are applied before the shim groups tags into SDK clusters; a latency fault backdates `frameAcquisitionNanoTime` by the true delay. Grouping follows SDK 12: only tags whose library metadata names a season cluster (the game database's) are merged into an `AprilTagClusterDetection`; a processor built with `setTagLibrary(...)` on a Builder-made library of individual tags returns `AprilTagSingleDetection`s, each with its own `rawPose`/`ftcPose`, and a tag outside the library has no pose. A cluster's pose is the SDK's cluster origin: each visible tag sits at (x = −6.5/−2.75/2.75/6.5 by `(id − 30) % 4`, y = 7.1874, z = −5.622) in from it in the tag's own axes (x right, y down, z into the face), so the origin is recovered as `t − R·offset` and averaged; it lies in the plane of the cell opening, 5.6 in above the strip (the strip centre itself was reported before 2026-10-10). The level *singles* forces single detections whatever the library (`SimHooks.forceSingles()`).
- Gamepads arrive at 50 Hz from the browser.

## Clock contract

There is one clock, the host machine's: TeamCode timers (`ElapsedTime`, `System.nanoTime`) are the JVM's wall clock, so the world must keep wall time or the robot decides against a world that lagged. The browser therefore separates simulation from rendering: every simulation tick advances the world by the real time that passed since the previous tick (up to 250 ms per tick; anything beyond, a hidden tab or a multi-second stall, is dropped and counted as `timeDroppedS`), the match clock, scoring timer, ball flight, feeder transit and drive physics all advance by that same amount, and a render happens only when the adaptive render interval is due (twice the last render's cost, at most 400 ms), with ticks running on a timer between renders. A fast machine renders every tick at the display rate; a Chromebook with a 100 ms render draws about 5 fps while the world still runs at real time. Sensors go out on a 50 Hz timer, tags on a 20 Hz timer; a camera frame's `frameAcquisitionNanoTime` is the sensor time it was acquired at minus the fault model's cadence hold and delivery latency, never re-stamped by the host to hide a slow page (short page stalls re-send the last packet, counted as *held packets* and reported); scenario `inputs`, `faults` and `durationS` are scheduled on the simulated match clock. The HUD says when the world fell behind ("slow machine: the world fell N s behind real time since INIT"), `__twin.stats()` reports `timeDroppedS`, `simRate`, `renderFps` and `renderCostMs`, and twin-test classifies a run under 0.8× real time, or with sensor gaps over 300 ms under a live OpMode, as *inconclusive*. There is no fixed-step or paused execution under an OpMode; the team's `matchAuto.pauseAimTimers` is the robot code's own practice switch (it pauses aiming deadlines only, not STOP, faults or mechanism durations) and twin-test warns when a fixture inherits it from the profile instead of setting it. Timing fixtures must set it explicitly.

Measured on 2026-10-10 with the CPU throttled 6× in headless Chromium, full visuals, the team's autonomous running: the previous loop (one simulation step per rendered frame, capped at 100 ms) advanced the world 6.6 s in 23.3 s of wall time, and the robot, whose timers kept wall time, reached its 5 s no-shot bound and turned back in a world that had barely moved. The current loop's figures are in the project README's performance section.
