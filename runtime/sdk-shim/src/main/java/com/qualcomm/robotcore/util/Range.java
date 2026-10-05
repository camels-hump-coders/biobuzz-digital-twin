package com.qualcomm.robotcore.util;
public final class Range {
    private Range() {}
    public static double scale(double n, double x1, double x2, double y1, double y2) { return (n - x1) / (x2 - x1) * (y2 - y1) + y1; }
    public static double clip(double n, double min, double max) { return Math.max(min, Math.min(max, n)); }
    public static float clip(float n, float min, float max) { return Math.max(min, Math.min(max, n)); }
    public static int clip(int n, int min, int max) { return Math.max(min, Math.min(max, n)); }
    public static short clip(short n, short min, short max) { return (short) Math.max(min, Math.min(max, n)); }
    public static byte clip(byte n, byte min, byte max) { return (byte) Math.max(min, Math.min(max, n)); }
    public static void throwIfRangeIsInvalid(double n, double min, double max) { if (n < min || n > max) throw new IllegalArgumentException("number " + n + " is invalid; valid ranges are " + min + ".." + max); }
}
