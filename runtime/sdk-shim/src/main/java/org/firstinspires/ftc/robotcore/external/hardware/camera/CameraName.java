package org.firstinspires.ftc.robotcore.external.hardware.camera;
import com.qualcomm.robotcore.hardware.HardwareDevice;
public interface CameraName extends HardwareDevice { default boolean isWebcam() { return true; } default boolean isCameraDirection() { return false; } default boolean isSwitchable() { return false; } default boolean isUnknown() { return false; } }
