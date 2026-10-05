package org.firstinspires.ftc.teamcode;

import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;
import com.qualcomm.robotcore.eventloop.opmode.TeleOp;
import org.firstinspires.ftc.robotcore.external.hardware.camera.WebcamName;
import org.firstinspires.ftc.vision.VisionPortal;
import org.firstinspires.ftc.vision.apriltag.AprilTagClusterDetection;
import org.firstinspires.ftc.vision.apriltag.AprilTagDetection;
import org.firstinspires.ftc.vision.apriltag.AprilTagProcessor;
import java.util.List;

/** Diagnostic: how often does getFreshDetections() deliver a frame, and what is in it? */
@TeleOp(name = "Sim: Fresh frame probe", group = "Sim")
public class FreshFrameProbe extends LinearOpMode {
    @Override public void runOpMode() throws InterruptedException {
        AprilTagProcessor tags = new AprilTagProcessor.Builder().build();
        VisionPortal portal = new VisionPortal.Builder().setCamera(hardwareMap.get(WebcamName.class, "Webcam 1")).addProcessor(tags).build();
        waitForStart();
        long frames = 0, loops = 0, t0 = System.nanoTime(); String last = "";
        while (opModeIsActive()) {
            loops++;
            List<AprilTagDetection> fresh = tags.getFreshDetections();
            if (fresh != null) {
                frames++;
                StringBuilder sb = new StringBuilder();
                for (AprilTagDetection d : fresh) sb.append(d instanceof AprilTagClusterDetection ? ((AprilTagClusterDetection) d).metadata.name + "(" + ((AprilTagClusterDetection) d).percentClusterFound + "%)" : "single " + d.id).append(d.ftcPose != null ? String.format(" b=%.1f r=%.1f age=%.3fs; ", d.ftcPose.bearing, d.ftcPose.range, (System.nanoTime() - d.frameAcquisitionNanoTime) / 1e9) : "; ");
                last = sb.toString();
            }
            double secs = (System.nanoTime() - t0) / 1e9;
            telemetry.addData("fresh frames/s", "%.1f (loops/s %.0f)", frames / Math.max(secs, 1e-3), loops / Math.max(secs, 1e-3));
            telemetry.addData("camera", portal.getCameraState());
            telemetry.addData("last fresh", last.isEmpty() ? "(none)" : last);
            telemetry.update();
            sleep(20);
        }
        portal.close();
    }
}
