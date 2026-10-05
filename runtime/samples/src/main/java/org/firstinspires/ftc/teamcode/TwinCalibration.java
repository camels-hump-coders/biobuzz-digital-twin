package org.firstinspires.ftc.teamcode;

import com.qualcomm.robotcore.eventloop.opmode.OpMode;
import com.qualcomm.robotcore.eventloop.opmode.TeleOp;
import com.qualcomm.robotcore.hardware.CRServo;
import com.qualcomm.robotcore.hardware.DcMotor;
import com.qualcomm.robotcore.hardware.DcMotorEx;
import com.qualcomm.robotcore.hardware.DcMotorSimple;
import com.qualcomm.robotcore.hardware.Servo;
import com.qualcomm.robotcore.hardware.VoltageSensor;
import com.qualcomm.robotcore.util.RobotLog;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Shooter calibration for the BIOBUZZ digital twin. Runs unchanged on the robot and in the twin.
 *
 * Park the robot square to a wall with the shooter facing it (bumper distance from the twin's calibration wizard),
 * pick a flywheel power, fire one ball at a time and note where it hit. Every shot is announced on telemetry and in
 * the log as `CAL shot=N power=P rpm=R volts=V`; the twin's "Shooter calibration" panel reads those lines (paste them
 * from the Driver Station log, or they arrive automatically when this OpMode runs in the twin), you click where the
 * ball landed, and the fitter tunes the twin's launcher to match the robot.
 *
 * Controls (gamepad 1): dpad left/right = step through the calibration powers, dpad up/down = power ±0.05,
 * X = flywheel on/off at that power, A = fire one ball (spins up first, waits for the wheel to settle, feeds),
 * B = mark the last shot as a miss-feed to ignore, Y = stop everything.
 *
 * Hardware: the first matching name is used, so the same file serves the Camels Hump robot ("Firing Mechanism",
 * "Windmill Feeder" + front feeders) and the sim's default StarterBot map ("shooter", "feeder").
 */
@TeleOp(name = "Twin: Shooter Calibration", group = "Twin")
public class TwinCalibration extends OpMode {
    // ---- edit these to match your robot -----------------------------------------------------------------------
    static final String[] SHOOTER_NAMES = { "Firing Mechanism", "shooter" };
    static final String[] FEEDER_NAMES = { "Windmill Feeder", "feeder" };
    /** extra continuous-rotation feeders that run while feeding: name, signed power (Camels Hump front feeders) */
    static final Object[][] FEED_HELPERS = { { "Front Right Feeder", -0.35 }, { "Front Left Feeder", 0.35 }, { "Intake", 0.4 } };
    static final double SHOOTER_TICKS_PER_REV = 28;      // bare goBILDA 5203 encoder (6000 RPM shooter motor)
    static final double[] POWERS = { 0.5, 0.65, 0.8, 1.0 }; // must match the twin wizard's schedule
    static final double FEEDER_POWER = 0.2;              // continuous-rotation feeder power while feeding (profile "windmill")
    static final double FEED_SECONDS = 2.0;              // long enough for exactly one ball to leave
    static final double SPINUP_MAX_SECONDS = 3.0;
    static final double SETTLE_SECONDS = 0.5;            // RPM must stay within SETTLE_TOL for this long before feeding
    static final double SETTLE_TOL = 0.03;

    private DcMotorEx shooter;
    private CRServo feederCr;
    private Servo feederPos;
    private final List<CRServo> helpers = new ArrayList<>();
    private final List<Double> helperPowers = new ArrayList<>();
    private final List<DcMotor> helperMotors = new ArrayList<>();
    private final List<Double> helperMotorPowers = new ArrayList<>();
    private VoltageSensor battery;

    private int powerIndex = 0;
    private double power = POWERS[0];
    private boolean spinning = false;
    private int shots = 0;
    private String lastShot = "none yet";
    private enum Phase { IDLE, SPINUP, FEED }
    private Phase phase = Phase.IDLE;
    private double phaseStart = 0, settleStart = -1, rpmAtSettle = 0, rpmAvg = 0;
    private boolean lastA, lastB, lastX, lastY, lastUp, lastDown, lastLeft, lastRight;

    @Override public void init() {
        for (String n : SHOOTER_NAMES) if (hardwareMap.dcMotor.contains(n)) { shooter = hardwareMap.get(DcMotorEx.class, n); break; }
        if (shooter == null) shooter = hardwareMap.get(DcMotorEx.class, SHOOTER_NAMES[0]);
        shooter.setMode(DcMotor.RunMode.RUN_WITHOUT_ENCODER);
        shooter.setZeroPowerBehavior(DcMotor.ZeroPowerBehavior.FLOAT);
        for (String n : FEEDER_NAMES) {
            if (hardwareMap.crservo.contains(n)) {
                feederCr = hardwareMap.get(CRServo.class, n);
                if (n.equals("Windmill Feeder")) feederCr.setDirection(DcMotorSimple.Direction.REVERSE); // controller-profile "windmill": -1
                break;
            }
            if (hardwareMap.servo.contains(n)) { feederPos = hardwareMap.get(Servo.class, n); break; }
        }
        if (feederCr == null && feederPos == null) feederCr = hardwareMap.get(CRServo.class, FEEDER_NAMES[0]);
        for (Object[] h : FEED_HELPERS) {
            String n = (String) h[0]; double p = (Double) h[1];
            if (hardwareMap.crservo.contains(n)) { helpers.add(hardwareMap.get(CRServo.class, n)); helperPowers.add(p); }
            else if (hardwareMap.dcMotor.contains(n)) { helperMotors.add(hardwareMap.get(DcMotor.class, n)); helperMotorPowers.add(p); }
        }
        for (VoltageSensor v : hardwareMap.voltageSensor) { battery = v; break; }
        stopAll();
        telemetry.addLine("Twin shooter calibration ready");
        telemetry.addLine("Park square to a wall, shooter facing it. X spins the flywheel, A fires one ball.");
        telemetry.update();
    }

