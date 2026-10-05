package org.firstinspires.ftc.robotcore.internal.system;

/** Desktop stand-in. */
public class Misc { public static String formatInvariant(String fmt, Object... args) { return String.format(java.util.Locale.ROOT, fmt, args); } public static String formatForUser(String fmt, Object... args) { return String.format(fmt, args); } }
