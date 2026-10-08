# DSIM-inspired mechanics: intake brushes, robot customizer, competition audio, physics

Date: 2026-10-08. Inspiration: [playdsim.com/biobuzz](https://www.playdsim.com/biobuzz) (DSIM, source-available under
PolyForm Noncommercial; studied for mechanics and numbers only, no code or assets reused). The twin keeps its own
strengths (runs real TeamCode, cameras, ballistics, calibration) and adopts four ideas.

## 1. The intake has to run, and only brushes reach into a FLOWER

**Problem.** Keyboard driving forced the intake on every frame, so touching a ball or parking anywhere within 9 in of
a FLOWER's axis collected POLLEN. Under TeamCode the intake motor already had to be powered, so manual play and
TeamCode play disagreed.

**Rule (both modes).** A ball is collected only while the intake runs: under TeamCode when the `intake` role motor
is powered above 0.2; manually while the intake key is held or the intake toggle is on. The scripted robots run
their own intake while seeking, as before.

**Intake kinds** (`RobotSpec.intake.kind`):

| kind | ground balls | FLOWER retrieval opening |
|---|---|---|
| `roller` (plain compliant roller / sweeper) | yes | no: the roller never reaches past the lower ring plate |
| `brushes` (side brushes / star wheels at the mouth ends) | yes | yes |

The StarterBot presets use `brushes` (the kit intake pulls POLLEN out of the FLOWER), so existing saves keep
working; `custom18` uses `brushes` too. Saves without `kind` migrate to `brushes`.

**FLOWER geometry gate.** The FLOWER axis must sit inside the intake mouth frame: lateral offset within half the
mouth width plus 1 in, and the mouth edge between 1 in inside and 6.5 in outside the axis (the retrieval opening is
3.57 in deep and the lower ring 2.79 in; the brushes need to overlap the opening). No speed or angle test beyond the
mouth frame (DSIM does the same). One POLLEN leaves per 0.3 s (DSIM 0.15 s, our rollers are slower), bottom first,
and the stack drops as today.

**Controls.** Keyboard: `I` toggles the intake, holding `K` runs it while held. Gamepad: LB toggles, LT runs while
held. Setting *Auto intake* (off by default) restores the old always-on behaviour for people who only want to shoot.
The HUD shows the intake state next to the inventory dots, and the existing "ball not collected · intake off" notice
now appears in manual mode too, naming the key.

**Visuals.** The green/red intake bar remains. With `brushes`, two short cylinders at the mouth ends spin while the
intake runs. A per-swallow "slurp" sound (section 3).

## 2. Robot customizer

The flat *Robot* form becomes a customizer with three parts, all in the existing *Robot* section (so settings
search, pinning, history and the settings file keep working; no shadow copies).

1. **Starter profiles**: a horizontal strip of cards. Each card: name, one-line tagline, chips for drivetrain,
   intake and launcher, and a stat line (top speed, mass, footprint). The card whose spec equals the current robot
   (identity and look ignored) shows "on the field"; otherwise the strip says "Custom · based on <preset>".
   Profiles: goBILDA StarterBot 6WD, goBILDA StarterBot Strafer, *Pollinator* (435 rpm mecanum, front brushes,
   dual flywheel, 13 kg), *Forager* (6WD pusher, 312 rpm, rear brushes, 15 kg), *Custom 18 in mecanum* (unchanged).
2. **Build**: the existing dimension / wheel / mass / intake controls plus *Intake kind*. A live **spec readout**
   above them: top speed (m/s and ft/s from wheel RPM × circumference), footprint, height, mass, intake, launcher
   summary. A validation line turns red when the footprint exceeds 18 × 18 in or height exceeds 18 in (R102 starting
   configuration); it warns, it does not clamp, so older saves are not rewritten silently.
3. **Look**: chassis colour swatches (12), accent colour, decal (none / stripe / chevron / checker) and a team number
   plate. The box chassis takes the colour and decal; CAD chassis get a 35 % tint and the plate. The plate and decal
   are a canvas texture on a thin plane on the robot's top; the camera renders hide them like the other markers.
   `RobotSpec.look = { color, accent, decal, plateText }`; `RobotSpec.color` stays for compatibility and mirrors
   `look.color`.

