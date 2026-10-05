package org.firstinspires.ftc.vision.apriltag;

import org.firstinspires.ftc.robotcore.external.hardware.camera.CameraName;
import org.firstinspires.ftc.robotcore.external.navigation.AngleUnit;
import org.firstinspires.ftc.robotcore.external.navigation.DistanceUnit;
import org.firstinspires.ftc.robotcore.external.navigation.Position;
import org.firstinspires.ftc.robotcore.external.navigation.Pose3D;
import org.firstinspires.ftc.robotcore.external.navigation.YawPitchRollAngles;
import org.firstinspires.ftc.vision.VisionProcessor;
import org.biobuzz.sim.shim.SimHooks;
import java.util.ArrayList;
import java.util.List;

/** Detections come from the simulator's camera analysis via SimHooks, not from image processing. */
public class AprilTagProcessor implements VisionProcessor {
    public enum TagFamily { TAG_36h11, TAG_25h9, TAG_16h5, TAG_standard41h12 }
    public enum PoseSolver { APRILTAG_BUILTIN, OPENCV_ITERATIVE, OPENCV_SOLVEPNP_EPNP, OPENCV_IPPE, OPENCV_IPPE_SQUARE, OPENCV_SQPNP }
    public static final int THREADS_DEFAULT = 3;

    private final DistanceUnit distanceUnit; private final AngleUnit angleUnit; private final AprilTagLibrary library;
    private volatile CameraName camera; private volatile boolean enabled = true; private long lastFreshNanos = -1;

    AprilTagProcessor(DistanceUnit du, AngleUnit au, AprilTagLibrary lib) { distanceUnit = du; angleUnit = au; library = lib; }

    public static AprilTagProcessor easyCreateWithDefaults() { return new Builder().build(); }

    public void internalAttach(CameraName c) { camera = c; }
    public void internalSetEnabled(boolean on) { enabled = on; }

    /** All tags currently detected (fresh every call, like a running camera). */
    public ArrayList<AprilTagDetection> getDetections() {
        ArrayList<AprilTagDetection> out = new ArrayList<>();
        if (!enabled) return out;
        String camName = camera == null ? null : camera.getDeviceName();
        List<SimHooks.TagObservation> obs = SimHooks.tags(camName);
        long now = System.nanoTime();
        for (SimHooks.TagObservation o : obs) {
            AprilTagDetection d = new AprilTagDetection();
            d.id = o.id; d.hamming = 0; d.decisionMargin = 80f;
            d.center = new AprilTagDetection.Point(o.cx, o.cy);
            d.metadata = library.lookupTag(o.id);
            double k = distanceUnit.fromInches(1);
            double a = angleUnit.fromDegrees(1);
            d.ftcPose = new AprilTagPoseFtc(o.x * k, o.y * k, o.z * k, o.yaw * a, o.pitch * a, o.roll * a, o.range * k, o.bearing * a, o.elevation * a);
            d.rawPose = new AprilTagPoseRaw(); d.rawPose.x = o.x * k; d.rawPose.y = o.y * k; d.rawPose.z = o.z * k;
            d.robotPose = new Pose3D(new Position(distanceUnit, o.robotX * k, o.robotY * k, 0, now), new YawPitchRollAngles(angleUnit, o.robotYaw * a, 0, 0, now));
            d.frameAcquisitionNanoTime = o.nanos;
            out.add(d);
        }
        lastFreshNanos = SimHooks.lastSensorNanos();
        return out;
    }
    /** Returns null when no new frame has arrived since the last call. */
    public ArrayList<AprilTagDetection> getFreshDetections() {
        long n = SimHooks.lastSensorNanos();
        if (n == lastFreshNanos) return null;
        return getDetections();
    }
    public int getPerTagAvgPoseSolveTime() { return 1; }
    public void setDecimation(float d) {}
    public void setPoseSolver(PoseSolver s) {}
    public AprilTagLibrary getTagLibrary() { return library; }

    public static class Builder {
        private DistanceUnit du = DistanceUnit.INCH; private AngleUnit au = AngleUnit.DEGREES; private AprilTagLibrary lib = AprilTagGameDatabase.getCurrentGameTagLibrary();
        public Builder setTagLibrary(AprilTagLibrary l) { lib = l; return this; }
        public Builder setTagFamily(TagFamily f) { return this; }
        public Builder setOutputUnits(DistanceUnit d, AngleUnit a) { du = d; au = a; return this; }
        public Builder setLensIntrinsics(double fx, double fy, double cx, double cy) { return this; }
        public Builder setSuppressCalibrationWarnings(boolean b) { return this; }
        public Builder setCameraPose(Position p, YawPitchRollAngles o) { return this; }
        public Builder setDrawAxes(boolean b) { return this; }
        public Builder setDrawCubeProjection(boolean b) { return this; }
        public Builder setDrawTagOutline(boolean b) { return this; }
        public Builder setDrawTagID(boolean b) { return this; }
        public Builder setNumThreads(int n) { return this; }
        public AprilTagProcessor build() { return new AprilTagProcessor(du, au, lib); }
    }
}
