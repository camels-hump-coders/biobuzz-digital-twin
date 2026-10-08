/**
 * The HIVE as a damped hinge. One degree of freedom: the tray angle θ about the pivot axis (+X); θ > 0 raises the
 * audience (+Z) end, the two rest positions are the ±30° stops. A detent holds the tray at a stop until the load
 * threshold lifts it (that decision stays in the match model); from then on the swing is physical: gravity on the
 * tray (centre of mass a little above the hinge, so the tray is bi-stable and finishes the swing once past level),
 * gravity on the balls riding in the cell at their actual positions (they drive the first half, then roll out as
 * the floor steepens), viscous damping fitted to a 2–3 s swing, a hard stop, and an anti-stall floor so a swing
 * that has started always completes (the real tray has the same property: once the detent lets go it falls over).
 * Pure functions, no three.js, unit tested.
 */

export const G = 9.80665;
/** tray mass (both cells and the arm), kg, and the perpendicular height of its centre of mass above the hinge, m.
 *  11 kg · 10 mm gives a holding torque of 0.54 N·m at the stop, well under the 0.9 N·m of the 190 g load that
 *  lifts the detent, so the balls drive the first half of the swing and the tray's own weight finishes it. */
export const TRAY_MASS_KG = 11;
export const TRAY_COM_UP_M = 0.01;
/** moment of inertia about the hinge, kg·m² (mass spread along the 1.09 m arm) */
export const TRAY_INERTIA = 1.6;
/** viscous damping, N·m·s: fitted so a 200 g load swings stop to stop in about 2.6 s and 400 g in about 1.7 s
 *  (balls ride until the floor tilts about 20° toward the opening) */
export const TRAY_DAMPING = 1.2;
/** slowest the tray is allowed to move once released, rad/s */
export const STALL_FLOOR = 0.2;
export const STOP_RAD = (30 * Math.PI) / 180;

export interface HingeState {
  /** current angle, rad */
  angle: number;
  /** angular speed, rad/s */
  omega: number;
  /** the stop the swing is heading for, rad (±STOP_RAD) */
  to: number;
  /** time since release, s */
  t: number;
}

/** Torque from gravity on a point mass riding with the tray at offset (rz) along world Z from the pivot:
 *  raising θ raises the +Z end, so ∂y/∂θ = rz and τ = −m g rz. Sum this over the balls in the cells. */
export function loadTorque(masses: { massKg: number; rz: number }[]): number {
  let t = 0;
  for (const b of masses) t -= b.massKg * G * b.rz;
  return t;
}

/** Gravity on the tray itself: its centre of mass sits TRAY_COM_UP_M above the hinge, so τ = M g u sin θ, which pushes
 *  the tray away from level toward whichever stop it is nearer (bi-stable). */
export function trayTorque(angle: number): number {
  return TRAY_MASS_KG * G * TRAY_COM_UP_M * Math.sin(angle);
}

/** Advance the hinge by dt with the given load torque (from loadTorque). Returns true once the far stop is reached. */
export function stepHinge(s: HingeState, loadTau: number, dt: number, extraInertia = 0): boolean {
  const dir = Math.sign(s.to - s.angle) || Math.sign(s.to);
  const I = TRAY_INERTIA + extraInertia;
  const tau = trayTorque(s.angle) + loadTau - TRAY_DAMPING * s.omega;
  s.omega += (tau / I) * dt;
  // anti-stall: a released tray never dawdles between the stops (and never turns back for long)
  if (s.t > 0.15 && s.omega * dir < STALL_FLOOR) s.omega = STALL_FLOOR * dir;
  s.angle += s.omega * dt;
  s.t += dt;
  if ((dir > 0 && s.angle >= s.to) || (dir < 0 && s.angle <= s.to)) { s.angle = s.to; s.omega = 0; return true; }
  return false;
}

/** Seconds the swing will still take at the current speed (for the HUD): remaining angle over the larger of the
 *  current speed and the stall floor. */
export function remainingSwing(s: HingeState): number {
  return Math.abs(s.to - s.angle) / Math.max(Math.abs(s.omega), STALL_FLOOR);
}
