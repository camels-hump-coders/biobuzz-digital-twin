/**
 * Drive physics for the virtual runtime: a motor torque/speed model, battery sag, and chassis resistance (rolling,
 * static breakaway, skid-steer turning scrub) so that a command below the breakaway produces NO motion, stuck
 * encoders and a stall current, as it did on the real robot (handoff G03). Pure, unit tested.
 *
 * Everything here is a parameterised estimate, not a survey of one robot: the `tiles` profile puts the StarterBot's
 * turning breakaway between the 14 % that stalled and the 20 % that crept on 2026-10-08, and the uncertainty band is
 * meant to be swept, not trusted to the decimal.
 */

export interface MotorSpec {
  /** output shaft free speed at nominal volts, rpm */
  freeRpm: number;
  /** output shaft stall torque at nominal volts, N·m */
  stallTorqueNm: number;
  stallCurrentA: number;
  freeCurrentA: number;
  nominalVolts: number;
}

/** goBILDA 5203 Yellow Jacket, 19.2:1 (312 rpm): 24.3 kg·cm stall, 9.2 A stall, 0.25 A free (datasheet). */
export const GOBILDA_5203_312: MotorSpec = { freeRpm: 312, stallTorqueNm: 24.3 * 0.0980665, stallCurrentA: 9.2, freeCurrentA: 0.25, nominalVolts: 12 };

/** The same motor family with another gearbox: stall torque scales inversely with free speed (same input power). */
export function motorSpecFor(freeRpm: number, base: MotorSpec = GOBILDA_5203_312): MotorSpec {
  const k = base.freeRpm / Math.max(1, freeRpm);
  return { ...base, freeRpm, stallTorqueNm: base.stallTorqueNm * k };
}

export type PhysicsProfileKind = "ideal" | "tiles" | "custom";
export interface PhysicsProfile {
  kind: PhysicsProfileKind;
  /** rolling resistance as a fraction of weight (always opposes motion) */
  rollingMu: number;
  /** static breakaway for straight motion as a fraction of weight */
  staticMu: number;
  /** skid-steer turning scrub as a fraction of weight (torque = scrubMu × m g × wheelbase / 4) */
  scrubMu: number;
  /** kinetic/static ratio once moving */
  kineticRatio: number;
  /** wheel-to-floor grip as a fraction of weight: what decides, against an immovable contact (a ball squeezed on
   * the wall, SG-005), whether the shafts stall or the wheels spin in place. Gecko wheels on foam tiles grip well
   * (estimate 1.2: the StarterBot stalls rather than slips); absent = 1.2 */
  tractionMu?: number;
  /** battery open-circuit volts and internal resistance (sag per amp drawn) */
  batteryVolts: number;
  batteryOhms: number;
  /** label shown to humans and in reports; `estimated` means nobody measured it */
  provenance: "ideal" | "estimated" | "user";
}

export const PHYSICS_PROFILES: Record<Exclude<PhysicsProfileKind, "custom">, PhysicsProfile> = {
  ideal: { kind: "ideal", rollingMu: 0, staticMu: 0, scrubMu: 0, kineticRatio: 1, batteryVolts: 12, batteryOhms: 0, provenance: "ideal" }, // nominal volts: full power = the hardware map's free RPM, as before
  // foam tiles, gecko wheels, 6WD: estimate from the 2026-10-08 session (14 % stalled a turn near target, 20 % crept, 25 % smooth)
  tiles: { kind: "tiles", rollingMu: 0.03, staticMu: 0.06, scrubMu: 0.38, kineticRatio: 0.85, tractionMu: 1.2, batteryVolts: 12.6, batteryOhms: 0.05, provenance: "estimated" },
};
/** The band the estimate is believed to lie in: sweep this, do not encode "14 % always fails". */
export const SCRUB_MU_BAND: [number, number] = [0.3, 0.5];

export interface ChassisParams {
  massKg: number;
  trackWidthM: number;
  wheelbaseM: number;
  wheelRadiusM: number;
  /** motors driving each side (their torques add) */
  motorsPerSide: number;
  motor: MotorSpec;
}

