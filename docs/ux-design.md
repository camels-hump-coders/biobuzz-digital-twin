# BIOBUZZ workspace design

The primary workflow is choose a task, act on the field, understand the result, then refine a setting. Preserve this sequence as features are added.

## Navigation and ownership

Practice, Run TeamCode, and Analyze are activities over one shared simulation. Switching activities changes presentation, not robot configuration or runtime state. Robot setup and All settings remain reachable from every activity. Keep runtime Stop in the persistent control bar whenever TeamCode owns the robot, including INIT. Match and runtime lifecycle transitions must retain their existing coupling.

The field owns driving keys only while focused; inputs, buttons, selects, dialogs, and Tab keep native behavior. Manual aim/shoot are unavailable during runtime control and replay. Replay requires an explicit return to live. Touch layouts prioritize a readable field and collapsible controls over pretending a phone has a keyboard.

## Settings

Use the original input and handler in contextual views and pinned areas; never create unsynchronized copies. Associate every input with a label. Keep units visible. Advanced controls belong in named, searchable groups. All settings must include every capability even when a task hides it.

Configuration undo excludes live physics, automatic launcher outputs, and navigation. Project saves require a review of changed values and an explicit write. Browser overrides, bound twin measurements, and file values have distinct labels. Do not imply that undo reverts a saved project file. The reversible sample stores its backup for the lifetime of the browser tab.

## Feedback and visual hierarchy

Lead with current readiness and a supported next action. Conditional shot probabilities belong under a clear "after aiming" label. Do not describe a predicted hit as a settled score. Show map legends, target labels, runtime ownership, and visible recovery actions. Keep long help text and exact scientific values available without making them prerequisites to the first shot.

Use the shared form styles in dialogs as well as side panels. Reserve accent color for the active activity and primary action, red for stop/errors, and muted text for supporting detail. At narrow widths, preserve the persistent lifecycle controls and a visible panel toggle. Honor reduced-motion preferences.

## Verification

`npm run typecheck`, `npm test`, and `npm run build` cover static and model checks. With the dev server at port 5173, `node scripts/ux-smoke.mjs` exercises the manual UX, history, pins, keyboard, calibration, replay, and responsive layouts. `node scripts/ux-runtime-smoke.mjs` exercises runtime lifecycle and settings writes against an isolated WebSocket fixture; it does not execute Java or write a real team repo. Regenerate the gallery through `scripts/gallery.mjs`; `--demo-runtime` uses clearly labelled illustrative telemetry.

Runtime guidance must reflect the live connection and lifecycle state, including the next action in the persistent control bar. Keep common simulation and map switches directly on the field. Camera previews provide a persistent size preference; skipped render frames must retain the last image instead of hiding the preview.

Button audit (2026-10-06): reviewed the workspace, panel, HUD, calibration, and preview button handlers for an action, unavailable-state gating, and visible feedback. Browser coverage exercises navigation, settings edits/history/pins, sample restore, shooting, calibration measurement/clear, replay, match start/stop, About, camera sizing, overlays, runtime enable/disable and INIT/START/STOP, and save review/cancel with a mock host. Real host writes, native import pickers, external links, and all clipboard-permission variants were reviewed in source rather than exercised against user data.

Audit fixes: replace focus-only run-controls navigation with direct lifecycle actions; disable Reset position under runtime/replay ownership, calibration Back on step one, and Return/Go live while already live; show clipboard success/failure and invalid calibration-import feedback; keep runtime disabled until explicitly enabled; expose an always-visible match countdown and shot summary. Power is an estimate from RPM divided by configured free RPM. Map selection is exclusive in both quick controls and All settings. About belongs in the primary header and leads with the team identity.

Preserve section expansion, scroll, and field focus during settings redraws. Low-detail mode must offer restoration of the previous visual settings. Manual mecanum defaults use the alliance driver perspective; a camera-projected arrow identifies W/up (or robot-forward when explicitly selected). Physics bounds must match visible geometry, including wall height.

Connected workspaces surface the actual robot-config and TeamCode sync/save controls outside disclosures. Preserve their review-before-write behavior and distinguish local changes from matching project files. Focus field must transfer DOM focus, visibly mark keyboard ownership, and reveal the field. Use Tune for parameter editing; reserve analysis language for the live field summaries.
