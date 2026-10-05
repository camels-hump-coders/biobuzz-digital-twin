package org.firstinspires.ftc.robotcore.external.hardware.camera;
public enum BuiltinCameraDirection implements CameraName { FRONT, BACK; @Override public boolean isWebcam() { return false; } @Override public boolean isCameraDirection() { return true; } }
