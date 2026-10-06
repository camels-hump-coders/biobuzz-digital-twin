package org.biobuzz.sim.host;

import java.util.List;

public class Main {
    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getProperty("port", args.length > 0 ? args[0] : "8765"));
        // the launcher (scripts/sim.mjs) kills this exact process on shutdown: under `gradlew run` the host is a child of
        // the Gradle daemon, not of the launcher, so a signal to gradlew alone leaves it running
        System.out.println("sim-host pid " + ProcessHandle.current().pid() + " port " + port);
        startWatchdog();
        preloadShim();
        List<OpModeScanner.Entry> opModes = OpModeScanner.scan();
        System.out.println("OpModes found:");
        for (OpModeScanner.Entry e : opModes) System.out.printf("  [%s] %s  (%s)%n", e.flavor, e.name, e.cls.getName());
        if (opModes.isEmpty()) System.out.println("  none — is the team module on the classpath? (see runtime/README.md)");
        SimLink link = new SimLink(port, opModes);
        LogTee.install(link::broadcastLog); // OpMode prints and RobotLog lines reach the twin's timeline
        Runtime.getRuntime().addShutdownHook(new Thread(() -> { try { link.stop(500); } catch (Exception ignored) {} }));
        current = link;
        AgentApi.start(link, Integer.parseInt(System.getProperty("agentPort", String.valueOf(port + 1)))); // agents inspect/steer the live session
        link.run(); // blocks while serving; returns only after stop() or a fatal socket error
        System.err.println("sim-host: server loop ended; exiting");
        System.exit(0); // never leave Panels / scheduler threads keeping a server-less JVM alive
    }

    private static volatile SimLink current;
    /** Startup watchdog: if the socket is not listening within 60 s of launch (shim preload, OpMode scan, Panels boot,
     * bind), dump every thread and exit instead of lingering as a silent JVM that launcher and twin wait on forever. */
    private static void startWatchdog() {
        Thread watchdog = new Thread(() -> {
            try { Thread.sleep(60_000); } catch (InterruptedException e) { return; }
            SimLink l = current;
            if (l != null && l.started) return;
            System.err.println("sim-host: not listening after 60 s; thread dump follows, then exit(1)");
            for (var e : Thread.getAllStackTraces().entrySet()) {
                System.err.println("  thread \"" + e.getKey().getName() + "\" " + e.getKey().getState());
                int n = 0; for (StackTraceElement f : e.getValue()) { if (n++ > 12) break; System.err.println("      at " + f); }
            }
            Runtime.getRuntime().halt(1);
        }, "sim-host-watchdog");
        watchdog.setDaemon(true); watchdog.start();
    }

    /**
     * Load every class in the sdk-shim jar up front. A long-running host otherwise loads shim classes lazily at the first
     * INIT, and if the jar was rebuilt underneath it in the meantime (git pull, another `pnpm sim`) the JVM's cached jar
     * index no longer matches and INIT dies with NoClassDefFoundError.
     */
    private static void preloadShim() {
        try {
            java.net.URL loc = org.biobuzz.sim.shim.SimHooks.class.getProtectionDomain().getCodeSource().getLocation();
            java.io.File f = new java.io.File(loc.toURI());
            if (!f.isFile()) return;
            int n = 0;
            try (java.util.jar.JarFile jar = new java.util.jar.JarFile(f)) {
                for (java.util.Enumeration<java.util.jar.JarEntry> en = jar.entries(); en.hasMoreElements();) {
                    String name = en.nextElement().getName();
                    if (!name.endsWith(".class") || name.contains("-")) continue;
                    try { Class.forName(name.substring(0, name.length() - 6).replace('/', '.'), false, Main.class.getClassLoader()); n++; } catch (Throwable ignored) {}
                }
            }
            System.out.println("sdk-shim: " + n + " classes preloaded");
        } catch (Exception e) { System.err.println("sdk-shim preload skipped: " + e); }
    }
}
