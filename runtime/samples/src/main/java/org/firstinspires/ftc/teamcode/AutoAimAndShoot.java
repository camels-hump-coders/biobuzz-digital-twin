package org.firstinspires.ftc.teamcode;

import com.qualcomm.robotcore.eventloop.opmode.Autonomous;
import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;
import com.qualcomm.robotcore.hardware.DcMotor;
import com.qualcomm.robotcore.hardware.DcMotorEx;
import com.qualcomm.robotcore.hardware.Servo;
import com.qualcomm.robotcore.util.ElapsedTime;
import org.firstinspires.ftc.robotcore.external.hardware.camera.WebcamName;
import org.firstinspires.ftc.vision.VisionPortal;
import org.firstinspires.ftc.vision.apriltag.AprilTagDetection;
import org.firstinspires.ftc.vision.apriltag.AprilTagProcessor;

/**
 * Sample autonomous: rotate until a red hive tag (30-37) is centred, spin the flywheel to a
 * range-based RPM, then fire three POLLEN. Exercises LinearOpMode, encoders-free turning, AprilTag
 * bearing, DcMotorEx.setVelocity and servo timing.
 */
@Autonomous(name = "Sim: Auto aim and shoot", group = "Sim")
public class AutoAimAndShoot extends LinearOpMode {
    private static final double SHOOTER_TICKS_PER_REV = 28;

    @Override public void runOpMode() throws InterruptedException {
        DcMotorEx fl = hardwareMap.get(DcMotorEx.class, "frontLeft");
        DcMotorEx fr = hardwareMap.get(DcMotorEx.class, "frontRight");
        DcMotorEx bl = hardwareMap.get(DcMotorEx.class, "backLeft");
        DcMotorEx br = hardwareMap.get(DcMotorEx.class, "backRight");
        DcMotorEx shooter = hardwareMap.get(DcMotorEx.class, "shooter");
        Servo feeder = hardwareMap.get(Servo.class, "feeder");
        fl.setDirection(DcMotor.Direction.REVERSE);
        bl.setDirection(DcMotor.Direction.REVERSE);
        AprilTagProcessor tags = new AprilTagProcessor.Builder().build();
        VisionPortal portal = new VisionPortal.Builder().setCamera(hardwareMap.get(WebcamName.class, "Webcam 1")).addProcessor(tags).build();

        telemetry.addLine("Looking for red hive tags 30-37");
        telemetry.update();
        waitForStart();

        ElapsedTime t = new ElapsedTime();
        AprilTagDetection target = null;
        // 1) search: rotate slowly until a target tag is in view, then servo its bearing to zero
        while (opModeIsActive() && t.seconds() < 12) {
            target = null;
            for (AprilTagDetection d : tags.getDetections()) if (d.id >= 30 && d.id <= 37 && (target == null || Math.abs(d.ftcPose.bearing) < Math.abs(target.ftcPose.bearing))) target = d;
            double turn;
            if (target == null) turn = -0.25; else turn = Math.max(-0.35, Math.min(0.35, target.ftcPose.bearing * 0.02));
            if (target != null && Math.abs(target.ftcPose.bearing) < 1.0) break;
            // Positive bearing = tag to the camera's left. The StarterBot's shooter camera faces BACKWARD (over the
            // ramp), so the camera's left is the robot's right: rotate clockwise (left wheels forward) to centre it.
            fl.setPower(turn); bl.setPower(turn); fr.setPower(-turn); br.setPower(-turn);
            telemetry.addData("state", target == null ? "searching" : "aligning");
            if (target != null) telemetry.addData("bearing", "%.1f deg  range %.1f in", target.ftcPose.bearing, target.ftcPose.range);
            telemetry.update();
            sleep(20);
        }
        fl.setPower(0); fr.setPower(0); bl.setPower(0); br.setPower(0);
        if (target == null) { telemetry.addLine("no tag found"); telemetry.update(); return; }

        // 2) spin up: StarterBot fixed 55 deg hood, 96 mm wheel, efficiency ~0.45 -> rough RPM from range
        double rangeIn = target.ftcPose.range;
        double rpm = 1800 + 18 * rangeIn;
        shooter.setVelocity(rpm / 60.0 * SHOOTER_TICKS_PER_REV);
        ElapsedTime spin = new ElapsedTime();
        while (opModeIsActive() && spin.seconds() < 1.5) {
            telemetry.addData("state", "spinning up");
            telemetry.addData("shooter", "%.0f / %.0f rpm", shooter.getVelocity() / SHOOTER_TICKS_PER_REV * 60.0, rpm);
            telemetry.update();
            sleep(20);
        }
        // 3) fire three
        for (int i = 0; i < 3 && opModeIsActive(); i++) {
            feeder.setPosition(1); sleep(250);
            feeder.setPosition(0); sleep(600);
            telemetry.addData("state", "fired %d", i + 1); telemetry.update();
        }
        shooter.setVelocity(0);
        portal.close();
        telemetry.addLine("done"); telemetry.update();
        sleep(1000);
    }
}
