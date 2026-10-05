# Virtual runtime for TeamCode — Design

Date: 2026-10-04. Builds on the digital twin spec.

## Problem

Coders can only test OpModes by uploading to the one physical robot, which interrupts drivers practising on it. We want the team's unmodified Java OpModes (FTC SDK API, written in Android Studio) to run against the 3D twin: the sim feeds sensors (encoders, IMU, AprilTag detections, gamepads) in, and the OpMode's motor and servo commands drive the simulated robot.

## Approach

Two processes connected by a local WebSocket:

```
 browser (Vite/three.js twin)  <── ws://localhost:8765 ──>  JVM host (runtime/)
   physics, cameras, tags,                                  loads TeamCode classes compiled
   gamepads, HUD, telemetry view                            against sdk-shim; runs OpMode threads
```

- **sdk-shim** (Java library, release 17): re-implements the subset of the FTC SDK surface OpModes compile against — `OpMode`, `LinearOpMode`, `HardwareMap`, `DcMotor`/`DcMotorEx`/`DcMotorSimple`, `Servo`, `CRServo`, `Gamepad`, `Telemetry`, `IMU` (+ `YawPitchRollAngles`, `RevHubOrientationOnRobot`), `ElapsedTime`, `Range`, `DistanceSensor`, `TouchSensor`, `VoltageSensor`, `VisionPortal`, `AprilTagProcessor`, `AprilTagDetection`, `AprilTagPoseFtc`, `AprilTagGameDatabase`, `WebcamName`, `android.util.Size`, the `@TeleOp`/`@Autonomous`/`@Disabled` annotations and the common enums/units. Same package names as the real SDK so TeamCode needs no edits.
- **host**: WebSocket server, OpMode discovery by annotation scanning of the compiled class directories/jars on its classpath, Driver-Station-style lifecycle (INIT, START, STOP) controlled from the browser, 50 Hz exchange: browser → host `sensors` (motor encoder positions/velocities, IMU yaw/pitch/roll, distance sensors, AprilTag detections per webcam, gamepad1/2 state); host → browser `actuators` (motor power or target velocity, run mode, direction; servo positions), `telemetry` lines, `opmodes` list, `status`.
- **Team code**: Gradle module `team` whose source set points at the team's `TeamCode/src/main/java` (`-PteamCode=/path`), compiled against sdk-shim. Files that use SDK classes the shim lacks fail to compile and are listed, so the shim can grow.
- **Browser**: a *Runtime* panel (connection, OpMode picker, INIT/START/STOP, telemetry), a *Hardware map* section mapping configuration names to roles (`frontLeft`, `frontRight`, `backLeft`, `backRight`, `flywheel`, `intake`, `feeder`, `hood`, `imu`, `webcam`) with ticks-per-rev and free RPM, and the actuator model:
  - drive motors: first-order lag to `power × freeRpm`; mecanum or tank forward kinematics from the four wheel speeds to body velocity; encoders integrate wheel rotation, honouring direction.
  - flywheel: `setPower` or `setVelocity` (ticks/s) → RPM; the HUD's RPM follows it.
  - feeder servo: crossing a threshold fires one ball with the current flywheel RPM and hood angle (existing launch path with dispersion and bounces).
  - hood servo: position 0..1 maps to the hood's min..max elevation.
  - IMU: yaw from the robot heading (CCW positive), `resetYaw` supported.
  - AprilTags: for each webcam mount the existing visibility analysis (frustum, facing, occlusion) yields detections with `ftcPose` (x right, y forward, z up, yaw/pitch/roll, range, bearing, elevation) in the camera frame, plus `metadata.fieldPosition`; optional Gaussian noise.
  - Gamepads: the browser's Gamepad API state is forwarded; with no gamepad, the keyboard acts as gamepad1 (WASD = left stick, Q/E = right stick X, Space = A, Shift = right trigger).

## Not in scope now

Raw camera frames into custom `VisionProcessor`s (would need OpenCV on the desktop); Road Runner localisation internals; Blocks/OnBot OpModes; hub-specific classes (`LynxModule`, bulk reads) beyond no-op stubs.
