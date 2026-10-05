package org.biobuzz.sim.host;

import java.util.List;

public class Main {
    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getProperty("port", args.length > 0 ? args[0] : "8765"));
        preloadShim();
        List<OpModeScanner.Entry> opModes = OpModeScanner.scan();
        System.out.println("OpModes found:");
        for (OpModeScanner.Entry e : opModes) System.out.printf("  [%s] %s  (%s)%n", e.flavor, e.name, e.cls.getName());
        if (opModes.isEmpty()) System.out.println("  none — is the team module on the classpath? (see runtime/README.md)");
        SimLink link = new SimLink(port, opModes);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> { try { link.stop(500); } catch (Exception ignored) {} }));
        link.run(); // blocks
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
