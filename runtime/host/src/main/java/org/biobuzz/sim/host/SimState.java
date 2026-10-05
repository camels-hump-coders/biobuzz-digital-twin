package org.biobuzz.sim.host;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.biobuzz.sim.shim.SimHooks;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/** Latest sensor snapshot from the browser and the actuator commands to send back. Thread-safe via volatile swaps. */
public class SimState implements SimHooks.TagSource {
    public static class MotorSensor { public double position, velocity; }
    public static class Snapshot {
        public long nanos = System.nanoTime();
        public Map<String, MotorSensor> motors = new HashMap<>();
        public double imuYawDeg, imuPitchDeg, imuRollDeg, imuYawRateDps;
        public Map<String, Double> distancesIn = new HashMap<>();
        public Map<String, List<SimHooks.TagObservation>> tags = new HashMap<>();
        public JsonObject gamepad1, gamepad2;
        public double batteryVolts = 12.6;
    }
    private volatile Snapshot snapshot = new Snapshot();
    /** actuator commands keyed by device name; written by device shims, read by the link */
    public final Map<String, JsonObject> actuators = new ConcurrentHashMap<>();

    public Snapshot snapshot() { return snapshot; }

    public void ingest(JsonObject msg) {
        Snapshot s = new Snapshot();
        if (msg.has("motors")) for (Map.Entry<String, JsonElement> e : msg.getAsJsonObject("motors").entrySet()) {
            MotorSensor m = new MotorSensor();
            JsonObject o = e.getValue().getAsJsonObject();
            m.position = o.get("pos").getAsDouble(); m.velocity = o.get("vel").getAsDouble();
            s.motors.put(e.getKey(), m);
        }
        if (msg.has("imu")) { JsonObject i = msg.getAsJsonObject("imu"); s.imuYawDeg = i.get("yaw").getAsDouble(); s.imuPitchDeg = i.get("pitch").getAsDouble(); s.imuRollDeg = i.get("roll").getAsDouble(); s.imuYawRateDps = i.has("yawRate") ? i.get("yawRate").getAsDouble() : 0; }
        if (msg.has("distances")) for (Map.Entry<String, JsonElement> e : msg.getAsJsonObject("distances").entrySet()) s.distancesIn.put(e.getKey(), e.getValue().getAsDouble());
        if (msg.has("tags")) for (Map.Entry<String, JsonElement> e : msg.getAsJsonObject("tags").entrySet()) {
            List<SimHooks.TagObservation> list = new ArrayList<>();
            for (JsonElement t : e.getValue().getAsJsonArray()) {
                JsonObject o = t.getAsJsonObject();
                SimHooks.TagObservation ob = new SimHooks.TagObservation();
                ob.id = o.get("id").getAsInt(); ob.cx = o.get("cx").getAsDouble(); ob.cy = o.get("cy").getAsDouble();
                ob.x = o.get("x").getAsDouble(); ob.y = o.get("y").getAsDouble(); ob.z = o.get("z").getAsDouble();
                ob.yaw = o.get("yaw").getAsDouble(); ob.pitch = o.get("pitch").getAsDouble(); ob.roll = o.get("roll").getAsDouble();
                ob.range = o.get("range").getAsDouble(); ob.bearing = o.get("bearing").getAsDouble(); ob.elevation = o.get("elevation").getAsDouble();
                ob.robotX = o.get("robotX").getAsDouble(); ob.robotY = o.get("robotY").getAsDouble(); ob.robotYaw = o.get("robotYaw").getAsDouble();
                ob.nanos = s.nanos;
                list.add(ob);
            }
            s.tags.put(e.getKey(), list);
        }
        if (msg.has("gamepad1")) s.gamepad1 = msg.getAsJsonObject("gamepad1");
        if (msg.has("gamepad2")) s.gamepad2 = msg.getAsJsonObject("gamepad2");
        if (msg.has("battery")) s.batteryVolts = msg.get("battery").getAsDouble();
        snapshot = s;
    }

    @Override public List<SimHooks.TagObservation> tags(String cameraName) {
        Snapshot s = snapshot;
        if (cameraName != null && s.tags.containsKey(cameraName)) return s.tags.get(cameraName);
        // unnamed / unknown camera: union of all
        List<SimHooks.TagObservation> all = new ArrayList<>();
        for (List<SimHooks.TagObservation> l : s.tags.values()) all.addAll(l);
        return all;
    }
    @Override public long lastSensorNanos() { return snapshot.nanos; }

    public JsonObject actuatorMessage() {
        JsonObject m = new JsonObject();
        m.addProperty("type", "actuators");
        JsonObject devs = new JsonObject();
        for (Map.Entry<String, JsonObject> e : actuators.entrySet()) devs.add(e.getKey(), e.getValue());
        m.add("devices", devs);
        return m;
    }
}
