package org.firstinspires.ftc.vision.apriltag;
import org.firstinspires.ftc.robotcore.external.navigation.*;
public class AprilTagMetadata {
    public final int id; public final String name; public final double tagsize; public final DistanceUnit distanceUnit; public final VectorF fieldPosition; public final Quaternion fieldOrientation;
    /** SDK 12: the season cluster this tag belongs to, set only by the game database; a tag added through the Builder has none and is reported as a single detection */
    public final AprilTagClusterMetadata cluster;
    public AprilTagMetadata(int id, String name, double tagsize, VectorF fieldPosition, DistanceUnit unit, Quaternion fieldOrientation) { this(id, name, tagsize, fieldPosition, unit, fieldOrientation, null); }
    AprilTagMetadata(int id, String name, double tagsize, VectorF fieldPosition, DistanceUnit unit, Quaternion fieldOrientation, AprilTagClusterMetadata cluster) { this.id = id; this.name = name; this.tagsize = tagsize; this.fieldPosition = fieldPosition; this.distanceUnit = unit; this.fieldOrientation = fieldOrientation; this.cluster = cluster; }
    public AprilTagMetadata(int id, String name, double tagsize, DistanceUnit unit) { this(id, name, tagsize, new VectorF(0, 0, 0), unit, Quaternion.identityQuaternion()); }
}
