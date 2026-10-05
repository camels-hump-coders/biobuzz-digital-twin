package com.qualcomm.robotcore.eventloop.opmode;

import org.firstinspires.ftc.robotcore.internal.opmode.OpModeMeta;

/** FTC SDK OpModeManager API surface that dashboards use. */
public interface OpModeManager {
    String DEFAULT_OP_MODE_NAME = "$Stop$Robot$";
    void register(String name, OpMode opMode);
    void register(OpModeMeta meta, OpMode opMode);
    void register(String name, Class<?> opModeClass);
    void register(OpModeMeta meta, Class<?> opModeClass);
    OpMode getActiveOpMode();
    String getActiveOpModeName();
    void initOpMode(String name);
    void startActiveOpMode();
    void stopActiveOpMode();
    void requestOpModeStop(OpMode opMode);
}
