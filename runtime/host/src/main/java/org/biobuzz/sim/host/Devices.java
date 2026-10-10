package org.biobuzz.sim.host;

import com.google.gson.JsonObject;
import com.qualcomm.robotcore.hardware.*;
import org.firstinspires.ftc.robotcore.external.hardware.camera.WebcamName;
import org.firstinspires.ftc.robotcore.external.navigation.*;

/** Device implementations backed by SimState. */
public final class Devices {
    private Devices() {}

    public static class SimMotor implements DcMotorEx {
        final String name; final SimState st; double ticksPerRev; int port;
        Direction dir = Direction.FORWARD; RunMode mode = RunMode.RUN_WITHOUT_ENCODER; ZeroPowerBehavior zpb = ZeroPowerBehavior.BRAKE;
        double power = 0, targetVel = 0; int targetPos = 0; int tolerance = 5; boolean enabled = true; double encoderOffset = 0;
        public SimMotor(String name, SimState st, double ticksPerRev, int port) { this.name = name; this.st = st; this.ticksPerRev = ticksPerRev; this.port = port; push(); }
        @Override public int getPortNumber() { return port; }
        @Override public DcMotorController getController() { return DcMotorController.SIM_HUB; }
        private void push() {
            JsonObject o = new JsonObject();
            o.addProperty("kind", "motor"); o.addProperty("power", enabled ? power : 0); o.addProperty("mode", mode.name()); o.addProperty("reverse", dir == Direction.REVERSE);
            o.addProperty("targetVel", targetVel); o.addProperty("targetPos", targetPos); o.addProperty("brake", zpb != ZeroPowerBehavior.FLOAT);
            st.actuators.put(name, o);
        }
        private double rawPos() { SimState.MotorSensor m = st.snapshot().motors.get(name); return m == null ? 0 : m.position; }
        private double rawVel() { SimState.MotorSensor m = st.snapshot().motors.get(name); return m == null ? 0 : m.velocity; }
        /** the twin's motor model: stall current at a command the chassis cannot follow, free current when spinning freely */
        @Override public double getCurrent(CurrentUnit unit) { SimState.MotorSensor m = st.snapshot().motors.get(name); double a = m == null ? Math.abs(power) * 2.0 : m.amps; return unit == CurrentUnit.MILLIAMPS ? a * 1000 : a; }
        @Override public boolean isOverCurrent() { return getCurrent(CurrentUnit.AMPS) > alertAmps; }
        private double alertAmps = 9.0;
        @Override public double getCurrentAlert(CurrentUnit unit) { return unit == CurrentUnit.MILLIAMPS ? alertAmps * 1000 : alertAmps; }
        @Override public void setCurrentAlert(double current, CurrentUnit unit) { alertAmps = unit == CurrentUnit.MILLIAMPS ? current / 1000 : current; }
        private double sgn() { return dir == Direction.REVERSE ? -1 : 1; }
        @Override public void setDirection(Direction d) { dir = d; push(); }
        @Override public Direction getDirection() { return dir; }
        @Override public void setPower(double p) { power = Math.max(-1, Math.min(1, p)); push(); }
        @Override public double getPower() { return power; }
        @Override public void setZeroPowerBehavior(ZeroPowerBehavior b) { zpb = b; push(); }
        @Override public ZeroPowerBehavior getZeroPowerBehavior() { return zpb; }
        @Override public void setTargetPosition(int p) { targetPos = p; push(); }
        @Override public int getTargetPosition() { return targetPos; }
        @Override public boolean isBusy() { return mode == RunMode.RUN_TO_POSITION && Math.abs(getCurrentPosition() - targetPos) > tolerance; }
        @Override public int getCurrentPosition() { return (int) Math.round(sgn() * (rawPos() - encoderOffset)); }
        @Override public void setMode(RunMode m) {
            if (m == RunMode.STOP_AND_RESET_ENCODER) { encoderOffset = rawPos(); power = 0; mode = RunMode.RUN_WITHOUT_ENCODER; push(); return; }
            mode = m; push();
        }
        @Override public RunMode getMode() { return mode; }
        @Override public void setMotorEnable() { enabled = true; push(); }
        @Override public void setMotorDisable() { enabled = false; push(); }
        @Override public boolean isMotorEnabled() { return enabled; }
        @Override public void setVelocity(double ticksPerSec) { targetVel = sgn() * ticksPerSec; mode = RunMode.RUN_USING_ENCODER; power = Math.max(-1, Math.min(1, ticksPerSec / (ticksPerRev * 100))); push(); }
        @Override public void setVelocity(double rate, AngleUnit unit) { setVelocity(unit.toDegrees(rate) / 360.0 * ticksPerRev); }
        @Override public double getVelocity() { return sgn() * rawVel(); }
        @Override public double getVelocity(AngleUnit unit) { return unit.fromDegrees(getVelocity() / ticksPerRev * 360.0); }
        @Override public void setTargetPositionTolerance(int t) { tolerance = t; }
        @Override public int getTargetPositionTolerance() { return tolerance; }
        @Override public String getDeviceName() { return name; }
        @Override public MotorConfigurationType getMotorType() { MotorConfigurationType t = new MotorConfigurationType(); t.setTicksPerRev(ticksPerRev); return t; }
    }

