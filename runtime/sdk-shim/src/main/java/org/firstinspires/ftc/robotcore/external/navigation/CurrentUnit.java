package org.firstinspires.ftc.robotcore.external.navigation;
public enum CurrentUnit { AMPS, MILLIAMPS; public double toAmps(double v) { return this == AMPS ? v : v / 1000; } public double convert(double v, CurrentUnit from) { return from == this ? v : (this == AMPS ? v / 1000 : v * 1000); } }
