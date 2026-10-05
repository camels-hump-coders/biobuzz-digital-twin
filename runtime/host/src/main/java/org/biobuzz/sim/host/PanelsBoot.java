package org.biobuzz.sim.host;

import android.content.Context;
import com.qualcomm.ftccommon.FtcEventLoop;
import com.qualcomm.robotcore.eventloop.opmode.OpMode;
import com.qualcomm.robotcore.eventloop.opmode.OpModeManager;
import com.qualcomm.robotcore.eventloop.opmode.OpModeManagerImpl;
import com.qualcomm.robotcore.hardware.HardwareMap;
import org.firstinspires.ftc.robotcore.internal.opmode.OpModeMeta;
import org.firstinspires.ftc.robotcore.internal.opmode.RegisteredOpModes;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;

/**
 * Starts the real FTC Panels dashboard the way the robot controller does: register the OpModes, hand Panels a Context
 * (assets = TeamCode assets + Panels' own web UI) and an event loop whose OpMode manager is our runner, and let it bring
 * up its NanoHTTPD servers (web UI on 8001, socket on 8002). Panels then receives the same lifecycle notifications and
 * telemetry/field/camera calls from the team's code as on the robot.
 */
public final class PanelsBoot {
    public static final String URL = "http://localhost:8001";
    // Panels plugins keep only weak references to these; hold them for the life of the host
    private static OpModeManagerImpl manager; private static FtcEventLoop eventLoop; private static Context context;
    private PanelsBoot() {}

    public static boolean start(OpModeRunner runner, List<OpModeScanner.Entry> opModes, Supplier<HardwareMap> hardwareMap) {
        if (!Boolean.parseBoolean(System.getProperty("sim.panels", "true"))) return false;
        try {
            Class.forName("com.bylazar.panels.Panels");
        } catch (ClassNotFoundException e) { System.out.println("Panels: library not on the classpath, dashboard disabled"); return false; }
        // Panels binds fixed ports; a second host (another pnpm sim, a twin-test run) must not fight the first one for them
        for (int port : new int[] { 8001, 8002 }) {
            try (java.net.ServerSocket probe = new java.net.ServerSocket()) { probe.setReuseAddress(true); probe.bind(new java.net.InetSocketAddress(port)); }
            catch (java.io.IOException busy) { System.out.println("Panels: port " + port + " is in use (another host has the dashboard), skipping Panels in this host"); return false; }
        }
        try {
            List<OpModeMeta> metas = new ArrayList<>();
            for (OpModeScanner.Entry e : opModes) metas.add(new OpModeMeta.Builder().setName(e.name).setGroup(e.group == null ? "" : e.group).setFlavor("Autonomous".equals(e.flavor) ? OpModeMeta.Flavor.AUTONOMOUS : OpModeMeta.Flavor.TELEOP).setSource(OpModeMeta.Source.ANDROID_STUDIO).build());
            RegisteredOpModes.getInstance().setOpModes(metas);
            OpModeManagerImpl.setDelegate(new OpModeManagerImpl.Delegate() {
                @Override public void initOpMode(String name) {
                    if (OpModeManager.DEFAULT_OP_MODE_NAME.equals(name)) { runner.stop(); return; }
                    opModes.stream().filter(e -> e.name.equals(name)).findFirst().ifPresent(e -> runner.init(e, hardwareMap.get()));
                }
                @Override public void startActiveOpMode() { runner.start(); }
                @Override public void stopActiveOpMode() { runner.stop(); }
                @Override public String getActiveOpModeName() { OpModeRunner.Status s = runner.status(); return s == OpModeRunner.Status.INIT || s == OpModeRunner.Status.RUNNING ? runner.currentName() : OpModeManager.DEFAULT_OP_MODE_NAME; }
                @Override public OpMode getActiveOpMode() { return runner.currentOpMode(); }
            });
            context = new Context();
            manager = new OpModeManagerImpl();
            eventLoop = new FtcEventLoop(manager);
            if (Boolean.getBoolean("sim.debugLifecycle")) { com.bylazar.panels.PanelsConfig cfg = new com.bylazar.panels.PanelsConfig(); cfg.setEnableLogs(true); com.bylazar.panels.Panels.INSTANCE.setConfig(cfg); }
            com.bylazar.panels.Panels.start(context);
            com.bylazar.panels.Panels.attachEventLoop(context, eventLoop);
            System.out.println("Panels dashboard: " + URL + "  (the real com.bylazar Panels, fed by the twin)");
            return true;
        } catch (Throwable t) {
            System.err.println("Panels could not start: " + t);
            t.printStackTrace();
            return false;
        }
    }
}
