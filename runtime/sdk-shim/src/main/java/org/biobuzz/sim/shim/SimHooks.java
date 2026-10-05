package org.biobuzz.sim.shim;

import java.util.Collections;
import java.util.List;

/** Static seam the host fills in; shim classes read sensor data through here. Not part of the FTC SDK. */
public final class SimHooks {
    private SimHooks() {}

    public static class TagObservation {
        public int id; public double cx, cy;
        /** inches, camera frame: x right, y forward, z up */
        public double x, y, z; public double yaw, pitch, roll; public double range, bearing, elevation;
        /** robot pose on the field (inches, degrees) implied by this tag */
        public double robotX, robotY, robotYaw; public long nanos;
    }
    public interface TagSource { List<TagObservation> tags(String cameraName); long lastSensorNanos(); }

    private static volatile TagSource tagSource;
    public static void setTagSource(TagSource s) { tagSource = s; }
    public static List<TagObservation> tags(String cameraName) { TagSource s = tagSource; return s == null ? Collections.emptyList() : s.tags(cameraName); }
    public static long lastSensorNanos() { TagSource s = tagSource; return s == null ? 0 : s.lastSensorNanos(); }
}
