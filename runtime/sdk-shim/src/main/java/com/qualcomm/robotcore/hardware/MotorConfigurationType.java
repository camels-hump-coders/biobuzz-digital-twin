package com.qualcomm.robotcore.hardware;
public class MotorConfigurationType {
    private double ticksPerRev = 537.7, maxRpm = 312, gearing = 19.2;
    public static MotorConfigurationType getUnspecifiedMotorType() { return new MotorConfigurationType(); }
    public double getTicksPerRev() { return ticksPerRev; }
    public double getMaxRPM() { return maxRpm; }
    public double getGearing() { return gearing; }
    public double getAchieveableMaxTicksPerSecond() { return ticksPerRev * maxRpm / 60.0; }
    public void setTicksPerRev(double v) { ticksPerRev = v; }
    public void setMaxRPM(double v) { maxRpm = v; }
    public void setGearing(double v) { gearing = v; }
}
