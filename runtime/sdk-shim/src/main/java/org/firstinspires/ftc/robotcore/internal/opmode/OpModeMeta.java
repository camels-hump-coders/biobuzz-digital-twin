package org.firstinspires.ftc.robotcore.internal.opmode;

/** FTC SDK OpMode metadata (public fields, as the SDK declares them). */
public class OpModeMeta {
    public enum Flavor { AUTONOMOUS, TELEOP, SYSTEM }
    public enum Source { ANDROID_STUDIO, BLOCKLY, ONBOTJAVA, EXTERNAL_LIBRARY }
    public static final String DefaultGroup = "";
    public final Flavor flavor;
    public final String group;
    public final String name;
    public final String autoTransition;
    public final Source source;
    public final String systemOpModeBaseDisplayName;
    protected OpModeMeta(Flavor flavor, String group, String name, String autoTransition, Source source, String base) { this.flavor = flavor; this.group = group; this.name = name; this.autoTransition = autoTransition; this.source = source; this.systemOpModeBaseDisplayName = base; }
    public String getDisplayName() { return name; }
    @Override public String toString() { return name; }
    public static class Builder {
        private Flavor flavor = Flavor.TELEOP; private String group = DefaultGroup, name = "", autoTransition = null, base = null; private Source source = Source.ANDROID_STUDIO;
        public Builder() {}
        public Builder(OpModeMeta m) { flavor = m.flavor; group = m.group; name = m.name; autoTransition = m.autoTransition; source = m.source; base = m.systemOpModeBaseDisplayName; }
        public Builder setFlavor(Flavor f) { flavor = f; return this; }
        public Builder setGroup(String g) { group = g; return this; }
        public Builder setName(String n) { name = n; return this; }
        public Builder setAutoTransition(String a) { autoTransition = a; return this; }
        public Builder setSource(Source s) { source = s; return this; }
        public Builder setSystemOpModeBaseDisplayName(String b) { base = b; return this; }
        public OpModeMeta build() { return new OpModeMeta(flavor, group, name, autoTransition, source, base); }
    }
}