    @Override public void loop() {
        // ---- buttons (rising edges)
        boolean up = gamepad1.dpad_up, down = gamepad1.dpad_down, left = gamepad1.dpad_left, right = gamepad1.dpad_right;
        if (right && !lastRight) { powerIndex = Math.min(POWERS.length - 1, powerIndex + 1); power = POWERS[powerIndex]; }
        if (left && !lastLeft) { powerIndex = Math.max(0, powerIndex - 1); power = POWERS[powerIndex]; }
        if (up && !lastUp) power = Math.min(1, Math.round((power + 0.05) * 100) / 100.0);
        if (down && !lastDown) power = Math.max(0.05, Math.round((power - 0.05) * 100) / 100.0);
        if (gamepad1.x && !lastX && phase == Phase.IDLE) spinning = !spinning;
        if (gamepad1.y && !lastY) { phase = Phase.IDLE; spinning = false; stopAll(); }
        if (gamepad1.b && !lastB && shots > 0) { RobotLog.ii("TwinCal", "CAL discard shot=%d", shots); lastShot = "shot " + shots + " discarded (mis-feed)"; }
        if (gamepad1.a && !lastA && phase == Phase.IDLE) { spinning = true; phase = Phase.SPINUP; phaseStart = getRuntime(); settleStart = -1; }
        lastA = gamepad1.a; lastB = gamepad1.b; lastX = gamepad1.x; lastY = gamepad1.y; lastUp = up; lastDown = down; lastLeft = left; lastRight = right;

        // ---- flywheel
        shooter.setPower(spinning ? power : 0);
        double rpm = Math.abs(shooter.getVelocity()) / SHOOTER_TICKS_PER_REV * 60.0;
        rpmAvg += (rpm - rpmAvg) * 0.2;

        // ---- fire sequence
        double now = getRuntime();
        if (phase == Phase.SPINUP) {
            boolean steady = rpmAvg > 100 && Math.abs(rpm - rpmAvg) < SETTLE_TOL * rpmAvg;
            if (steady && settleStart < 0) settleStart = now;
            if (!steady) settleStart = -1;
            if ((settleStart >= 0 && now - settleStart >= SETTLE_SECONDS) || now - phaseStart >= SPINUP_MAX_SECONDS) {
                rpmAtSettle = rpmAvg;
                shots++;
                double volts = battery != null ? battery.getVoltage() : Double.NaN;
                String line = Double.isNaN(volts)
                    ? String.format(Locale.US, "CAL shot=%d power=%.2f rpm=%.0f", shots, power, rpmAtSettle)
                    : String.format(Locale.US, "CAL shot=%d power=%.2f rpm=%.0f volts=%.1f", shots, power, rpmAtSettle, volts);
                RobotLog.ii("TwinCal", "%s", line);
                lastShot = line;
                phase = Phase.FEED; phaseStart = now;
                feed(true);
            }
        } else if (phase == Phase.FEED) {
            if (now - phaseStart >= (feederPos != null ? 0.3 : FEED_SECONDS)) { feed(false); phase = Phase.IDLE; }
        }

        // ---- telemetry
        telemetry.addData("Power", "%.2f  (dpad L/R: %s, dpad U/D: ±0.05)", power, scheduleText());
        telemetry.addData("Flywheel", "%s  %.0f RPM", spinning ? "ON" : "off", rpm);
        telemetry.addData("Phase", phase == Phase.IDLE ? "idle — A fires one ball, X toggles the wheel, Y stops" : phase == Phase.SPINUP ? "spinning up, waiting for a steady wheel…" : "feeding…");
        telemetry.addData("Shots", "%d   last: %s", shots, lastShot);
        if (battery != null) telemetry.addData("Battery", "%.1f V", battery.getVoltage());
        telemetry.addLine("Write down: shot number, where the ball hit (height on the wall, or floor distance if short).");
        telemetry.addLine("Then in the twin: Launcher ▸ Shooter calibration ▸ enter the measurement for that shot.");
        telemetry.update();
    }

    private String scheduleText() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < POWERS.length; i++) { if (i > 0) sb.append(' '); sb.append(i == powerIndex ? "[" : "").append(String.format(Locale.US, "%.2f", POWERS[i])).append(i == powerIndex ? "]" : ""); }
        return sb.toString();
    }

    private void feed(boolean on) {
        if (feederCr != null) feederCr.setPower(on ? FEEDER_POWER : 0);
        if (feederPos != null) feederPos.setPosition(on ? 1 : 0);
        for (int i = 0; i < helpers.size(); i++) helpers.get(i).setPower(on ? helperPowers.get(i) : 0);
        for (int i = 0; i < helperMotors.size(); i++) helperMotors.get(i).setPower(on ? helperMotorPowers.get(i) : 0);
    }

    private void stopAll() {
        shooter.setPower(0);
        feed(false);
    }

    @Override public void stop() { spinning = false; stopAll(); }
}
