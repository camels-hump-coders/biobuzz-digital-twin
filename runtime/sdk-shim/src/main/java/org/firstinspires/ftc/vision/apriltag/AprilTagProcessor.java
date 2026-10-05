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
    private final boolean emitSingles;
    private volatile CameraName camera; private volatile boolean enabled = true; private long lastFreshNanos = -1;

    AprilTagProcessor(DistanceUnit du, AngleUnit au, AprilTagLibrary lib, boolean emitSingles) { distanceUnit = du; angleUnit = au; library = lib; this.emitSingles = emitSingles; }

    public static AprilTagProcessor easyCreateWithDefaults() { return new Builder().build(); }

    /** Tag-to-camera rotation (OpenCV camera axes) from FTC yaw (about vertical), pitch (about horizontal), roll. */
    static org.firstinspires.ftc.robotcore.external.matrices.MatrixF rotationFor(double yaw, double pitch, double roll) {
        double cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
        // R = Ry(yaw) * Rx(pitch) * Rz(roll) in a frame with y down: a tag facing the camera squarely gives the identity
        double[][] ry = {{cy, 0, sy}, {0, 1, 0}, {-sy, 0, cy}};
        double[][] rx = {{1, 0, 0}, {0, cp, -sp}, {0, sp, cp}};
        double[][] rz = {{cr, -sr, 0}, {sr, cr, 0}, {0, 0, 1}};
        double[][] m = mul(mul(ry, rx), rz);
        org.firstinspires.ftc.robotcore.external.matrices.MatrixF out = new org.firstinspires.ftc.robotcore.external.matrices.MatrixF(3, 3);
        for (int r = 0; r < 3; r++) for (int c = 0; c < 3; c++) out.put(r, c, (float) m[r][c]);
        return out;
    }
    private static double[][] mul(double[][] a, double[][] b) { double[][] m = new double[3][3]; for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) for (int k = 0; k < 3; k++) m[i][j] += a[i][k] * b[k][j]; return m; }

    public void internalAttach(CameraName c) { camera = c; }
    public void internalSetEnabled(boolean on) { enabled = on; }

    /** All tags currently detected (fresh every call, like a running camera). */
    public ArrayList<AprilTagDetection> getDetections() {
        ArrayList<AprilTagDetection> out = new ArrayList<>();
        if (!enabled) return out;
        String camName = camera == null ? null : camera.getDeviceName();
        List<SimHooks.TagObservation> obs = SimHooks.tags(camName);
        long now = System.nanoTime();
        List<AprilTagSingleDetection> singles = new ArrayList<>();
        for (SimHooks.TagObservation o : obs) {
            AprilTagSingleDetection d = new AprilTagSingleDetection();
            d.id = o.id; d.hamming = 0; d.decisionMargin = 80f;
            d.center = new AprilTagDetection.Point(o.cx, o.cy);
            d.metadata = library.lookupTag(o.id);
            double k = distanceUnit.fromInches(1);
            double a = angleUnit.fromDegrees(1);
            d.ftcPose = new AprilTagPoseFtc(o.x * k, o.y * k, o.z * k, o.yaw * a, o.pitch * a, o.roll * a, o.range * k, o.bearing * a, o.elevation * a);
            // raw pose: OpenCV camera frame (x right, y down, z forward) in the chosen distance unit, with the tag's
            // rotation built from the reported yaw/pitch so height/tilt maths downstream gets a sensible matrix
            d.rawPose = new AprilTagPoseRaw(); d.rawPose.x = o.x * k; d.rawPose.y = -o.z * k; d.rawPose.z = o.y * k;
            if (o.R != null) { d.rawPose.R = new org.firstinspires.ftc.robotcore.external.matrices.MatrixF(3, 3); for (int r = 0; r < 3; r++) for (int c = 0; c < 3; c++) d.rawPose.R.put(r, c, (float) o.R[r * 3 + c]); }
            else d.rawPose.R = rotationFor(Math.toRadians(o.yaw), Math.toRadians(o.pitch), Math.toRadians(o.roll));
            d.robotPose = new Pose3D(new Position(distanceUnit, o.robotX * k, o.robotY * k, 0, now), new YawPitchRollAngles(angleUnit, o.robotYaw * a, 0, 0, now));
            d.frameAcquisitionNanoTime = o.nanos;
            singles.add(d);
        }
        // Group into the season's clusters (SDK 12 behaviour): one detection per cluster, pose = mean of its tags
        java.util.Map<String, AprilTagClusterDetection> clusters = new java.util.LinkedHashMap<>();
        for (AprilTagSingleDetection s : singles) {
            AprilTagClusterMetadata cm = AprilTagGameDatabase.clusterFor(s.id);
            if (cm == null || emitSingles) { out.add(s); continue; }
            AprilTagClusterDetection c = clusters.get(cm.name);
            if (c == null) { c = new AprilTagClusterDetection(); c.metadata = cm; c.frameAcquisitionNanoTime = s.frameAcquisitionNanoTime; c.ftcPose = new AprilTagPoseFtc(); c.robotPose = s.robotPose; clusters.put(cm.name, c); out.add(c); }
            c.tagsDetected.add(s);
        }
        for (AprilTagClusterDetection c : clusters.values()) {
            int n = c.tagsDetected.size();
            AprilTagPoseFtc p = c.ftcPose;
            for (AprilTagSingleDetection s : c.tagsDetected) { p.x += s.ftcPose.x / n; p.y += s.ftcPose.y / n; p.z += s.ftcPose.z / n; p.yaw += s.ftcPose.yaw / n; p.pitch += s.ftcPose.pitch / n; p.roll += s.ftcPose.roll / n; c.center.x += s.center.x / n; c.center.y += s.center.y / n; }
            p.range = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
            double xm = distanceUnit.toMeters(p.x), ym = distanceUnit.toMeters(p.y), zm = distanceUnit.toMeters(p.z);
            p.bearing = angleUnit.fromDegrees(Math.toDegrees(Math.atan2(-xm, ym)));
            p.elevation = angleUnit.fromDegrees(Math.toDegrees(Math.atan2(zm, Math.hypot(xm, ym))));
            c.percentClusterFound = (int) Math.round(100.0 * n / Math.max(1, c.metadata.tagIds.length));
            c.rawPose = c.tagsDetected.get(0).rawPose; // representative
            c.rawPose = new AprilTagPoseRaw(); c.rawPose.x = distanceUnit.fromMeters(xm); c.rawPose.y = -distanceUnit.fromMeters(zm); c.rawPose.z = distanceUnit.fromMeters(ym); c.rawPose.R = c.tagsDetected.get(0).rawPose.R;
            c.id = c.metadata.tagIds[0];
        }
        return out;
    }
    /** Returns null when no new frame has arrived since the last call. */
    public ArrayList<AprilTagDetection> getFreshDetections() {
        long n = SimHooks.lastSensorNanos();
        if (n == lastFreshNanos) return null; // no new sensor frame since the last *fresh* read (getDetections() does not consume frames)
        lastFreshNanos = n;
        return getDetections();
    }
    public int getPerTagAvgPoseSolveTime() { return 1; }
    public void setDecimation(float d) {}
    public void setPoseSolver(PoseSolver s) {}
    public AprilTagLibrary getTagLibrary() { return library; }

    public static class Builder {
        private DistanceUnit du = DistanceUnit.INCH; private AngleUnit au = AngleUnit.DEGREES; private AprilTagLibrary lib = AprilTagGameDatabase.getCurrentGameTagLibrary();
        private boolean emitSingles = false;
        /** Sim-only: report every tag as an AprilTagSingleDetection (pre-SDK-12 style) instead of clusters. */
        public Builder setEmitSingleDetections(boolean b) { emitSingles = b; return this; }
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
        public AprilTagProcessor build() { return new AprilTagProcessor(du, au, lib, emitSingles); }
    }
}
