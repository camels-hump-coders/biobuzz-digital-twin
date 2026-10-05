package com.qualcomm.robotcore.eventloop.opmode;

import org.firstinspires.ftc.robotcore.internal.opmode.OpModeMeta;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * The robot controller's OpMode manager, as dashboards see it. On the desktop the host's OpMode runner plugs in as the
 * {@link Delegate}; the runner also fires the lifecycle notifications through the static fire* methods.
 */
public class OpModeManagerImpl implements OpModeManager, OpModeManagerNotifier {
    /** What the host provides. */
    public interface Delegate {
        void initOpMode(String name);
        void startActiveOpMode();
        void stopActiveOpMode();
        String getActiveOpModeName();
        OpMode getActiveOpMode();
    }
    private static final List<Notifications> listeners = new CopyOnWriteArrayList<>();
    private static volatile Delegate delegate;
    private static volatile OpMode active;

    public static void setDelegate(Delegate d) { delegate = d; }
    public static void firePreInit(OpMode op) { active = op; for (Notifications l : listeners) try { l.onOpModePreInit(op); } catch (Throwable t) { warn(t); } }
    public static void firePreStart(OpMode op) { for (Notifications l : listeners) try { l.onOpModePreStart(op); } catch (Throwable t) { warn(t); } }
    public static void firePostStop(OpMode op) { for (Notifications l : listeners) try { l.onOpModePostStop(op); } catch (Throwable t) { warn(t); } active = null; }
    private static void warn(Throwable t) { System.err.println("dashboard listener threw: " + t); }

    @Override public OpMode registerListener(Notifications listener) { if (!listeners.contains(listener)) listeners.add(listener); return active; }
    @Override public void unregisterListener(Notifications listener) { listeners.remove(listener); }
    @Override public void register(String name, OpMode opMode) {}
    @Override public void register(OpModeMeta meta, OpMode opMode) {}
    @Override public void register(String name, Class<?> opModeClass) {}
    @Override public void register(OpModeMeta meta, Class<?> opModeClass) {}
    @Override public OpMode getActiveOpMode() { Delegate d = delegate; return d == null ? active : d.getActiveOpMode(); }
    @Override public String getActiveOpModeName() { Delegate d = delegate; return d == null ? DEFAULT_OP_MODE_NAME : d.getActiveOpModeName(); }
    @Override public void initOpMode(String name) { Delegate d = delegate; if (d != null) d.initOpMode(name); }
    @Override public void startActiveOpMode() { Delegate d = delegate; if (d != null) d.startActiveOpMode(); }
    @Override public void stopActiveOpMode() { Delegate d = delegate; if (d != null) d.stopActiveOpMode(); }
    @Override public void requestOpModeStop(OpMode opMode) { stopActiveOpMode(); }
}
