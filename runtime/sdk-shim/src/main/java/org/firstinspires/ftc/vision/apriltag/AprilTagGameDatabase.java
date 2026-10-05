package org.firstinspires.ftc.vision.apriltag;
import org.firstinspires.ftc.robotcore.external.navigation.*;
/** BIOBUZZ tag library. Field positions are approximate centres of the clusters at match start, in inches, FTC field frame (origin at centre, +Y toward the scoring side). */
public final class AprilTagGameDatabase {
    private AprilTagGameDatabase() {}
    public static AprilTagLibrary getCurrentGameTagLibrary() { return getBiobuzzTagLibrary(); }
    public static AprilTagLibrary getBiobuzzTagLibrary() {
        AprilTagLibrary.Builder b = new AprilTagLibrary.Builder();
        double size = 3.25;
        // Red hive at x = -12.75 in, blue at +12.75 in (field frame: +Y toward the scoring side). The cluster centre sits
        // 7.19 in behind the cell opening, i.e. 14.27 in from the pivot along the 30-degree arm: 12.36 in horizontally from
        // the hive centre, and at match start 49.7 in up for the raised cell / 35.7 in for the lowered one.
        // Tag centres are at -6.5, -2.75, +2.75, +6.5 in across the cluster (Competition Manual Fig 9-15).
        int[][] clusters = { {33,32,31,30}, {34,35,36,37}, {38,39,40,41}, {45,44,43,42} };
        double[][] centre = { {-12.75, 12.36, 35.7}, {-12.75, -12.36, 49.7}, {12.75, -12.36, 35.7}, {12.75, 12.36, 49.7} };
        double[] offsets = { -6.5, -2.75, 2.75, 6.5 };
        String[] names = { "RedScoring", "RedAudience", "BlueAudience", "BlueScoring" };
        for (int c = 0; c < 4; c++) for (int i = 0; i < 4; i++) {
            double x = centre[c][0] + offsets[i];
            b.addTag(clusters[c][i], names[c] + "_" + clusters[c][i], size, new VectorF((float) x, (float) centre[c][1], (float) centre[c][2]), DistanceUnit.INCH, Quaternion.identityQuaternion());
        }
        return b.build();
    }
    public static AprilTagLibrary getSampleTagLibrary() { return getBiobuzzTagLibrary(); }

    private static final AprilTagClusterMetadata[] CLUSTERS = {
        new AprilTagClusterMetadata("RedScoring", new int[] {33, 32, 31, 30}, new VectorF(-12.75f, 12.36f, 35.7f), DistanceUnit.INCH, Quaternion.identityQuaternion()),
        new AprilTagClusterMetadata("RedAudience", new int[] {34, 35, 36, 37}, new VectorF(-12.75f, -12.36f, 49.7f), DistanceUnit.INCH, Quaternion.identityQuaternion()),
        new AprilTagClusterMetadata("BlueAudience", new int[] {38, 39, 40, 41}, new VectorF(12.75f, -12.36f, 35.7f), DistanceUnit.INCH, Quaternion.identityQuaternion()),
        new AprilTagClusterMetadata("BlueScoring", new int[] {45, 44, 43, 42}, new VectorF(12.75f, 12.36f, 49.7f), DistanceUnit.INCH, Quaternion.identityQuaternion()),
    };
    /** The four BIOBUZZ clusters (SDK 12). */
    public static AprilTagClusterMetadata[] getBiobuzzClusters() { return CLUSTERS.clone(); }
    public static AprilTagClusterMetadata clusterFor(int tagId) {
        for (AprilTagClusterMetadata c : CLUSTERS) for (int id : c.tagIds) if (id == tagId) return c;
        return null;
    }
}
