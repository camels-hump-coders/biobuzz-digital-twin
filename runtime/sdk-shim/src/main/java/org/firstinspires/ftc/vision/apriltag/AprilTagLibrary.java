package org.firstinspires.ftc.vision.apriltag;
import java.util.*;
public class AprilTagLibrary {
    private final Map<Integer, AprilTagMetadata> tags = new LinkedHashMap<>();
    public AprilTagMetadata lookupTag(int id) { return tags.get(id); }
    public AprilTagMetadata[] getAllTags() { return tags.values().toArray(new AprilTagMetadata[0]); }
    public static class Builder {
        private final AprilTagLibrary lib = new AprilTagLibrary(); private boolean allowOverwrite = false;
        public Builder addTag(AprilTagMetadata m) { if (!allowOverwrite && lib.tags.containsKey(m.id)) throw new IllegalArgumentException("duplicate tag " + m.id); lib.tags.put(m.id, m); return this; }
        public Builder addTag(int id, String name, double size, org.firstinspires.ftc.robotcore.external.navigation.VectorF pos, org.firstinspires.ftc.robotcore.external.navigation.DistanceUnit unit, org.firstinspires.ftc.robotcore.external.navigation.Quaternion q) { return addTag(new AprilTagMetadata(id, name, size, pos, unit, q)); }
        public Builder addTag(int id, String name, double size, org.firstinspires.ftc.robotcore.external.navigation.DistanceUnit unit) { return addTag(new AprilTagMetadata(id, name, size, unit)); }
        public Builder addTags(AprilTagLibrary other) { for (AprilTagMetadata m : other.getAllTags()) addTag(m); return this; }
        public Builder setAllowOverwrite(boolean b) { allowOverwrite = b; return this; }
        public AprilTagLibrary build() { return lib; }
    }
}
