# BIOBUZZ Digital Twin

A browser-based 3D digital twin of the FIRST Tech Challenge 2026-27 **BIOBUZZ** field and of our robot.
Use it to:

- see exactly what the robot's cameras see from any spot on the mat (field of view footprint, frustum, which AprilTags are in frame, which are occluded by the hive or other robots);
- read off the hood angle, exit speed, flywheel RPM and arc needed to launch POLLEN or NECTAR into the upward-facing CELL from wherever the robot is standing;
- drive around (mecanum or tank, keyboard or gamepad) with simulated partner and opponent robots moving as obstacles;
- load the goBILDA StarterBot CAD (6WD or Strafer mecanum) as the chassis and tune the launcher.

Field geometry comes from the Competition Manual (TU02, Section 9) and the Event Field Setup Guide v1.0.
See `docs/superpowers/specs/2026-10-04-biobuzz-digital-twin-design.md` for the numbers used and the design.

## Run it

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm test         # unit tests for geometry, ballistics, kinematics, camera math
pnpm build        # static site in dist/
```

## Controls

| Key | Action |
|---|---|
| W / S | drive forward / back |
| A / D | strafe (mecanum only) |
| Q / E or ← / → | rotate |
| Shift | boost to full speed |
| Space | launch a ball with the current hood angle and RPM |
| T | flip which cell of our hive is up |
| F | toggle field-centric driving |
| 1 / 2 / 3 / 4 | orbit / top-down / chase / robot-camera view |
| H | hide the side panel |

Gamepad: left stick drive, right stick rotate, A launch, Y flip target, X field-centric, right trigger boost.

## What the HUD tells you

- **Range** and **bearing error** from the launcher exit point to the aim point (centre of the up-cell opening, 2 in inside).
- **Required exit speed / RPM** for the current hood angle. With *Auto-RPM* on, the commanded RPM tracks this as you drive.
- **Predicted HIT / MISS** for the current hood angle and RPM, with the height error at the target and the entry angle into the opening plane. The arc is drawn green (hit) or red (miss). If the launcher is not pointed at the target the arc shows what would happen once aimed.
- **Lowest-energy** solution across the hood's adjustable range, plus a fan of all feasible arcs. *Auto-hood* sets the hood to it.
- **AprilTags**: green = in frame, facing the camera and unoccluded; orange = in frame but blocked; hover for distance and apparent size in pixels.

## Cameras

Pre-seeded FTC-legal UVC webcams with their published fields of view (Logitech C270/C920/C930e/Brio, Microsoft LifeCam HD-3000, Arducam OV9281/OV9782 global shutter lenses, Limelight 3A). Add as many mounts as you like; each has height, forward/left offset, pitch, yaw, roll and a FOV/resolution override. The inset in the bottom-left renders the selected camera; press 4 to go full screen.

## Launcher model

Exit speed = *efficiency* x flywheel surface speed. Hooded single-wheel shooters measure roughly 0.30-0.45; dual opposing wheels around 0.85-0.9. Flight uses quadratic drag (Cd 0.45) and optional Magnus lift from backspin. Measure a few real shots and tune efficiency until the sim matches, then trust the RPM table.

Presets: goBILDA StarterBot (single 96 mm Hogback flywheel on a 6000 RPM 5203 motor, fixed hood), dual flywheel with adjustable hood, custom.

## goBILDA CAD

The StarterBot assemblies are published by goBILDA as STEP (about 420 MB each):

- 6WD: https://www.gobilda.com/content/step_files/3200-2627-0003.zip
- Strafer mecanum: https://www.gobilda.com/content/step_files/3200-2627-0004.zip

`scripts/step2glb.py` converts a STEP file to a web-sized GLB (drops parts under 10 mm, tessellates at 0.4 mm):

```bash
python3 -m venv .venv && .venv/bin/pip install cadquery trimesh numpy
.venv/bin/python scripts/step2glb.py 3200-2627-0004.step public/models/starterbot-mecanum.glb
.venv/bin/python scripts/step2glb.py 3200-2627-0003.step public/models/starterbot-6wd.glb
npx @gltf-transform/cli optimize public/models/starterbot-mecanum.glb public/models/starterbot-mecanum.glb --compress draco
```

If a GLB is missing the app falls back to a procedural box with the same footprint and says so in the HUD.

## Coordinate system

Metres internally, inches in the UI. Origin at field centre on the tile surface, X toward the blue alliance, Y up, +Z toward the audience. Heading 0 means the robot faces the scoring side.