    public static class SimServo implements ServoImplEx {
        final String name; final SimState st; int port; Direction dir = Direction.FORWARD; double pos = 0.5, min = 0, max = 1;
        public SimServo(String name, SimState st, int port) { this.name = name; this.st = st; this.port = port; push(); }
        @Override public int getPortNumber() { return port; }
        @Override public ServoController getController() { return ServoController.SIM_HUB; }
        private void push() { JsonObject o = new JsonObject(); o.addProperty("kind", "servo"); o.addProperty("position", effective()); st.actuators.put(name, o); }
        private double effective() { double p = dir == Direction.REVERSE ? 1 - pos : pos; return min + p * (max - min); }
        @Override public void setDirection(Direction d) { dir = d; push(); }
        @Override public Direction getDirection() { return dir; }
        @Override public void setPosition(double p) { pos = Math.max(0, Math.min(1, p)); push(); }
        @Override public double getPosition() { return pos; }
        @Override public void scaleRange(double mn, double mx) { min = mn; max = mx; push(); }
        @Override public String getDeviceName() { return name; }
    }

    public static class SimCRServo implements CRServo {
        final String name; final SimState st; int port; Direction dir = Direction.FORWARD; double power = 0;
        public SimCRServo(String name, SimState st, int port) { this.name = name; this.st = st; this.port = port; push(); }
        @Override public int getPortNumber() { return port; }
        @Override public ServoController getController() { return ServoController.SIM_HUB; }
        private void push() { JsonObject o = new JsonObject(); o.addProperty("kind", "crservo"); o.addProperty("power", dir == Direction.REVERSE ? -power : power); st.actuators.put(name, o); }
        @Override public void setDirection(Direction d) { dir = d; push(); }
        @Override public Direction getDirection() { return dir; }
        @Override public void setPower(double p) { power = Math.max(-1, Math.min(1, p)); push(); }
        @Override public double getPower() { return power; }
        @Override public String getDeviceName() { return name; }
    }

    public static class SimImu implements IMU {
        final SimState st; double yawOffset = 0; final String name;
        public SimImu(String name, SimState st) { this.name = name; this.st = st; }
        @Override public boolean initialize(Parameters p) { return true; }
        @Override public void resetYaw() { yawOffset = st.snapshot().imuYawDeg; }
        private double yaw() { return AngleUnit.normalizeDegrees(st.snapshot().imuYawDeg - yawOffset); }
        @Override public YawPitchRollAngles getRobotYawPitchRollAngles() { SimState.Snapshot s = st.snapshot(); return new YawPitchRollAngles(AngleUnit.DEGREES, yaw(), s.imuPitchDeg, s.imuRollDeg, s.nanos); }
        @Override public Orientation getRobotOrientation(AxesReference r, AxesOrder o, AngleUnit u) {
            // Z-up yaw is the third angle for ZYX extrinsic / first for intrinsic ZYX; return yaw where teams usually read it
            float yaw = (float) u.fromDegrees(yaw());
            Orientation or = new Orientation(r, o, u, 0, 0, 0, st.snapshot().nanos);
            if (o.name().startsWith("Z")) or.firstAngle = yaw; else if (o.name().endsWith("Z")) or.thirdAngle = yaw; else or.secondAngle = yaw;
            return or;
        }
        @Override public Quaternion getRobotOrientationAsQuaternion() { double h = Math.toRadians(yaw()) / 2; return new Quaternion((float) Math.cos(h), 0, 0, (float) Math.sin(h), st.snapshot().nanos); }
        @Override public AngularVelocity getRobotAngularVelocity(AngleUnit u) { return new AngularVelocity(u, 0, 0, (float) u.fromDegrees(st.snapshot().imuYawRateDps), st.snapshot().nanos); }
        @Override public String getDeviceName() { return name; }
    }

    public static class SimDistance implements DistanceSensor {
        final String name; final SimState st;
        public SimDistance(String name, SimState st) { this.name = name; this.st = st; }
        @Override public double getDistance(DistanceUnit u) { Double d = st.snapshot().distancesIn.get(name); return d == null ? DistanceSensor.distanceOutOfRange : u.fromInches(d); }
        @Override public String getDeviceName() { return name; }
    }

    public static class SimVoltage implements VoltageSensor {
        final SimState st; public SimVoltage(SimState st) { this.st = st; }
        @Override public double getVoltage() { return st.snapshot().batteryVolts; }
        @Override public String getDeviceName() { return "Control Hub"; }
    }

    public static class SimWebcam implements WebcamName {
        final String name; public SimWebcam(String name) { this.name = name; }
        @Override public String getUsbDeviceNameIfAttached() { return name; }
        @Override public boolean isAttached() { return true; }
        @Override public String getDeviceName() { return name; }
    }

    public static class SimTouch implements TouchSensor {
        final String name; public SimTouch(String name) { this.name = name; }
        @Override public double getValue() { return 0; }
        @Override public boolean isPressed() { return false; }
        @Override public String getDeviceName() { return name; }
    }
}
