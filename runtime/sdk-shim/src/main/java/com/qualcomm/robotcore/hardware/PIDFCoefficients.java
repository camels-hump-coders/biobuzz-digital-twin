package com.qualcomm.robotcore.hardware;
public class PIDFCoefficients {
    public double p, i, d, f;
    public PIDFCoefficients() {}
    public PIDFCoefficients(double p, double i, double d, double f) { this.p = p; this.i = i; this.d = d; this.f = f; }
    @Override public String toString() { return String.format("p=%.3f i=%.3f d=%.3f f=%.3f", p, i, d, f); }
}
