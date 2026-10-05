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
./gradlew :host:run            # starts the host with the two sample OpModes
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

**Sim-only asset overrides:** the browser panel *TeamCode settings (assets)* lists every JSON file in your `assets` folder with its values as checkboxes and fields. Anything you change there is stored in the browser (and in the exported session), sent to the host and merged into the file the next time an OpMode INITs; your repo files are never modified, and *Clear overrides* returns to them. Use it for settings that are safety-gated on the real robot (verified servo modes, auto-shoot enabled, shot ranges). File-based alternative: a `something.sim.json` next to `something.json` is served instead of the original.

**FTC Panels.** The host runs the real Panels library (`com.bylazar:fullpanels` 1.0.13's core and plugins, unpacked from its Maven AARs by the `panels` Gradle module) on the usual ports: web UI on 8001, socket on 8002. It gets the same contract the robot controller gives it: a `Context` whose assets are your TeamCode assets plus Panels' own web UI, an `FtcEventLoop` whose `OpModeManagerImpl` is the host's runner (so Panels' OpMode control starts and stops OpModes in the twin, and INIT/START/STOP notifications reach every plugin), `RegisteredOpModes` from the scanner, and `android.graphics.Bitmap`/`Base64` stand-ins so the camera-stream plugin can encode frames. The frames are JPEGs the twin renders from the simulated webcam, delivered through `SimHooks.latestFrame("Webcam 1")`; the team's sim `RobotDashboard`/`DashboardCamera` overrides hand them to `PanelsComparison` exactly like real camera frames. Two Panels classes are shadowed by same-named classes in `runtime/panels/src`: the APK dex class scanner (replaced by a classpath scanner) and the robot-controller screen text. `pnpm sim --no-panels` (or `-PsimPanels=false`) runs without it, and a host that finds 8001/8002 already taken by another host skips Panels on its own; `pnpm twin-test` always runs without it. `SIM_DEBUG=true pnpm sim` prints Panels' own logs and the lifecycle notifications.

**After pulling a new version of this repo, restart `pnpm sim`** so the host picks up the rebuilt shim; a host started before an update can fail at INIT with `NoClassDefFoundError` for a class that was added since.

Already covered without any changes on your side: `org.json` (the reference implementation), `android.content.Context` from `hardwareMap.appContext` with `getAssets()` reading `TeamCode/src/main/assets` and `getSharedPreferences()` persisting under `runtime/.sim-prefs`, `android.util.Size`, Panels `JoinedTelemetry` / `PanelsTelemetry` / `TelemetryManager` (telemetry is accepted, there is no dashboard), `DcMotor.getPortNumber()` and `getController()` (configure ports in the Hardware map panel; every device reports the one simulated Control Hub), SDK 12 `AprilTagSingleDetection` / `AprilTagClusterDetection` with `percentClusterFound`, `metadata.name` (`RED SCORING`, `RED AUDIENCE`, `BLUE AUDIENCE`, `BLUE SCORING`, as in the SDK), `ftcPose`, `rawPose` (OpenCV frame, `R` as `MatrixF`) and `robotPose`.

## What the shim supports

`OpMode`, `LinearOpMode` (`waitForStart`, `opModeIsActive`, `opModeInInit`, `isStopRequested`, `sleep`, `idle`), `HardwareMap` (`get`, `tryGet`, `getAll`, `dcMotor`/`servo`/`crservo` mappings), `DcMotor`/`DcMotorEx` (power, run modes, `STOP_AND_RESET_ENCODER`, `RUN_TO_POSITION` busy flag, `setVelocity`/`getVelocity` in ticks/s or angle units, direction, zero-power behaviour), `Servo`/`ServoImplEx`/`CRServo`, `IMU` (`getRobotYawPitchRollAngles`, `resetYaw`, `getRobotOrientation`, angular velocity), `DistanceSensor`, `TouchSensor`, `VoltageSensor`, `Gamepad` (all buttons, sticks, triggers, PS aliases, rumble no-ops), `Telemetry` (items, lines, functions, retained, log, actions), `ElapsedTime`, `Range`, `RobotLog`, `VisionPortal` + builder, `AprilTagProcessor` + builder (`getDetections`, `getFreshDetections`), `AprilTagDetection` and its SDK 12 subclasses `AprilTagSingleDetection` / `AprilTagClusterDetection` (BIOBUZZ returns one cluster detection per visible cell cluster, like the real SDK; `new AprilTagProcessor.Builder().setEmitSingleDetections(true)` is a sim-only switch for pre-12 style code) with `ftcPose` (x right, y forward, z up; yaw/pitch/roll; range, bearing, elevation), `rawPose` and `robotPose`, `AprilTagGameDatabase.getCurrentGameTagLibrary()` with the BIOBUZZ IDs 30–45 and `getBiobuzzClusters()`, `WebcamName`, `android.util.Size`, `@TeleOp`/`@Autonomous`/`@Disabled`.

Not supported: raw camera frames into custom `VisionProcessor`s (accepted so code compiles, never called), `LynxModule` bulk reads, Road Runner internals, Blocks/OnBot OpModes.

## Sensor model

- Encoders integrate the simulated wheel speed (first-order lag, 0.12 s) at the configured ticks/rev; `setVelocity` is tracked directly.
- IMU yaw is the robot heading, CCW positive, zeroed when the OpMode is initialised or on `resetYaw()`.
- AprilTag detections come from the twin's camera analysis (in frame, facing the camera, not occluded by the hive, frame, flowers or other robots) with optional Gaussian position noise (*AprilTag noise* in the Hardware map panel, default 0.3 in).
- Gamepads arrive at 50 Hz from the browser.

## Protocol (for other tools)

JSON text frames. Browser → host: `{type:"hardware", devices:[{name,kind,ticksPerRev}]}`, `{type:"sensors", motors:{name:{pos,vel}}, imu:{yaw,pitch,roll,yawRate}, distances:{}, tags:{webcamName:[{id,cx,cy,x,y,z,yaw,pitch,roll,range,bearing,elevation,robotX,robotY,robotYaw}]}, gamepad1:{lx,ly,rx,ry,lt,rt,a,b,x,y,lb,rb,back,start,guide,du,dd,dl,dr,ls,rs}, gamepad2:{...}, battery}`, `{type:"init", opMode}`, `{type:"start"}`, `{type:"stop"}`. Host → browser: `{type:"opmodes", opModes:[{name,group,flavor,className}]}`, `{type:"status", status, opMode, error}`, `{type:"telemetry", lines:[]}`, `{type:"actuators", devices:{name:{kind:"motor",power,mode,reverse,targetVel,targetPos,brake} | {kind:"servo",position} | {kind:"crservo",power}}}` at 50 Hz.
