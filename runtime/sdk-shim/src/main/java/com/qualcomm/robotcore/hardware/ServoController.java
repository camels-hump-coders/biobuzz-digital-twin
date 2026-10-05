package com.qualcomm.robotcore.hardware;
public interface ServoController extends HardwareDevice {
    default void pwmEnable() {}
    default void pwmDisable() {}
    /** the one simulated Control Hub */
    ServoController SIM_HUB = new ServoController() { @Override public String getDeviceName() { return "Control Hub"; } };
}
