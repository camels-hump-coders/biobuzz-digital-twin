package org.biobuzz.sim.host;

import java.util.List;

public class Main {
    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getProperty("port", args.length > 0 ? args[0] : "8765"));
        List<OpModeScanner.Entry> opModes = OpModeScanner.scan();
        System.out.println("OpModes found:");
        for (OpModeScanner.Entry e : opModes) System.out.printf("  [%s] %s  (%s)%n", e.flavor, e.name, e.cls.getName());
        if (opModes.isEmpty()) System.out.println("  none — is the team module on the classpath? (see runtime/README.md)");
        SimLink link = new SimLink(port, opModes);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> { try { link.stop(500); } catch (Exception ignored) {} }));
        link.run(); // blocks
    }
}