export interface SideCommand {
  /** effective command, −1..1, + = that side's wheels forward */
  u: number;
  /** BRAKE zero-power behaviour: a zero command shorts the motor (strong decel); false = coast */
  brake: boolean;
}

export interface DriveBody {
  /** body-frame forward speed m/s and yaw rate rad/s (CCW +) */
  vFwd: number;
  omega: number;
}

export interface DriveStep {
  body: DriveBody;
  /** output shaft speed per side, rev/s (+ forward) */
  shaftRevPerSec: { left: number; right: number };
  /** per motor current, A */
  currentA: { left: number; right: number };
  /** battery terminal volts after sag */
  volts: number;
  /** a side is commanded above 5 % and its shaft is not turning */
  stalled: { left: boolean; right: boolean };
  /** against a contact: the side's wheels spin on the floor while the chassis does not move (encoders count, no progress) */
  slipping: { left: boolean; right: boolean };
  /** breakaway thresholds for the current profile, as command fractions (what a human needs to read) */
  breakaway: { straight: number; turn: number };
}

const G = 9.81;

/** Command fraction (both sides equal) at which the chassis just breaks away: straight and turning in place. */
export function breakawayCommands(p: ChassisParams, prof: PhysicsProfile, volts = prof.batteryVolts): { straight: number; turn: number } {
  const perSideStall = (p.motorsPerSide * p.motor.stallTorqueNm * (volts / p.motor.nominalVolts)) / p.wheelRadiusM; // N per side at u = 1
  const w = p.massKg * G;
  const straight = perSideStall > 0 ? (prof.staticMu * w) / (2 * perSideStall) : 0;
  const scrub = (prof.scrubMu * w * p.wheelbaseM) / 4;
  const turn = perSideStall > 0 ? scrub / (2 * perSideStall * (p.trackWidthM / 2)) : 0;
  return { straight, turn };
}

/** An immovable contact in front of (+1) or behind (−1) the chassis: a loose ball squeezed against the wall, a
 * chassis against a field element the obstacle model stops it at. 0 = free. Translation into it is impossible;
 * whether the shafts stall or the wheels spin is decided by the traction (`tractionMu`) against the motor force. */
export type ContactBlock = -1 | 0 | 1;

