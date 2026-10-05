package org.firstinspires.ftc.vision.apriltag;
import org.firstinspires.ftc.robotcore.external.navigation.*;
/** BIOBUZZ tag library. Field positions are approximate centres of the clusters at match start, in inches, FTC field frame (origin at centre, +Y toward the scoring side). */
public final class AprilTagGameDatabase {
    private AprilTagGameDatabase() {}
    public static AprilTagLibrary getCurrentGameTagLibrary() { return getBiobuzzTagLibrary(); }
    public static AprilTagLibrary getBiobuzzTagLibrary() {
        AprilTagLibrary.Builder b = new AprilTagLibrary.Builder();
        double size = 3.25;
        // red hive x = -12.75 in, blue +12.75 in; clusters on cell undersides ~15.4 in from the pivot along the arm
        int[][] clusters = { {33,32,31,30}, {34,35,36,37}, {38,39,40,41}, {45,44,43,42} };
        double[][] centre = { {-12.75, 15.4}, {-12.75, -15.4}, {12.75, -15.4}, {12.75, 15.4} };
        String[] names = { "RedScoring", "RedAudience", "BlueAudience", "BlueScoring" };
        for (int c = 0; c < 4; c++) for (int i = 0; i < 4; i++) {
            double x = centre[c][0] + (i - 1.5) * 5.0;
            b.addTag(clusters[c][i], names[c] + "_" + clusters[c][i], size, new VectorF((float) x, (float) centre[c][1], 40f), DistanceUnit.INCH, Quaternion.identityQuaternion());
        }
        return b.build();
    }
    public static AprilTagLibrary getSampleTagLibrary() { return getBiobuzzTagLibrary(); }
}
