package com.qualcomm.robotcore.hardware;
import org.firstinspires.ftc.robotcore.external.navigation.AngleUnit;
import org.firstinspires.ftc.robotcore.external.navigation.CurrentUnit;
public interface DcMotorEx extends DcMotor {
    void setMotorEnable();
    void setMotorDisable();
    boolean isMotorEnabled();
    /** ticks per second */
    void setVelocity(double angularRate);
    void setVelocity(double angularRate, AngleUnit unit);
    double getVelocity();
    double getVelocity(AngleUnit unit);
    default void setPIDCoefficients(RunMode mode, PIDCoefficients c) {}
    default void setPIDFCoefficients(RunMode mode, PIDFCoefficients c) {}
    default void setVelocityPIDFCoefficients(double p, double i, double d, double f) {}
    default void setPositionPIDFCoefficients(double p) {}
    default PIDCoefficients getPIDCoefficients(RunMode mode) { return new PIDCoefficients(10, 3, 0); }
    default PIDFCoefficients getPIDFCoefficients(RunMode mode) { return new PIDFCoefficients(10, 3, 0, 12); }
    void setTargetPositionTolerance(int tolerance);
    int getTargetPositionTolerance();
    default double getCurrent(CurrentUnit unit) { return Math.abs(getPower()) * 2.0; }
    default double getCurrentAlert(CurrentUnit unit) { return 9.0; }
    default void setCurrentAlert(double current, CurrentUnit unit) {}
    default boolean isOverCurrent() { return false; }
}
