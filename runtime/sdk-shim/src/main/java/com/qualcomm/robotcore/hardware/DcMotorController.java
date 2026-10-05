package com.qualcomm.robotcore.hardware;
public interface DcMotorController extends HardwareDevice {
    /** the one simulated Control Hub */
    DcMotorController SIM_HUB = new DcMotorController() { @Override public String getDeviceName() { return "Control Hub"; } };
}
