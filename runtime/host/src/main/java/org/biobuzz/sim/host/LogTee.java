package org.biobuzz.sim.host;

import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.function.BiConsumer;

/** Mirrors every line the host prints (OpMode System.out, RobotLog, stack traces) to a sink, rate-limited. */
public final class LogTee {
    private LogTee() {}
    public static void install(BiConsumer<String, String> sink) {
        System.setOut(wrap(System.out, "out", sink));
        System.setErr(wrap(System.err, "err", sink));
    }
    private static PrintStream wrap(PrintStream original, String level, BiConsumer<String, String> sink) {
        return new PrintStream(new java.io.OutputStream() {
            private final StringBuilder line = new StringBuilder();
            private long windowStart = System.currentTimeMillis(); private int inWindow = 0;
            @Override public void write(int b) { original.write(b); if (b == '\n') flushLine(); else if (b != '\r') line.append((char) b); }
            @Override public void write(byte[] buf, int off, int len) {
                original.write(buf, off, len);
                String s = new String(buf, off, len, StandardCharsets.UTF_8);
                for (int i = 0; i < s.length(); i++) { char c = s.charAt(i); if (c == '\n') flushLine(); else if (c != '\r') line.append(c); }
            }
            private void flushLine() {
                String text = line.toString(); line.setLength(0);
                if (text.isBlank() || text.startsWith("PANELS:")) return; // Panels' own chatter stays in the console
                long now = System.currentTimeMillis();
                if (now - windowStart > 1000) { windowStart = now; inWindow = 0; }
                if (++inWindow > 60) { if (inWindow == 61) sink.accept("warn", "(host log rate-limited: more than 60 lines/s)"); return; }
                sink.accept(level, text.length() > 600 ? text.substring(0, 600) + "…" : text);
            }
        }, true, StandardCharsets.UTF_8);
    }
}
