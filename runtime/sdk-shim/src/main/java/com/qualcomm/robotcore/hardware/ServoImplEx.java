package com.qualcomm.robotcore.hardware;
/** Some teams cast to ServoImplEx for setPwmEnable/Disable; provide the interface shape. */
public interface ServoImplEx extends Servo { default void setPwmEnable() {} default void setPwmDisable() {} default boolean isPwmEnabled() { return true; } }
