package org.firstinspires.ftc.robotcore.external.navigation;
public class VectorF {
    private final float[] data;
    public VectorF(float... v) { data = v.clone(); }
    public float get(int i) { return data[i]; }
    public float[] getData() { return data; }
    public int length() { return data.length; }
    public float magnitude() { double s = 0; for (float f : data) s += f * f; return (float) Math.sqrt(s); }
    @Override public String toString() { return java.util.Arrays.toString(data); }
}
