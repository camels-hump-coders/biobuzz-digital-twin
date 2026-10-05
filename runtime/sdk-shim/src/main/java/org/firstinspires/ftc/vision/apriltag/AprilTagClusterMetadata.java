package org.firstinspires.ftc.vision.apriltag;

import org.firstinspires.ftc.robotcore.external.navigation.DistanceUnit;
import org.firstinspires.ftc.robotcore.external.navigation.Quaternion;
import org.firstinspires.ftc.robotcore.external.navigation.VectorF;

/** A season-defined group of tags detected as one target. Names start with R or B for the alliance. */
public class AprilTagClusterMetadata {
    public final String name;
    public final int[] tagIds;
    public final VectorF fieldPosition;
    public final DistanceUnit distanceUnit;
    public final Quaternion fieldOrientation;
    public AprilTagClusterMetadata(String name, int[] tagIds, VectorF fieldPosition, DistanceUnit unit, Quaternion fieldOrientation) {
        this.name = name; this.tagIds = tagIds; this.fieldPosition = fieldPosition; this.distanceUnit = unit; this.fieldOrientation = fieldOrientation;
    }
}
