package org.firstinspires.ftc.robotcore.external.navigation;
public enum DistanceUnit {
    METER(1.0), CM(0.01), MM(0.001), INCH(0.0254);
    public static final double infinity = Double.MAX_VALUE;
    public static final double mmPerInch = 25.4;
    private final double metersPerUnit;
    DistanceUnit(double m) { metersPerUnit = m; }
    public double fromMeters(double m) { return m == infinity ? infinity : m / metersPerUnit; }
    public double fromInches(double in) { return fromMeters(in * 0.0254); }
    public double fromCm(double cm) { return fromMeters(cm * 0.01); }
    public double fromMm(double mm) { return fromMeters(mm * 0.001); }
    public double fromUnit(DistanceUnit u, double v) { return fromMeters(u.toMeters(v)); }
    public double toMeters(double v) { return v == infinity ? infinity : v * metersPerUnit; }
    public double toInches(double v) { return INCH.fromMeters(toMeters(v)); }
    public double toCm(double v) { return CM.fromMeters(toMeters(v)); }
    public double toMm(double v) { return MM.fromMeters(toMeters(v)); }
    public String toString(double v) { return String.format("%.3f %s", v, name().toLowerCase()); }
}
