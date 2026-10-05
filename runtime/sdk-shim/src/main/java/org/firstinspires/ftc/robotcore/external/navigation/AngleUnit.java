package org.firstinspires.ftc.robotcore.external.navigation;
public enum AngleUnit {
    DEGREES, RADIANS;
    public double fromDegrees(double d) { return this == DEGREES ? d : Math.toRadians(d); }
    public double fromRadians(double r) { return this == RADIANS ? r : Math.toDegrees(r); }
    public double fromUnit(AngleUnit u, double v) { return u == this ? v : (this == DEGREES ? Math.toDegrees(v) : Math.toRadians(v)); }
    public double toDegrees(double v) { return this == DEGREES ? v : Math.toDegrees(v); }
    public double toRadians(double v) { return this == RADIANS ? v : Math.toRadians(v); }
    public double normalize(double v) { return this == DEGREES ? normalizeDegrees(v) : normalizeRadians(v); }
    public static double normalizeDegrees(double d) { d %= 360; if (d >= 180) d -= 360; if (d < -180) d += 360; return d; }
    public static double normalizeRadians(double r) { r %= 2 * Math.PI; if (r >= Math.PI) r -= 2 * Math.PI; if (r < -Math.PI) r += 2 * Math.PI; return r; }
    public UnnormalizedAngleUnit getUnnormalized() { return this == DEGREES ? UnnormalizedAngleUnit.DEGREES : UnnormalizedAngleUnit.RADIANS; }
}
