package org.firstinspires.ftc.robotcore.external.navigation;
public class Orientation {
    public AxesReference axesReference; public AxesOrder axesOrder; public AngleUnit angleUnit;
    public float firstAngle, secondAngle, thirdAngle; public long acquisitionTime;
    public Orientation() { this(AxesReference.EXTRINSIC, AxesOrder.XYZ, AngleUnit.RADIANS, 0, 0, 0, 0); }
    public Orientation(AxesReference r, AxesOrder o, AngleUnit u, float a, float b, float c, long t) { axesReference = r; axesOrder = o; angleUnit = u; firstAngle = a; secondAngle = b; thirdAngle = c; acquisitionTime = t; }
    public Orientation toAngleUnit(AngleUnit u) { return new Orientation(axesReference, axesOrder, u, (float) u.fromUnit(angleUnit, firstAngle), (float) u.fromUnit(angleUnit, secondAngle), (float) u.fromUnit(angleUnit, thirdAngle), acquisitionTime); }
    @Override public String toString() { return String.format("{%s %s %.1f %.1f %.1f}", axesReference, axesOrder, firstAngle, secondAngle, thirdAngle); }
}
