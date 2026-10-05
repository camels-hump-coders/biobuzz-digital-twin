package org.firstinspires.ftc.robotcore.external.navigation;
public class Pose3D {
    private final Position position; private final YawPitchRollAngles orientation;
    public Pose3D(Position p, YawPitchRollAngles o) { position = p; orientation = o; }
    public Position getPosition() { return position; }
    public YawPitchRollAngles getOrientation() { return orientation; }
    @Override public String toString() { return position + " " + orientation; }
}
