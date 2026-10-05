package com.qualcomm.robotcore.hardware;
public interface CRServo extends DcMotorSimple { default ServoController getController() { return null; } default int getPortNumber() { return 0; } }
