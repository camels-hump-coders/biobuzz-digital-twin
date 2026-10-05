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

A physical gamepad (Xbox or PS layout, standard mapping, including the goBILDA kit controller) is used automatically when connected; a second one becomes gamepad2. The kit controller's Home button arrives as `guide` (button 16 in the browser's standard mapping).

## Running your own TeamCode

1. Point the `team` module at your TeamCode sources:
   ```bash
   ./gradlew :host:run -PteamCode=/path/to/FtcRobotController/TeamCode/src/main/java
   ```
   The sources are compiled against `sdk-shim` on the desktop JVM. Files that use SDK classes the shim does not have yet fail to compile and are listed; either exclude them (`-PteamExclude="**/RoadRunner/**,**/Experimental*.java"`) or add the missing class to `sdk-shim` (same package and signature as the real SDK) — most are a few lines.
2. In the browser's **Hardware map** panel make the device names match what your code passes to `hardwareMap.get(...)`, and set each motor's role (which wheel, flywheel, intake), ticks/rev and free RPM, each servo's role (feeder fires a ball on a rising edge past the threshold; hood maps 0..1 to the hood angle range), and which camera mount each webcam name uses.
3. INIT / START / STOP from the panel, exactly like the Driver Station.

## What the shim supports

`OpMode`, `LinearOpMode` (`waitForStart`, `opModeIsActive`, `opModeInInit`, `isStopRequested`, `sleep`, `idle`), `HardwareMap` (`get`, `tryGet`, `getAll`, `dcMotor`/`servo`/`crservo` mappings), `DcMotor`/`DcMotorEx` (power, run modes, `STOP_AND_RESET_ENCODER`, `RUN_TO_POSITION` busy flag, `setVelocity`/`getVelocity` in ticks/s or angle units, direction, zero-power behaviour), `Servo`/`ServoImplEx`/`CRServo`, `IMU` (`getRobotYawPitchRollAngles`, `resetYaw`, `getRobotOrientation`, angular velocity), `DistanceSensor`, `TouchSensor`, `VoltageSensor`, `Gamepad` (all buttons, sticks, triggers, PS aliases, rumble no-ops), `Telemetry` (items, lines, functions, retained, log, actions), `ElapsedTime`, `Range`, `RobotLog`, `VisionPortal` + builder, `AprilTagProcessor` + builder (`getDetections`, `getFreshDetections`), `AprilTagDetection` with `ftcPose` (x right, y forward, z up; yaw/pitch/roll; range, bearing, elevation) and `robotPose`, `AprilTagGameDatabase.getCurrentGameTagLibrary()` with the BIOBUZZ IDs 30–45, `WebcamName`, `android.util.Size`, `@TeleOp`/`@Autonomous`/`@Disabled`.

Not supported: raw camera frames into custom `VisionProcessor`s (accepted so code compiles, never called), `LynxModule` bulk reads, Road Runner internals, Blocks/OnBot OpModes.

## Sensor model

- Encoders integrate the simulated wheel speed (first-order lag, 0.12 s) at the configured ticks/rev; `setVelocity` is tracked directly.
- IMU yaw is the robot heading, CCW positive, zeroed when the OpMode is initialised or on `resetYaw()`.
- AprilTag detections come from the twin's camera analysis (in frame, facing the camera, not occluded by the hive, frame, flowers or other robots) with optional Gaussian position noise (*AprilTag noise* in the Hardware map panel, default 0.3 in).
- Gamepads arrive at 50 Hz from the browser.

## Protocol (for other tools)

JSON text frames. Browser → host: `{type:"hardware", devices:[{name,kind,ticksPerRev}]}`, `{type:"sensors", motors:{name:{pos,vel}}, imu:{yaw,pitch,roll,yawRate}, distances:{}, tags:{webcamName:[{id,cx,cy,x,y,z,yaw,pitch,roll,range,bearing,elevation,robotX,robotY,robotYaw}]}, gamepad1:{lx,ly,rx,ry,lt,rt,a,b,x,y,lb,rb,back,start,guide,du,dd,dl,dr,ls,rs}, gamepad2:{...}, battery}`, `{type:"init", opMode}`, `{type:"start"}`, `{type:"stop"}`. Host → browser: `{type:"opmodes", opModes:[{name,group,flavor,className}]}`, `{type:"status", status, opMode, error}`, `{type:"telemetry", lines:[]}`, `{type:"actuators", devices:{name:{kind:"motor",power,mode,reverse,targetVel,targetPos,brake} | {kind:"servo",position} | {kind:"crservo",power}}}` at 50 Hz.
