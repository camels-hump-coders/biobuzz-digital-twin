package com.qualcomm.robotcore.hardware;

import java.util.*;

/** Name -> device registry populated by the host from the browser's hardware map. */
public class HardwareMap implements Iterable<HardwareDevice> {
    public class DeviceMapping<T extends HardwareDevice> implements Iterable<T> {
        private final Map<String, T> map = new LinkedHashMap<>();
        private final Class<T> type;
        public DeviceMapping(Class<T> type) { this.type = type; }
        public T get(String name) {
            T d = map.get(name);
            if (d == null) throw new IllegalArgumentException("Unable to find a hardware device with name \"" + name + "\" and type " + type.getSimpleName());
            return d;
        }
        public void put(String name, T device) { map.put(name, device); allDevices.put(name, device); }
        public boolean contains(String name) { return map.containsKey(name); }
        public int size() { return map.size(); }
        public Set<Map.Entry<String, T>> entrySet() { return map.entrySet(); }
        @Override public Iterator<T> iterator() { return map.values().iterator(); }
    }

    private final Map<String, HardwareDevice> allDevices = new LinkedHashMap<>();
    public final DeviceMapping<DcMotor> dcMotor = new DeviceMapping<>(DcMotor.class);
    public final DeviceMapping<Servo> servo = new DeviceMapping<>(Servo.class);
    public final DeviceMapping<CRServo> crservo = new DeviceMapping<>(CRServo.class);
    public final DeviceMapping<VoltageSensor> voltageSensor = new DeviceMapping<>(VoltageSensor.class);
    public final DeviceMapping<TouchSensor> touchSensor = new DeviceMapping<>(TouchSensor.class);
    /** Android Context on the robot; a desktop stand-in here (assets from TeamCode/src/main/assets, file-backed SharedPreferences). */
    public final android.content.Context appContext = new android.content.Context();

    public void register(String name, HardwareDevice device) {
        allDevices.put(name, device);
        if (device instanceof DcMotor) dcMotor.put(name, (DcMotor) device);
        if (device instanceof Servo) servo.put(name, (Servo) device);
        if (device instanceof CRServo) crservo.put(name, (CRServo) device);
        if (device instanceof VoltageSensor) voltageSensor.put(name, (VoltageSensor) device);
        if (device instanceof TouchSensor) touchSensor.put(name, (TouchSensor) device);
    }

    public <T> T get(Class<? extends T> classOrInterface, String deviceName) {
        T t = tryGet(classOrInterface, deviceName);
        if (t == null) throw new IllegalArgumentException("Unable to find a hardware device with name \"" + deviceName + "\" and type " + classOrInterface.getSimpleName());
        return t;
    }
    public <T> T tryGet(Class<? extends T> classOrInterface, String deviceName) {
        HardwareDevice d = allDevices.get(deviceName.trim());
        if (d != null && classOrInterface.isInstance(d)) return classOrInterface.cast(d);
        return null;
    }
    public HardwareDevice get(String deviceName) { return allDevices.get(deviceName); }
    public <T> List<T> getAll(Class<? extends T> classOrInterface) {
        List<T> out = new ArrayList<>();
        for (HardwareDevice d : allDevices.values()) if (classOrInterface.isInstance(d)) out.add(classOrInterface.cast(d));
        return out;
    }
    public Set<String> getNamesOf(HardwareDevice device) {
        Set<String> s = new HashSet<>();
        for (Map.Entry<String, HardwareDevice> e : allDevices.entrySet()) if (e.getValue() == device) s.add(e.getKey());
        return s;
    }
    public int size() { return allDevices.size(); }
    @Override public Iterator<HardwareDevice> iterator() { return allDevices.values().iterator(); }
}
