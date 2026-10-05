package com.qualcomm.robotcore.util;
public final class RobotLog {
    private RobotLog() {}
    public static void i(String s) { System.out.println("[I] " + s); }
    public static void d(String s) { System.out.println("[D] " + s); }
    public static void w(String s) { System.out.println("[W] " + s); }
    public static void e(String s) { System.err.println("[E] " + s); }
    public static void ii(String tag, String fmt, Object... a) { System.out.println("[I/" + tag + "] " + String.format(fmt, a)); }
    public static void dd(String tag, String fmt, Object... a) { System.out.println("[D/" + tag + "] " + String.format(fmt, a)); }
    public static void ww(String tag, String fmt, Object... a) { System.out.println("[W/" + tag + "] " + String.format(fmt, a)); }
    public static void ee(String tag, String fmt, Object... a) { System.err.println("[E/" + tag + "] " + String.format(fmt, a)); }
    public static void addGlobalWarningMessage(String s) { w(s); }
}
