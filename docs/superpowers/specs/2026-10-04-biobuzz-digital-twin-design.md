# BIOBUZZ Digital Twin — Design

Date: 2026-10-04. Status: approved by default (user asked for no approval gates; evaluate the finished product).

## Purpose

A browser-based 3D digital twin of the FIRST Tech Challenge 2026-27 BIOBUZZ field and of our robot, used to:

1. Understand what our robot's cameras can see from any pose on the field (field of view on the mat, which AprilTags are visible, occlusion by the hive and other robots).
2. Work out the launch angle, exit speed, flywheel RPM and arc needed to put POLLEN or NECTAR into the upward-facing CELL of our HIVE from any position.
3. Drive the robot around the mat (mecanum or tank) with keyboard or gamepad, with simulated alliance partner and opponent robots moving around as obstacles and occluders.
4. Load the goBILDA StarterBot CAD (6WD and Strafer mecanum variants) as the robot body, and customise the launcher.

Success: a student can open the page, pick a robot preset, drop a camera on it, drive to a spot, press the launch key, and immediately see whether the shot lands and what to change.

## Field facts used (Competition Manual TU02 §9, Event Field Setup Guide v1.0)

| Item | Value |
|---|---|
| Field interior | 144 x 144 in, 36 tiles of 24 in |
| Red alliance | left of audience; audience side is +Z in the scene |
| Hive frame | 49.46 in wide (X), 38.95 in deep (Z), pivot axis 43.95 in above tiles, along X |
| Hive spacing | 25.5 in centre to centre; red at X = -12.75 in, blue at +12.75 in |
| Hive arm | 42.91 in long, cells 12.04 in deep, 18.84 in gap, tilted 30 deg |
| Cell opening | 20 in wide, 14 in tall pentagon (7.61 in straight side, apex at 14 in) |
| Up-cell opening | bottom 53.5 in, top 65.6 in above tiles |
| Match start | red audience cell up, blue scoring cell up, 3 NECTAR in each up cell |
| Flowers | 4, on the perimeter at seams: N wall X=-24, E wall Z=-24, S wall X=+24, W wall Z=+24; top opening 4 in dia at 21.5 in |
| Pollen | 2.8 in dia, 24.9 g, yellow; 4 per flower, 4 per garden, 4 preloaded per robot |
| Nectar | 3.6 in dia, 41.3 g, red/blue |
| Loading zones | red tile A5 (X -72..-61, Z -47..-24 scoring side), blue tile F2 mirrored |
| Gardens | red tile A1 corner on audience wall, blue tile F6 corner on scoring wall |
| AprilTags | 36h11, 3.25 in, 4 per cell underside; red scoring 30-33, red audience 34-37, blue audience 38-41, blue scoring 42-45 |
| Robot | 18 in cube start, 18 x 24 x 29 in expanded, max 6 ft 6 in |

Coordinate system in the scene: metres, Y up, X toward blue alliance, +Z toward audience. Field centre is the origin at tile level. The UI shows inches.

## Architecture

Static single page app: Vite + TypeScript + three.js. No backend. State persisted in localStorage and exportable as JSON. Tests with vitest for the pure modules.

```
src/
  field/     fieldSpec.ts (constants), hive.ts (pose + opening polygon), buildField.ts (meshes)
  robot/     robotSpec.ts (types), presets.ts, robot.ts (three.js object + GLB loader)
  camera/    cameraPresets.ts (UVC list), robotCamera.ts (frustum, ground footprint, tag visibility)
  ballistics/ projectile.ts (drag integrator), solver.ts (speed/angle for target), launcher.ts (flywheel model)
  sim/       drive.ts (mecanum/tank kinematics + bounds), input.ts (keyboard/gamepad), opponents.ts
  ui/        panel.ts (controls), hud.ts (readouts)
  main.ts    scene, viewports, loop
scripts/step2glb.py   offline goBILDA STEP -> GLB conversion
public/models/        converted GLBs
```

### Pure modules (unit tested)

- **fieldSpec / hive**: given hive colour and tilt sign, return pivot, arm direction, the opening polygon of the up cell in world space, the AprilTag poses. Tests check the manual's 53.5 / 65.6 in opening heights.
- **projectile**: semi-implicit Euler with quadratic drag (Cd 0.45, air 1.225 kg/m3) and optional Magnus lift; step 2 ms. Analytic no-drag check in tests.
- **solver**: for a launch point, target point and fixed elevation angle find the exit speed by bisection on the arc's height at the target's horizontal range; for an adjustable hood, scan angles and return all feasible (angle, speed) pairs whose arc crosses the opening plane inside the polygon shrunk by the ball radius while descending into it. Report the minimum-speed solution.
- **launcher**: exit speed = efficiency x wheel surface speed; RPM from speed. Presets: StarterBot single 96 mm Hogback flywheel on a 6000 RPM 5203 motor, dual-wheel, and a custom.
- **drive**: mecanum (vx, vy, w) and tank (vx, w), speed limit from wheel RPM and diameter, robot-centric or field-centric, clamp to perimeter and push out of the hive frame footprint.
- **camera math**: diagonal FOV + aspect -> horizontal/vertical FOV; frustum-ground intersection polygon; visibility test for tags (inside frustum, facing the camera, unoccluded via raycast against hive and robots).

### Scene

Field group (tiles with seams, walls, tape, hive structure with tiltable hives, flowers, staged balls, tag clusters), robot group (chassis GLB or procedural box, camera gizmos, launcher marker), opponent robots, overlays (frustum lines, FOV footprint on the mat, trajectory arcs, feasible-launch fan, target highlight, aim line). Views: orbit, top-down, chase, robot camera (full screen), plus a picture-in-picture inset of the selected robot camera.

### Controls

Keyboard: WASD drive, QE rotate, Shift boost, Space launch, 1-4 views, T toggles the targeted hive cell, F toggles field-centric. Gamepad: left stick drive, right stick rotate, A launch. The side panel edits robot, cameras, launcher, opponents and overlays.

## Decisions and assumptions

- Launching uses the aim point at the centre of the up-cell opening, 2 in inside the plane; success is tested geometrically on the opening polygon, not with rigid-body physics. Good enough for aiming; a tipping simulation is out of scope.
- CAD: the full 420 MB STEP assemblies are converted offline, dropping parts under 10 mm and tessellating at 0.4 mm. If the resulting GLB is too large for the web the fallback is a procedural chassis with the same footprint.
- AprilTags are rendered as labelled placeholders with correct size and pose; real 36h11 bit patterns are not needed for the FOV study.
- Opponent robots follow scripted waypoint loops; they do not score.
- No scoring/match timer in this version.
