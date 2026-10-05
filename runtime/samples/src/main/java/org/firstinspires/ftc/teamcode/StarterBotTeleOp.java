package org.firstinspires.ftc.teamcode;

import com.qualcomm.robotcore.eventloop.opmode.OpMode;
import com.qualcomm.robotcore.eventloop.opmode.TeleOp;
import com.qualcomm.robotcore.hardware.DcMotor;
import com.qualcomm.robotcore.hardware.DcMotorEx;
import com.qualcomm.robotcore.hardware.IMU;
import com.qualcomm.robotcore.hardware.Servo;
import com.qualcomm.hardware.rev.RevHubOrientationOnRobot;
import org.firstinspires.ftc.robotcore.external.hardware.camera.WebcamName;
import org.firstinspires.ftc.robotcore.external.navigation.AngleUnit;
import org.firstinspires.ftc.vision.VisionPortal;
import org.firstinspires.ftc.vision.apriltag.AprilTagDetection;
import org.firstinspires.ftc.vision.apriltag.AprilTagProcessor;

/**
 * Sample mecanum TeleOp for the goBILDA StarterBot in the simulator.
 * Left stick drives (intake forward), right stick turns, right trigger spins the flywheel, A fires the feeder,
 * bumpers nudge the hood. The shooter and its camera face backward over the ramp, so back up toward the hive to score.
 * Hardware names match the sim's default hardware map.
 */
@TeleOp(name = "Sim: StarterBot TeleOp", group = "Sim")
public class StarterBotTeleOp extends OpMode {
    private DcMotorEx fl, fr, bl, br, shooter;
    private DcMotor intake;
    private Servo feeder, hood;
    private IMU imu;
    private AprilTagProcessor tags;
    private VisionPortal portal;
    private double hoodPos = 0.5;
    private boolean lastA = false;
    private double feederTimer = 0;
    private static final double SHOOTER_TICKS_PER_REV = 28; // bare 5203 1:1 encoder

    @Override public void init() {
        fl = hardwareMap.get(DcMotorEx.class, "frontLeft");
        fr = hardwareMap.get(DcMotorEx.class, "frontRight");
        bl = hardwareMap.get(DcMotorEx.class, "backLeft");
        br = hardwareMap.get(DcMotorEx.class, "backRight");
        shooter = hardwareMap.get(DcMotorEx.class, "shooter");
        intake = hardwareMap.get(DcMotor.class, "intake");
        feeder = hardwareMap.get(Servo.class, "feeder");
        hood = hardwareMap.get(Servo.class, "hood");
        imu = hardwareMap.get(IMU.class, "imu");
        imu.initialize(new IMU.Parameters(new RevHubOrientationOnRobot(RevHubOrientationOnRobot.LogoFacingDirection.UP, RevHubOrientationOnRobot.UsbFacingDirection.FORWARD)));
        fl.setDirection(DcMotor.Direction.REVERSE);
        bl.setDirection(DcMotor.Direction.REVERSE);
        for (DcMotorEx m : new DcMotorEx[] { fl, fr, bl, br }) m.setZeroPowerBehavior(DcMotor.ZeroPowerBehavior.BRAKE);
        tags = new AprilTagProcessor.Builder().build();
        portal = new VisionPortal.Builder().setCamera(hardwareMap.get(WebcamName.class, "Webcam 1")).addProcessor(tags).build();
        feeder.setPosition(0);
        hood.setPosition(hoodPos);
        telemetry.addLine("StarterBot TeleOp ready");
    }

    @Override public void loop() {
        double y = -gamepad1.left_stick_y, x = gamepad1.left_stick_x, rx = gamepad1.right_stick_x;
        double denom = Math.max(Math.abs(y) + Math.abs(x) + Math.abs(rx), 1);
        fl.setPower((y + x + rx) / denom);
        bl.setPower((y - x + rx) / denom);
        fr.setPower((y - x - rx) / denom);
        br.setPower((y + x - rx) / denom);

        double targetRpm = gamepad1.right_trigger * 6000;
        shooter.setVelocity(targetRpm / 60.0 * SHOOTER_TICKS_PER_REV);
        intake.setPower(gamepad1.left_trigger);

        if (gamepad1.left_bumper) hoodPos = Math.max(0, hoodPos - 0.01);
        if (gamepad1.right_bumper) hoodPos = Math.min(1, hoodPos + 0.01);
        hood.setPosition(hoodPos);

        if (gamepad1.a && !lastA) { feeder.setPosition(1); feederTimer = getRuntime(); }
        if (getRuntime() - feederTimer > 0.25) feeder.setPosition(0);
        lastA = gamepad1.a;

        telemetry.addData("heading", "%.1f deg", imu.getRobotYawPitchRollAngles().getYaw(AngleUnit.DEGREES));
        telemetry.addData("shooter", "%.0f rpm (target %.0f)", shooter.getVelocity() / SHOOTER_TICKS_PER_REV * 60.0, targetRpm);
        telemetry.addData("hood", "%.2f", hoodPos);
        telemetry.addData("encoders", "%d %d %d %d", fl.getCurrentPosition(), fr.getCurrentPosition(), bl.getCurrentPosition(), br.getCurrentPosition());
        for (AprilTagDetection d : tags.getDetections()) {
            telemetry.addLine(String.format("tag %d  range %.1f in  bearing %.1f  elev %.1f", d.id, d.ftcPose.range, d.ftcPose.bearing, d.ftcPose.elevation));
        }
        telemetry.update();
    }

    @Override public void stop() { if (portal != null) portal.close(); }
}
