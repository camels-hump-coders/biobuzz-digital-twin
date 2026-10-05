package org.firstinspires.ftc.vision.apriltag;
import org.firstinspires.ftc.robotcore.external.navigation.Pose3D;
public class AprilTagDetection {
    public int id; public int hamming; public float decisionMargin;
    public Point center = new Point(); public Point[] corners = { new Point(), new Point(), new Point(), new Point() };
    public AprilTagMetadata metadata; public AprilTagPoseFtc ftcPose; public AprilTagPoseRaw rawPose; public Pose3D robotPose; public long frameAcquisitionNanoTime;
    /** Minimal stand-in for org.opencv.core.Point. */
    public static class Point { public double x, y; public Point() {} public Point(double x, double y) { this.x = x; this.y = y; } @Override public String toString() { return "(" + x + ", " + y + ")"; } }
}
