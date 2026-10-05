package org.firstinspires.ftc.robotcore.external.navigation;
public class AngularVelocity {
    public AngleUnit unit = AngleUnit.DEGREES; public float xRotationRate, yRotationRate, zRotationRate; public long acquisitionTime;
    public AngularVelocity() {}
    public AngularVelocity(AngleUnit u, float x, float y, float z, long t) { unit = u; xRotationRate = x; yRotationRate = y; zRotationRate = z; acquisitionTime = t; }
    public AngularVelocity toAngleUnit(AngleUnit u) { return new AngularVelocity(u, (float) u.fromUnit(unit, xRotationRate), (float) u.fromUnit(unit, yRotationRate), (float) u.fromUnit(unit, zRotationRate), acquisitionTime); }
}
