package com.qualcomm.robotcore.hardware;
public interface DcMotor extends DcMotorSimple {
    enum RunMode { RUN_WITHOUT_ENCODER, RUN_USING_ENCODER, RUN_TO_POSITION, STOP_AND_RESET_ENCODER;
        public boolean isPIDMode() { return this == RUN_USING_ENCODER || this == RUN_TO_POSITION; } }
    enum ZeroPowerBehavior { UNKNOWN, BRAKE, FLOAT }
    void setZeroPowerBehavior(ZeroPowerBehavior b);
    ZeroPowerBehavior getZeroPowerBehavior();
    void setTargetPosition(int position);
    int getTargetPosition();
    boolean isBusy();
    int getCurrentPosition();
    void setMode(RunMode mode);
    RunMode getMode();
    default void setPowerFloat() { setZeroPowerBehavior(ZeroPowerBehavior.FLOAT); setPower(0); }
    default boolean getPowerFloat() { return getZeroPowerBehavior() == ZeroPowerBehavior.FLOAT && getPower() == 0; }
    default MotorConfigurationType getMotorType() { return MotorConfigurationType.getUnspecifiedMotorType(); }
    default void setMotorType(MotorConfigurationType t) {}
    default DcMotorController getController() { return null; }
    default int getPortNumber() { return 0; }
}
