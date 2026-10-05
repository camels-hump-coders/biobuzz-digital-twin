package com.qualcomm.robotcore.hardware;
public interface Servo extends HardwareDevice {
    double MIN_POSITION = 0.0, MAX_POSITION = 1.0;
    enum Direction { FORWARD, REVERSE }
    default ServoController getController() { return null; }
    default int getPortNumber() { return 0; }
    void setDirection(Direction direction);
    Direction getDirection();
    void setPosition(double position);
    double getPosition();
    void scaleRange(double min, double max);
}
