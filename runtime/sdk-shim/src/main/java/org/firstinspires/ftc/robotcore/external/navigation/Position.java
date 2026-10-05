package org.firstinspires.ftc.robotcore.external.navigation;
public class Position {
    public DistanceUnit unit = DistanceUnit.METER; public double x, y, z; public long acquisitionTime;
    public Position() {}
    public Position(DistanceUnit u, double x, double y, double z, long t) { unit = u; this.x = x; this.y = y; this.z = z; acquisitionTime = t; }
    public Position toUnit(DistanceUnit u) { return new Position(u, u.fromUnit(unit, x), u.fromUnit(unit, y), u.fromUnit(unit, z), acquisitionTime); }
    @Override public String toString() { return String.format("(%.2f, %.2f, %.2f) %s", x, y, z, unit); }
}
