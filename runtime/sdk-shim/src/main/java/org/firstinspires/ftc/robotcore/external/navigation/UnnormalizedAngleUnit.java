package org.firstinspires.ftc.robotcore.external.navigation;
public enum UnnormalizedAngleUnit {
    DEGREES, RADIANS;
    public double fromDegrees(double d) { return this == DEGREES ? d : Math.toRadians(d); }
    public double fromRadians(double r) { return this == RADIANS ? r : Math.toDegrees(r); }
    public double toDegrees(double v) { return this == DEGREES ? v : Math.toDegrees(v); }
    public double toRadians(double v) { return this == RADIANS ? v : Math.toRadians(v); }
    public AngleUnit getNormalized() { return this == DEGREES ? AngleUnit.DEGREES : AngleUnit.RADIANS; }
}
