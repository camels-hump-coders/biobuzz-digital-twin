package com.qualcomm.robotcore.hardware;
import org.firstinspires.ftc.robotcore.external.navigation.*;
public interface IMU extends HardwareDevice {
    class Parameters {
        public final ImuOrientationOnRobot imuOrientationOnRobot;
        public Parameters(ImuOrientationOnRobot o) { this.imuOrientationOnRobot = o; }
    }
    boolean initialize(Parameters parameters);
    void resetYaw();
    YawPitchRollAngles getRobotYawPitchRollAngles();
    Orientation getRobotOrientation(AxesReference reference, AxesOrder order, AngleUnit angleUnit);
    Quaternion getRobotOrientationAsQuaternion();
    AngularVelocity getRobotAngularVelocity(AngleUnit angleUnit);
}
