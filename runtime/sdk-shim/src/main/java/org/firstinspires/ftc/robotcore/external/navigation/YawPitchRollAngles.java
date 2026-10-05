package org.firstinspires.ftc.robotcore.external.navigation;
public class YawPitchRollAngles {
    private final AngleUnit unit; private final double yaw, pitch, roll; private final long acquisitionTime;
    public YawPitchRollAngles(AngleUnit unit, double yaw, double pitch, double roll, long acquisitionTime) { this.unit = unit; this.yaw = yaw; this.pitch = pitch; this.roll = roll; this.acquisitionTime = acquisitionTime; }
    public double getYaw(AngleUnit u) { return u.fromUnit(unit, yaw); }
    public double getPitch(AngleUnit u) { return u.fromUnit(unit, pitch); }
    public double getRoll(AngleUnit u) { return u.fromUnit(unit, roll); }
    public double getYaw() { return yaw; }
    public double getPitch() { return pitch; }
    public double getRoll() { return roll; }
    public long getAcquisitionTime() { return acquisitionTime; }
    @Override public String toString() { return String.format("yaw=%.1f pitch=%.1f roll=%.1f %s", yaw, pitch, roll, unit); }
}