/** Advance the chassis by dt (sub-stepped internally). */
export function stepDrive(body: DriveBody, cmd: { left: SideCommand; right: SideCommand }, p: ChassisParams, prof: PhysicsProfile, dt: number, block: ContactBlock = 0): DriveStep {
  const m = p.massKg, w = m * G, r = p.wheelRadiusM, halfTrack = p.trackWidthM / 2;
  const inertia = (m * (p.trackWidthM ** 2 + p.wheelbaseM ** 2)) / 12;
  const n = Math.max(1, Math.ceil(dt / 0.005));
  const h = dt / n;
  let vFwd = body.vFwd, omega = body.omega;
  let volts = prof.batteryVolts, iL = 0, iR = 0;
  const motor = p.motor;
  const torqueFor = (c: SideCommand, shaftRadPerSec: number, v: number) => {
    const scale = v / motor.nominalVolts;
    const wFree = ((motor.freeRpm * 2 * Math.PI) / 60) * scale;
    const tStall = motor.stallTorqueNm * scale;
    let t: number;
    if (c.u === 0 && !c.brake) t = 0; // coast
    else t = Math.max(-tStall, Math.min(tStall, tStall * (c.u - (wFree > 0 ? shaftRadPerSec / wFree : 0))));
    const current = motor.freeCurrentA + (motor.stallCurrentA - motor.freeCurrentA) * (tStall > 0 ? Math.abs(t) / tStall : 0);
    return { torque: t * p.motorsPerSide, current };
  };
  let stalledL = false, stalledR = false, slipL = false, slipR = false;
  const traction = (prof.tractionMu ?? 1.2) * w / 2; // grip per side, N
  for (let i = 0; i < n; i++) {
    const vL = vFwd - omega * halfTrack, vR = vFwd + omega * halfTrack;
    const tl = torqueFor(cmd.left, vL / r, volts), tr = torqueFor(cmd.right, vR / r, volts);
    iL = tl.current; iR = tr.current;
    volts = Math.max(6, prof.batteryVolts - prof.batteryOhms * (iL + iR) * p.motorsPerSide);
    const fL = tl.torque / r, fR = tr.torque / r;
    // translation
    let fDrive = fL + fR;
    const staticF = prof.staticMu * w, rollF = prof.rollingMu * w;
    let a = 0;
    if (block !== 0 && Math.sign(fDrive) === block && !(Math.sign(vFwd) === -block && Math.abs(vFwd) > 1e-3)) {
      // pushing into something that does not move: the chassis stops; the grip decides what the wheels do
      vFwd = 0;
      slipL = Math.abs(fL) > traction; slipR = Math.abs(fR) > traction;
    } else if (Math.abs(vFwd) < 1e-3 && Math.abs(fDrive) <= staticF) { vFwd = 0; }
    else {
      const resist = (Math.abs(vFwd) < 1e-3 ? staticF * prof.kineticRatio : rollF) * Math.sign(vFwd || fDrive);
      a = (fDrive - resist) / m;
      const next = vFwd + a * h;
      vFwd = Math.sign(next) !== Math.sign(vFwd) && vFwd !== 0 && Math.abs(fDrive) < rollF ? 0 : next; // friction stops, never reverses
    }
    // rotation. At a standstill the wheels must be dragged sideways to pivot, so the full scrub torque is the
    // breakaway (what stalled the 14 % turn). Rolling, the wheels mostly roll along their own direction and only
    // the sideways share of their motion scrubs: resistance = kinetic scrub x lateral / total wheel motion, with no
    // separate threshold, so a 2:1 power split curves instead of driving straight.
    const tDrive = (fR - fL) * halfTrack;
    const scrubStatic = (prof.scrubMu * w * p.wheelbaseM) / 4;
    const rolling = Math.abs(vFwd) > 0.03;
    if (!rolling && Math.abs(omega) < 1e-3 && Math.abs(tDrive) <= scrubStatic) { omega = 0; }
    else {
      const lat = (Math.abs(omega) * p.wheelbaseM) / 2;
      const share = rolling ? lat / Math.sqrt(lat * lat + vFwd * vFwd) : 1;
      const resist = scrubStatic * (Math.abs(omega) < 1e-3 && !rolling ? 1 : prof.kineticRatio) * share * Math.sign(omega || tDrive);
      const alpha = (tDrive - resist) / inertia;
      const next = omega + alpha * h;
      omega = !rolling && Math.sign(next) !== Math.sign(omega) && omega !== 0 && Math.abs(tDrive) < scrubStatic * prof.kineticRatio ? 0 : next;
    }
    void a;
  }
  const vL = vFwd - omega * halfTrack, vR = vFwd + omega * halfTrack;
  const shaft = { left: vL / (2 * Math.PI * r), right: vR / (2 * Math.PI * r) };
  const free = motor.freeRpm / 60;
  // wheels spinning against the floor: the motor runs against the kinetic friction torque, the encoders count
  const slipSpeed = (c: SideCommand) => { const wFree = free * (volts / motor.nominalVolts); const load = (traction * prof.kineticRatio * r) / (motor.stallTorqueNm * (volts / motor.nominalVolts) * p.motorsPerSide); return Math.sign(c.u) * Math.max(0, Math.abs(c.u) - load) * wFree; };
  if (slipL) { shaft.left = slipSpeed(cmd.left); iL = torqueFor(cmd.left, shaft.left * 2 * Math.PI, volts).current; }
  if (slipR) { shaft.right = slipSpeed(cmd.right); iR = torqueFor(cmd.right, shaft.right * 2 * Math.PI, volts).current; }
  stalledL = Math.abs(cmd.left.u) > 0.05 && Math.abs(shaft.left) < 0.02 * free;
  stalledR = Math.abs(cmd.right.u) > 0.05 && Math.abs(shaft.right) < 0.02 * free;
  return { body: { vFwd, omega }, shaftRevPerSec: shaft, currentA: { left: iL, right: iR }, volts, stalled: { left: stalledL, right: stalledR }, slipping: { left: slipL, right: slipR }, breakaway: breakawayCommands(p, prof, volts) };
}
