# BIOBUZZ Digital Twin

A browser-based 3D digital twin of the FIRST Tech Challenge 2026-27 **BIOBUZZ** field and of our robot.
Use it to:

- see exactly what the robot's cameras see from any spot on the mat (field of view footprint, frustum, which AprilTags are in frame, which are occluded by the hive or other robots);
- read off the hood angle, exit speed, flywheel RPM and arc needed to launch POLLEN or NECTAR into the upward-facing CELL from wherever the robot is standing;
- drive around (mecanum or tank, keyboard or gamepad) with simulated partner and opponent robots moving as obstacles;
- load the goBILDA StarterBot CAD (6WD or Strafer mecanum) as the chassis and tune the launcher.

Field geometry comes from the Competition Manual (TU02, Section 9) and the Event Field Setup Guide v1.0.
See `docs/superpowers/specs/2026-10-04-biobuzz-digital-twin-design.md` for the numbers used and the design.

**Try it in the browser:** the twin is a static web app, published to GitHub Pages from `main` at
<https://camels-hump-coders.github.io/biobuzz-digital-twin/> (see [Hosting](#hosting-github-pages)). Driving, cameras, launcher
analysis and the match simulation all run in the page; only running your Java TeamCode needs the local host below.

## Gallery

| | |
|---|---|
| ![Overview: predicted arc, dispersion cloud and hit probability for the raised cell](docs/screenshots/overview.png) | ![What the robot's webcam sees: AprilTags under the raised cell](docs/screenshots/camera-view.png) |
| **Shot analysis.** Hood angle, exit speed and flywheel RPM to reach the raised CELL from where the robot stands, the Monte-Carlo dispersion cloud and the hit probability; partner and opponents on the field. | **Robot camera.** Press 4 to see exactly what the configured webcam sees (preset lens, mount position, pitch); the HUD lists which AprilTags are in frame and which are occluded. |
| ![Top view with camera footprints and the planned trajectory](docs/screenshots/top-view.png) | ![Red hive mid-tip after eight POLLEN, balls rolling out](docs/screenshots/hive-tipping.png) |
| **Top view.** Camera ground footprint, FOV frustum, the launch line and the start/loading zones; shift-click anywhere to teleport and auto-aim. | **Hive physics.** Balls fly, bounce and settle in the cell; the hive tips at the calibrated load and pours the pieces out as it swings. |
| ![Team's TeamCode OpMode running against the twin with Driver-Station style controls and telemetry](docs/screenshots/runtime-teamcode.png) | ![Browser editor for the TeamCode JSON assets](docs/screenshots/teamcode-settings.png) |
| **Virtual runtime.** The team's unmodified Java OpMode (here: tag-based auto aim) running on a desktop JVM, driving the simulated robot from the browser with INIT / START / STOP and live telemetry. | **TeamCode settings.** The OpModes' JSON assets as a searchable form; edits are simulator-only overrides merged at INIT, the repo files stay untouched. |

## Run your TeamCode against the twin (virtual runtime)

Coders can test OpModes without touching the robot. `runtime/` is a desktop JVM host with an FTC SDK shim: your unmodified Java OpModes compile against it and run with INIT / START / STOP from the browser, reading encoders, IMU, AprilTag detections and gamepads from the sim and driving the simulated robot with their motor and servo commands.

Your code stays in your Android Studio project; nothing is copied or moved. One command builds it against the shim, starts the host, starts the twin and opens the browser already connected:

```bash
pnpm sim --team ~/dev/FtcRobotController     # project root, TeamCode module, or its java folder all work
pnpm sim                                      # later runs reuse the remembered path
```

Then pick an OpMode in the **Runtime** panel → INIT → START. Edit your Java in Android Studio and save: the host recompiles and restarts within a few seconds and the browser reconnects, so you never leave the twin. Options: `--exclude "**/roadrunner/**,**/Old*.java"` to skip files that use SDK classes the shim lacks, `--no-watch`, `--no-browser`, `--port`, `--host-port`. The JDK is taken from `JAVA_HOME`, or Android Studio's bundled one if that is missing.

See `runtime/README.md` for the hardware-map setup, keyboard-as-gamepad bindings, what the shim covers and the wire protocol. Two sample OpModes (a mecanum TeleOp and an AprilTag auto-aim autonomous) ship with it.

## Run it

The repo carries a [flox](https://flox.dev) environment with everything needed: Node 22, pnpm, JDK 21, Gradle and Python 3.

```bash
flox activate     # or `flox activate -- pnpm sim` to run a single command inside it
pnpm install
pnpm dev          # http://localhost:5173
pnpm test         # unit tests for geometry, ballistics, kinematics, camera math
pnpm build        # static site in dist/
```

## Saving, sharing and resetting

Everything in the side panel is kept in the browser's localStorage. The **Session** section at the top of the panel has:

- *Export robot config* / *Import robot config*: a JSON file with the robot preset, dimensions, cameras, launcher, shot variability, hardware map and game-piece settings. Share it across browsers or commit it next to your TeamCode.
- *Export whole session* / *Import whole session*: everything, including pose, view and overlay toggles.
- *Reset session to defaults*: clears the saved state and reloads. *Reset robot to preset* only puts the robot back to its preset.

## Controls

| Key | Action |
|---|---|
| W / S | drive forward / back |
| A / D | strafe (mecanum only) |
| Q / E or ← / → | rotate |
| Shift | boost to full speed |
| Space | launch a ball with the current hood angle and RPM |
| T | flip which cell of our hive is up (resets that hive) |
| R | rotate the robot so the launcher points at the target |
| F | toggle field-centric driving |
| 1 / 2 / 3 / 4 | orbit / top-down / chase / robot-camera view |
| H | hide the side panel |
| Shift+click or double-click on the mat | teleport the robot there and aim at the target cell |

Gamepad: left stick drive, right stick rotate, A launch, B aim at target, Y flip target, X field-centric, right trigger boost.

## What the HUD tells you

- **Range** and **bearing error** from the launcher exit point to the aim point (centre of the up-cell opening, 2 in inside).
- **Required exit speed / RPM** for the current hood angle. With *Auto-RPM* on, the commanded RPM tracks this as you drive.
- **Two arcs**: green/red is the arc *if the robot were aimed* at the target with the current hood angle and RPM; orange is the arc along the direction the launcher *actually points right now*. They coincide once you press R or turn to face the target. Either can be switched off in View & overlays.
- **Shot variability**: every fired ball draws random exit speed, elevation, yaw and spin errors (1-sigma values in the Launcher panel, defaults 3 %, 1°, 1°, 20 %). The HUD **hit probability** re-simulates 150 perturbed shots from the current pose and shows the hit fraction with a 95 % confidence interval and the mean miss distance; the dot cloud on the opening plane shows where each lands (green hit, red miss).
- **Match pieces.** The field starts as at competition: 4 POLLEN preloaded on the robot, 4 in each FLOWER, 4 in each GARDEN, 3 NECTAR in each raised cell, 5 NECTAR per alliance in reserve. You can only launch what you carry (capacity 4 by default, POLLEN/NECTAR handling configurable in the Field panel). Balls enter only through the intake side (Robot panel: front/rear/left/right and mouth width; the green bar on the floor outline marks it). Drive that side into a loose ball, or up to a FLOWER's retrieval opening, to pick up; under TeamCode the intake motor must be powered. Any other side of the chassis pushes balls out of the way, and so does the intake once you carry the maximum. After every tip one reserve NECTAR appears in that alliance's LOADING ZONE. The HUD shows what you carry, FLOWER stocks and the NECTAR reserve; the small translucent dots above a robot are the same count, not loose balls. *Reset match to start* puts everything back.
- **Other robots score.** With *They collect and score* on, the partner (your alliance) and the two opponents (the other alliance) run a loop: collect from FLOWERS or loose balls, drive to a launch spot in front of their raised cell, aim, fire with a noisy but calibrated shot, repeat. Each shoots only at its own alliance's hive and only picks up its own colour of NECTAR; switching *Our alliance* flips which robots are partner and opponents and mirrors their starting corners. Both hives count loads and tip, so ball availability and the cell you are aiming at change under you. They are also obstacles and occluders.
- **Hive tipping.** Balls that come to rest in the up cell count toward its load, shown in the HUD with the 3 NECTAR field staff stage there. Field staff calibrate cells to tip at 8 POLLEN or 3 NECTAR + 3 POLLEN, 198.6 g, so with the default 195 g threshold three POLLEN in tips it. The hive then swings over, faster the heavier the load (about 2.6 s at the threshold, under 1 s when well over), the balls ride the swinging cell and roll out as its floor steepens, and the other cell comes up facing the other side of the field, so you have to reposition to keep scoring. Tips and points are tallied in the HUD. Pressing T or choosing a cell in the Field panel resets the hive to match start. The threshold and the auto-tip toggle live in the Field panel.
- **Predicted HIT / MISS** for the current hood angle and RPM, with the height error at the target and the entry angle into the opening plane. The arc is drawn green (hit) or red (miss). If the launcher is not pointed at the target the arc shows what would happen once aimed.
- **Lowest-energy** solution across the hood's adjustable range, plus a fan of all feasible arcs. *Auto-hood* sets the hood to it.
- **Reachability map** (View & overlays): colours every 6 in square of the mat by the RPM needed to hit the target from there with the current launcher. Green is comfortable, red is near the motor limit, dark red cannot reach. Use it to pick launch spots and to see what a fixed hood angle costs you.
- **AprilTags**: green = in frame, facing the camera and unoccluded; orange = in frame but blocked; hover for distance and apparent size in pixels.

## Cameras

**Placing cameras**: in orbit view drag a camera's green body across the robot to move it; hold Alt while dragging to raise or lower it. Use the *+ Rear camera*, *+ Left*, *+ Right* buttons for quick extra mounts (rear is yaw 180°, 7 in behind centre), then fine-tune the numbers. The inset always shows the selected camera, so a rear camera's view is one click away.

*Flip forward direction (180°)* in the Robot panel makes the other end of the robot the forward arrow, moving the CAD, cameras and launcher with it, for teams that treat the shooter side as forward.

Pre-seeded FTC-legal UVC webcams with their published fields of view (Logitech C270/C920/C930e/Brio, Microsoft LifeCam HD-3000, Arducam OV9281/OV9782 global shutter lenses, Limelight 3A). Add as many mounts as you like; each has height, forward/left offset, pitch, yaw, roll and a FOV/resolution override. Every enabled camera gets its own inset in the bottom-left (click an inset to select that camera); press 4 to put the selected one full screen. FTC allows at most two cameras on a robot, so the add buttons stop at two.

## Launcher model

Exit speed = *efficiency* x flywheel surface speed. Hooded single-wheel shooters measure roughly 0.30-0.45; dual opposing wheels around 0.85-0.9. Flight uses quadratic drag (Cd 0.45) and optional Magnus lift from backspin. Measure a few real shots and tune efficiency until the sim matches, then trust the RPM table.

Presets: goBILDA StarterBot (single 96 mm Hogback flywheel on a 6000 RPM 5203 motor, fixed 55° hood, fires out the **back** over the ramp so *Launcher yaw* is 180°), dual flywheel with adjustable hood, custom. The orange exit marker on the robot can be dragged like a camera (Alt-drag for height) and is hidden from the camera views.

## goBILDA CAD

The StarterBot assemblies are published by goBILDA as STEP (about 420 MB each):

- 6WD: https://www.gobilda.com/content/step_files/3200-2627-0003.zip
- Strafer mecanum: https://www.gobilda.com/content/step_files/3200-2627-0004.zip

`scripts/step2glb.py` converts a STEP file to a web-sized GLB (drops parts under 10 mm, tessellates at 0.4 mm):

```bash
python3 -m venv .venv && .venv/bin/pip install cadquery trimesh numpy
.venv/bin/python scripts/step2glb.py 3200-2627-0004.step public/models/starterbot-mecanum.glb
.venv/bin/python scripts/step2glb.py 3200-2627-0003.step public/models/starterbot-6wd.glb
scripts/optimize-glb.sh starterbot-mecanum.glb public/models/starterbot-mecanum.glb   # 185 MB, 8 M triangles -> ~0.6 MB
```

The raw tessellation is about 185 MB with 8 million triangles; the optimise step welds, simplifies to about 320 k triangles and Draco-compresses it to roughly 600 KB, which is what is committed in `public/models/`. Use the *CAD yaw* field in the Robot panel if the model's front does not match the robot's forward arrow.

If a GLB is missing the app falls back to a procedural box with the same footprint and says so in the HUD.

## Hosting (GitHub Pages)

The browser part needs no server: `pnpm build` produces a static site in `dist/`, and `.github/workflows/pages.yml` builds and deploys it to GitHub Pages on every push to `main` (one-time setup: repository **Settings → Pages → Source: GitHub Actions**). `BASE_PATH` sets the sub-path the site is served from, so the same build works at `https://<org>.github.io/<repo>/` or at a root domain.

What works on the hosted page: everything except running Java TeamCode. The virtual runtime needs the JVM host on your own machine; start it with `pnpm sim --team <path>` and the hosted page can still connect to it, because browsers treat `ws://127.0.0.1` as a trusted origin even from an https page (Chrome and Firefox do; Safari may block it, in which case use the local dev server that `pnpm sim` opens).

## Known simplifications

- The *predicted* HIT/MISS and the hit probability are geometric: the arc must cross the opening plane inside the pentagon (shrunk by the ball radius plus the 12 mm lip tube) while moving into the cell. *Fired* balls are simulated live with drag, gravity and bounces off the hive cells, frame, flowers, walls, robots and floor (restitution about 0.45, foam floor 0.5), and a shot only counts as a hit in the Fired / hit tally when the ball comes to rest inside the target cell (low-speed contacts are treated as resting, so balls settle on the sloped floor). Tipping is a timed swing driven by the load, not a rigid-body simulation of the bi-stable hive.
- AprilTags are real tag36h11 codes (IDs 30–45) at the manual's cluster geometry (centres at ±2.75 and ±6.5 in, 7.19 in behind the opening), so a vision pipeline looking at the camera inset sees genuine tags. The runtime still hands detections to TeamCode synthetically rather than decoding pixels.
- Other robots follow fixed waypoint loops and do not score or avoid each other.
- Driving: the two triangular frame legs and the four FLOWER cages block the robot; the space under the cells between the legs is open, as on the real field.
- Camera images are ideal pinhole renders: no lens distortion, exposure or motion blur.

## Coordinate system

Metres internally, inches in the UI. Origin at field centre on the tile surface, X toward the blue alliance, Y up, +Z toward the audience. Heading 0 means the robot faces the scoring side.