The Practice *Experiment* card keeps its two StarterBot buttons and gains a "More robots →" link into Robot setup.

## 3. Competition audio and the AUTO→TELEOP transition

**Match timeline.** AUTO 0:30, an 8 s transition that does not consume the 2:30 clock (Competition Manual §10.4),
TELEOP 2:00. New state `matchTransition?: number` counts 8 → 0 while `matchClock` holds at 120. During the
transition the scripted robots freeze and manual drive input is ignored (G403: no powered movement); TeamCode keeps
running (a real team would be switching OpModes; the twin does not stop their program). Setting *8 s AUTO→TELEOP
transition* (on by default) can turn the hold off for scripts that want a continuous 2:30.

**Cues** (Table 9-1), all synthesized with Web Audio, no sample files:

| event | cue |
|---|---|
| match start | "3, 2, 1" voice (speech synthesis, beep fallback) then a bugle *Cavalry Charge* (triad arpeggio) |
| AUTO ends (2:00) | buzzer × 3 |
| transition 6.5 s left | voice "Drivers, pick up your controllers", then "3, 2, 1" on the last three seconds |
| TELEOP begins | three bells |
| 0:20 left | train whistle (two detuned tones with vibrato) |
| match end | 3-second buzzer |
| match stopped early / reset | foghorn |
| shot fired | short filtered-noise thwump |
| ball swallowed | rising sine blip |
| hive breaks away / lands | low clunk, then a rattle as balls spill |
| ball bounce | rate-limited click, volume by impact speed |

**Design.** `src/sim/audio.ts` exports `MatchAudio` with `update(snapshot)` that edge-detects from world state
(phase, clock, transition, shot count, intake count, tip count, bounce events). No sim code calls audio
directly. The `AudioContext` is created on the first pointer/key gesture and resumed on every gesture while
suspended; volume is enforced at the gain stage so a muted context still warms up. Settings: master, cues, effects,
voice (0–1), stored in `AppState.audio`; a *Sound* section in All settings with an audition button per cue.
Headless (`?ci=1`) runs never create a context.

## 4. Physics

1. **Hive as a damped hinge.** The tip is no longer a fixed-duration ease. A one-degree-of-freedom pendulum about
   the pivot: tray mass 8.6 kg (19 lb) with its centre of mass 0.14 m above the hinge (bi-stable), ballast 2.7 kg
   0.24 m below, plus the ball loads at their actual positions; angular damping fitted so an unloaded release
   swings stop to stop in about 3 s; hard stops at ±30°; a detent holds the tray until the load threshold lifts it;
   an anti-stall floor of 0.12 rad/s keeps a slow swing moving. Balls still ride via `carryBalls`, so the existing
   spill behaviour (they slide out as the floor steepens) is kept but now follows a physical swing: heavier loads
   tip faster.
2. **Ball–ball contact everywhere.** Sphere–sphere separation and impulse exchange (restitution 0.55) for every pair
   that is not both settled, including balls in a cell and in flight. Settled balls that are hit wake up. The old
   floor-only pass is replaced.
3. **Coulomb rolling.** Rolling balls on tiles lose a constant 0.3 m/s² and snap to rest below 0.05 m/s, instead of
   the exponential decay that let slow balls creep for seconds.

Drag and Magnus stay as they are (DSIM has neither).

## Verification

Unit tests: intake gate and FLOWER mouth test (`test/intake.test.ts`), hinge model reaches the far stop and tips
faster with more load (`test/hiveTip.test.ts`), ball–ball separation (`test/ballPhysics.test.ts`), audio
edge-detection with a fake synth (`test/audio.test.ts`), profile matching (`test/presets.test.ts`). Browser check with
Playwright on port 5195: intake off → no pickup at a FLOWER; `I` → pickup; a full match with the transition; the
customizer renders and switching cards changes the field robot.
