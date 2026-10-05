package com.qualcomm.robotcore.eventloop.opmode;

/** Linear OpMode: runOpMode() runs on its own thread; waitForStart() blocks until START. */
public abstract class LinearOpMode extends OpMode {
    private volatile boolean started = false;
    private volatile boolean stopRequested = false;
    private volatile boolean inInit = true;

    public abstract void runOpMode() throws InterruptedException;

    public void waitForStart() {
        while (!started && !stopRequested) {
            idle();
        }
    }
    public void idle() {
        try { Thread.sleep(1); } catch (InterruptedException e) { Thread.currentThread().interrupt(); stopRequested = true; }
    }
    public void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); stopRequested = true; }
    }
    public boolean opModeIsActive() { return started && !isStopRequested(); }
    public boolean opModeInInit() { return inInit && !isStopRequested(); }
    public boolean isStarted() { return started || isStopRequested(); }
    public boolean isStopRequested() { return stopRequested || Thread.currentThread().isInterrupted() || internalStopRequested(); }
    public void terminateOpModeNow() { requestOpModeStop(); }

    // ---- host hooks (not part of the SDK API)
    public final void internalStart() { started = true; inInit = false; }
    public final void internalStop() { stopRequested = true; }

    @Override public final void init() {}
    @Override public final void loop() {}
}
