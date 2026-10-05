package org.firstinspires.ftc.robotcore.external.navigation;
public class Quaternion {
    public float w = 1, x, y, z; public long acquisitionTime;
    public Quaternion() {}
    public Quaternion(float w, float x, float y, float z, long t) { this.w = w; this.x = x; this.y = y; this.z = z; acquisitionTime = t; }
    public static Quaternion identityQuaternion() { return new Quaternion(); }
    public float magnitude() { return (float) Math.sqrt(w * w + x * x + y * y + z * z); }
    public Quaternion normalized() { float m = magnitude(); return new Quaternion(w / m, x / m, y / m, z / m, acquisitionTime); }
}
