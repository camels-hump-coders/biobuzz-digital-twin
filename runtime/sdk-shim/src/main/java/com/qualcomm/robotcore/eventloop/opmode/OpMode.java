package com.qualcomm.robotcore.eventloop.opmode;

import com.qualcomm.robotcore.hardware.Gamepad;
import com.qualcomm.robotcore.hardware.HardwareMap;
import org.firstinspires.ftc.robotcore.external.Telemetry;

/** Iterative OpMode. The host calls init / init_loop / start / loop / stop on its own thread. */
public abstract class OpMode {
    public Gamepad gamepad1;
    public Gamepad gamepad2;
    public HardwareMap hardwareMap;
    public Telemetry telemetry;
    /** seconds since the OpMode was initialised */
    public double time = 0;
    private long startNanos = System.nanoTime();
    private volatile boolean stopRequested = false;

    public abstract void init();
    public void init_loop() {}
    public void start() {}
    public abstract void loop();
    public void stop() {}

    public double getRuntime() { return (System.nanoTime() - startNanos) / 1e9; }
    public void resetRuntime() { startNanos = System.nanoTime(); }
    public void requestOpModeStop() { stopRequested = true; }
    public boolean internalStopRequested() { return stopRequested; }
    public void internalResetStop() { stopRequested = false; }
    /** @deprecated kept for source compatibility */
    @Deprecated
    public void updateTelemetry(Telemetry t) { if (t != null) t.update(); }
    public void internalUpdateTime() { time = getRuntime(); }
}
