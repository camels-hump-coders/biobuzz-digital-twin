# Physical-fidelity fixtures

Regression fixtures for the failures the physical robot exposed on 2026-10-08 (handoff *lessons from the physical
robot*; design in `docs/superpowers/specs/2026-10-09-physical-fidelity-fixtures-design.md`). They run the team's
`BioBuzz: Auto 30s + Drive` with the team's saved robot (`twinSettings: true`), so pass `--team <team repo>`:

```bash
pnpm twin-test --team ~/dev/github.com/camels-hump-coders/biobuzz scenarios/physical/*.json --out-dir /tmp/physical-reports
```

Several fixtures are **expected to fail**: that is the point. An older broad "full auto passed" test would have
missed each of them.

| fixture | shows | expected verdict on the local TeamCode (`nowell/auto-30` @ bedfe9c) |
|---|---|---|
| 00-route-tiles | finishing turns at the 14 % floor stall on the estimated tiles profile | pass (a stall event is required) |
| 01-route-ideal | the old green run, labelled ideal in its manifest, with physical outcome checks on | pass if a ball launches and a POLLEN is collected |
| 10-feed-short-pulse | 0.4 s pulses: fewer launches than pulses | pass |
| 11-feed-long-pulse | 1.0 s pulses launch | pass |
| 12-empty-hopper | launches follow the balls aboard, not the pulses | pass |
| 20-tag-cover-lower | the lowered cell covered: the raised cell is seen alone | pass |
| 21-tag-misread-mix | lower tags decoded as upper ids while aiming | informational (read launches and Target telemetry) |
| 22-tag-latency-500ms | stale frames from AIM_SHOOT: no shot, bounded leg | **fails** until the no-shot timer fix is pulled |
| 30-collect-miss | wrong end to the garden: states visited, nothing collected | **fails** on collectedAtLeast by design |
| 40-deadline-28s | physical feed timing inside 28 s | depends on the route; never widen the window |
| 50-bind-conflict | scenario range vs. bound range | **fails at setup** by design (effective value is bound) |
| 51-bind-conflict-nobind | same with bindings off | pass |
| 60-unsupported-pixels | a coverage the twin cannot provide | UNSUPPORTED |

Every report carries `manifest` (robot identity, physics and perception with provenance, every TeamCode setting with
its source), `events` (stall, feed, launch, fault, status) and `timing` (simulated/wall ratio, held packets). A run
the machine could not keep near real time is `inconclusive`, not green.
