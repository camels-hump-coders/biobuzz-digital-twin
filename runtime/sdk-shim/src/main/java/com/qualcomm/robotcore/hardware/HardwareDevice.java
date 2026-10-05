package com.qualcomm.robotcore.hardware;
public interface HardwareDevice {
    enum Manufacturer { Unknown, Other, Lynx, HiTechnic, ModernRobotics, Adafruit, Matrix, Lego, AMS, STMicroelectronics, Broadcom }
    default Manufacturer getManufacturer() { return Manufacturer.Other; }
    default String getDeviceName() { return getClass().getSimpleName(); }
    default String getConnectionInfo() { return "sim"; }
    default int getVersion() { return 1; }
    default void resetDeviceConfigurationForOpMode() {}
    default void close() {}
}
