package org.biobuzz.sim.host;

import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;
import com.qualcomm.robotcore.eventloop.opmode.OpMode;
import com.qualcomm.robotcore.eventloop.opmode.OpModeManagerImpl;
import com.qualcomm.robotcore.hardware.Gamepad;
import com.qualcomm.robotcore.hardware.HardwareMap;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.function.Consumer;

/** Driver-Station-like lifecycle: INIT -> (init_loop) -> START -> (loop) -> STOP, on a dedicated thread. */
public class OpModeRunner {
    public enum Status { IDLE, INIT, RUNNING, STOPPED, ERROR }
    private final SimState state; private final Consumer<List<String>> telemetrySink; private final Consumer<String> statusSink;
    private volatile OpMode current; private volatile Thread thread; private volatile Status status = Status.IDLE; private volatile String error = "";
    private volatile boolean startRequested = false, stopRequested = false;
    private final Gamepad gp1 = new Gamepad(), gp2 = new Gamepad();
    private volatile String currentName = "";

    public OpModeRunner(SimState state, Consumer<List<String>> telemetrySink, Consumer<String> statusSink) { this.state = state; this.telemetrySink = telemetrySink; this.statusSink = statusSink; }

    public Status status() { return status; }
    public String error() { return error; }
    public String currentName() { return currentName; }
    public OpMode currentOpMode() { return current; }

    public synchronized void init(OpModeScanner.Entry entry, HardwareMap map) {
        stop();
        try {
            OpMode op = entry.cls.getDeclaredConstructor().newInstance();
            op.hardwareMap = map; op.gamepad1 = gp1; op.gamepad2 = gp2; op.telemetry = new SimTelemetry(telemetrySink);
            op.resetRuntime();
            current = op; currentName = entry.name; startRequested = false; stopRequested = false; error = "";
            status = Status.INIT; // dashboards read the active OpMode name during the notification, so the state comes first
            OpModeManagerImpl.firePreInit(op); // dashboards (Panels) hook telemetry/field/camera here, like on the robot
            statusSink.accept("INIT");
            thread = new Thread(() -> run(op), "opmode-" + entry.name);
            thread.setDaemon(true);
            thread.start();
        } catch (Throwable t) { fail(t); }
    }
    public void start() { startRequested = true; }
    public synchronized void stop() {
        stopRequested = true;
        OpMode op = current; Thread th = thread;
        if (op instanceof LinearOpMode) ((LinearOpMode) op).internalStop();
        if (op != null) op.requestOpModeStop();
        if (th != null) { th.interrupt(); try { th.join(1500); } catch (InterruptedException ignored) {} }
        current = null; thread = null;
        if (status != Status.ERROR) status = Status.STOPPED;
        if (op != null) OpModeManagerImpl.firePostStop(op); // after the state flips so dashboards see "stopped"
        // zero every actuator so the sim robot stops
        for (JsonObject o : state.actuators.values()) { if (o.has("power")) o.addProperty("power", 0); if (o.has("targetVel")) o.addProperty("targetVel", 0); }
        if (status != Status.ERROR) { status = Status.STOPPED; statusSink.accept("STOPPED"); }
    }

    /** Called by the link at sensor rate to mirror gamepad state. */
    public void updateGamepads(JsonObject g1, JsonObject g2) { apply(gp1, g1); apply(gp2, g2); }
    private static void apply(Gamepad g, JsonObject j) {
        if (j == null) return;
        g.left_stick_x = f(j, "lx"); g.left_stick_y = f(j, "ly"); g.right_stick_x = f(j, "rx"); g.right_stick_y = f(j, "ry");
        g.left_trigger = f(j, "lt"); g.right_trigger = f(j, "rt");
        g.a = b(j, "a"); g.b = b(j, "b"); g.x = b(j, "x"); g.y = b(j, "y");
        g.left_bumper = b(j, "lb"); g.right_bumper = b(j, "rb"); g.back = b(j, "back"); g.start = b(j, "start"); g.guide = b(j, "guide");
        g.dpad_up = b(j, "du"); g.dpad_down = b(j, "dd"); g.dpad_left = b(j, "dl"); g.dpad_right = b(j, "dr");
        g.left_stick_button = b(j, "ls"); g.right_stick_button = b(j, "rs");
        g.timestamp = System.currentTimeMillis();
        g.syncAliases();
    }
    private static float f(JsonObject j, String k) { return j.has(k) ? j.get(k).getAsFloat() : 0f; }
    private static boolean b(JsonObject j, String k) { return j.has(k) && j.get(k).getAsBoolean(); }

    private void run(OpMode op) {
        try {
            if (op instanceof LinearOpMode) {
                LinearOpMode lop = (LinearOpMode) op;
                Thread starter = new Thread(() -> { while (!startRequested && !stopRequested) sleepQuiet(5); if (startRequested && !stopRequested) { OpModeManagerImpl.firePreStart(lop); status = Status.RUNNING; statusSink.accept("RUNNING"); lop.internalStart(); } }, "opmode-start-watch");
                starter.setDaemon(true); starter.start();
                lop.runOpMode();
                lop.internalStop();
            } else {
                op.init();
                op.telemetry.update();
                while (!startRequested && !stopRequested) { op.internalUpdateTime(); op.init_loop(); sleepQuiet(20); }
                if (!stopRequested) {
                    OpModeManagerImpl.firePreStart(op);
                    op.resetRuntime(); op.start(); status = Status.RUNNING; statusSink.accept("RUNNING");
                    while (!stopRequested && !op.internalStopRequested()) { op.internalUpdateTime(); op.loop(); sleepQuiet(10); }
                }
                op.stop();
            }
            if (status != Status.ERROR) { status = Status.STOPPED; statusSink.accept("STOPPED"); }
        } catch (Throwable t) {
            if (!(t instanceof InterruptedException)) fail(t);
        }
    }
    private void fail(Throwable t) {
        status = Status.ERROR; error = t.getClass().getSimpleName() + ": " + t.getMessage();
        StringBuilder sb = new StringBuilder(error);
        for (StackTraceElement e : t.getStackTrace()) { if (e.getClassName().startsWith("org.firstinspires.ftc.teamcode") || sb.length() < 400) sb.append("\n  at ").append(e); }
        error = sb.toString();
        statusSink.accept("ERROR");
        t.printStackTrace();
    }
    private static void sleepQuiet(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } }
}
