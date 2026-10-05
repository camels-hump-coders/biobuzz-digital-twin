package android.content.res;

import java.io.*;
import java.util.ArrayList;
import java.util.List;

/** Serves files from the directories in the sim.assets system property (comma separated). */
public class AssetManager {
    private final List<File> roots = new ArrayList<>();
    public AssetManager() {
        String p = System.getProperty("sim.assets", "");
        for (String s : p.split(",")) if (!s.isBlank()) roots.add(new File(s.trim()));
    }
    /** Sim override: when `foo.json` is requested and `foo.sim.json` exists next to it, serve the .sim.json instead.
     * Lets a team keep competition settings in assets while the simulator uses relaxed ones. */
    public InputStream open(String path) throws IOException {
        if (path.endsWith(".json")) {
            String alt = path.substring(0, path.length() - 5) + ".sim.json";
            for (File r : roots) { File f = new File(r, alt); if (f.isFile()) return new FileInputStream(f); }
        }
        for (File r : roots) { File f = new File(r, path); if (f.isFile()) return new FileInputStream(f); }
        throw new FileNotFoundException("asset not found: " + path + " (searched " + roots + "; set sim.assets or run via pnpm sim)");
    }
    public InputStream open(String path, int mode) throws IOException { return open(path); }
    public String[] list(String path) {
        for (File r : roots) { File d = new File(r, path); if (d.isDirectory()) { String[] l = d.list(); return l == null ? new String[0] : l; } }
        return new String[0];
    }
}
