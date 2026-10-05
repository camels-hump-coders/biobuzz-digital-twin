package com.qualcomm.robotcore.util;
import java.util.concurrent.TimeUnit;
public class ElapsedTime {
    public enum Resolution { SECONDS, MILLISECONDS }
    public static final long SECOND_IN_NANO = 1_000_000_000L, MILLIS_IN_NANO = 1_000_000L;
    private long startNs; private final double resolution;
    public ElapsedTime() { this(Resolution.SECONDS); }
    public ElapsedTime(long startTimeNs) { this.startNs = startTimeNs; resolution = SECOND_IN_NANO; }
    public ElapsedTime(Resolution r) { startNs = System.nanoTime(); resolution = r == Resolution.SECONDS ? SECOND_IN_NANO : MILLIS_IN_NANO; }
    public void reset() { startNs = System.nanoTime(); }
    public long startTime() { return startNs; }
    public long startTimeNanoseconds() { return startNs; }
    public long nanoseconds() { return System.nanoTime() - startNs; }
    public double time() { return nanoseconds() / resolution; }
    public long time(TimeUnit unit) { return unit.convert(nanoseconds(), TimeUnit.NANOSECONDS); }
    public double seconds() { return nanoseconds() / (double) SECOND_IN_NANO; }
    public double milliseconds() { return nanoseconds() / (double) MILLIS_IN_NANO; }
    public Resolution getResolution() { return resolution == SECOND_IN_NANO ? Resolution.SECONDS : Resolution.MILLISECONDS; }
    public void log(String label) { System.out.printf("TIMER: %s - %.3f s%n", label, seconds()); }
    @Override public String toString() { return String.format("%.3f s", seconds()); }
}
