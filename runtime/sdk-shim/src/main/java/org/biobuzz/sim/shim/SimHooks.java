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
        /** optional exact tag->camera rotation, row-major 3x3 in OpenCV camera axes */
        public double[] R;
    }
    public interface TagSource { List<TagObservation> tags(String cameraName); long lastSensorNanos(); }

    /** Called when TeamCode asks the HardwareMap for a device that is not configured. */
    public interface MissingDeviceListener { /** return a device to register under that name, or null */ com.qualcomm.robotcore.hardware.HardwareDevice missing(String name, String requestedType); }
    private static volatile MissingDeviceListener missingListener;
    public static void setMissingDeviceListener(MissingDeviceListener l) { missingListener = l; }
    public static com.qualcomm.robotcore.hardware.HardwareDevice reportMissing(String name, String type) { MissingDeviceListener l = missingListener; return l == null ? null : l.missing(name, type); }

    /** TeamCode asset overrides edited in the browser: asset path -> JSONObject of dotted key -> value. Applied by AssetManager. */
    private static final java.util.concurrent.ConcurrentHashMap<String, org.json.JSONObject> assetOverrides = new java.util.concurrent.ConcurrentHashMap<>();
    public static void setAssetOverrides(java.util.Map<String, org.json.JSONObject> all) { assetOverrides.clear(); assetOverrides.putAll(all); }
    public static org.json.JSONObject assetOverrides(String path) { return assetOverrides.get(path); }

    private static volatile TagSource tagSource;
    public static void setTagSource(TagSource s) { tagSource = s; }
    public static List<TagObservation> tags(String cameraName) { TagSource s = tagSource; return s == null ? Collections.emptyList() : s.tags(cameraName); }
    public static long lastSensorNanos() { TagSource s = tagSource; return s == null ? 0 : s.lastSensorNanos(); }
}
