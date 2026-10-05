package org.firstinspires.ftc.vision.apriltag;

/** SDK 12: one detection per visible cluster, regardless of how many of its tags were seen. */
public class AprilTagClusterDetection extends AprilTagDetection {
    public AprilTagClusterMetadata metadata;
    /** percent of the cluster's tags that were detected, 0..100 */
    public int percentClusterFound;
    /** the individual tags that contributed */
    public java.util.List<AprilTagSingleDetection> tagsDetected = new java.util.ArrayList<>();
}
