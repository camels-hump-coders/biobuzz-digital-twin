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
    public static void v(String s) { System.out.println("[V] " + s); }
    public static void vv(String tag, String fmt, Object... a) { System.out.println("[V/" + tag + "] " + String.format(fmt, a)); }
    public static void ii(String tag, Throwable t, String fmt, Object... a) { ii(tag, fmt, a); t.printStackTrace(System.out); }
    public static void dd(String tag, Throwable t, String fmt, Object... a) { dd(tag, fmt, a); t.printStackTrace(System.out); }
    public static void ww(String tag, Throwable t, String fmt, Object... a) { ww(tag, fmt, a); t.printStackTrace(System.out); }
    public static void ee(String tag, Throwable t, String fmt, Object... a) { ee(tag, fmt, a); t.printStackTrace(System.err); }
    public static void e(String fmt, Object... a) { System.err.println("[E] " + String.format(fmt, a)); }
    public static void logStackTrace(Throwable t) { t.printStackTrace(System.err); }
    public static void logStackTrace(String tag, Throwable t) { System.err.println("[E/" + tag + "]"); t.printStackTrace(System.err); }
    public static void setGlobalErrorMsg(String s) { e(s); }
    public static void clearGlobalErrorMsg() {}
    public static void clearGlobalWarningMsg() {}
    public static void addGlobalWarningMessage(String s) { w(s); }
}
