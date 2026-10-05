package org.firstinspires.ftc.vision.apriltag;
import org.firstinspires.ftc.robotcore.external.navigation.*;
public class AprilTagMetadata {
    public final int id; public final String name; public final double tagsize; public final DistanceUnit distanceUnit; public final VectorF fieldPosition; public final Quaternion fieldOrientation;
    public AprilTagMetadata(int id, String name, double tagsize, VectorF fieldPosition, DistanceUnit unit, Quaternion fieldOrientation) { this.id = id; this.name = name; this.tagsize = tagsize; this.fieldPosition = fieldPosition; this.distanceUnit = unit; this.fieldOrientation = fieldOrientation; }
    public AprilTagMetadata(int id, String name, double tagsize, DistanceUnit unit) { this(id, name, tagsize, new VectorF(0, 0, 0), unit, Quaternion.identityQuaternion()); }
}
