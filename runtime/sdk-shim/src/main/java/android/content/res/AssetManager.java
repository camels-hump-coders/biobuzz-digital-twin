package android.content.res;

import org.biobuzz.sim.shim.SimHooks;
import org.json.JSONObject;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/** Serves files from the directories in the sim.assets system property (comma separated). */
public class AssetManager {
    private final List<File> roots = new ArrayList<>();
    public AssetManager() {
        String p = System.getProperty("sim.assets", "");
        for (String s : p.split(",")) if (!s.isBlank()) roots.add(new File(s.trim()));
    }
    /**
     * JSON assets can be adjusted for the simulator without touching the competition files:
     * 1. overrides edited in the browser panel ("TeamCode settings") are merged in by dotted key, e.g. aim.shotRangeIn;
     * 2. if `foo.sim.json` exists next to `foo.json`, it is served instead of the original (file-based alternative).
     */
    public InputStream open(String path) throws IOException {
        File src = null;
        if (path.endsWith(".json")) {
            String alt = path.substring(0, path.length() - 5) + ".sim.json";
            for (File r : roots) { File f = new File(r, alt); if (f.isFile()) { src = f; break; } }
        }
        if (src == null) for (File r : roots) { File f = new File(r, path); if (f.isFile()) { src = f; break; } }
        if (src == null) throw new FileNotFoundException("asset not found: " + path + " (searched " + roots + "; set sim.assets or run via pnpm sim)");
        JSONObject ov = path.endsWith(".json") ? SimHooks.assetOverrides(path.replace('\\', '/')) : null;
        if (ov == null || ov.isEmpty()) return new FileInputStream(src);
        String text = Files.readString(src.toPath(), StandardCharsets.UTF_8);
        try {
            JSONObject json = new JSONObject(text);
            for (String key : ov.keySet()) put(json, key.split("\\."), ov.get(key));
            return new ByteArrayInputStream(json.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (RuntimeException e) {
            System.err.println("sim: could not apply overrides to asset " + path + ": " + e);
            return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));
        }
    }
    private static void put(JSONObject o, String[] parts, Object value) {
        for (int i = 0; i < parts.length - 1; i++) {
            Object next = o.opt(parts[i]);
            if (!(next instanceof JSONObject)) { next = new JSONObject(); o.put(parts[i], next); }
            o = (JSONObject) next;
        }
        o.put(parts[parts.length - 1], value == null ? JSONObject.NULL : value);
    }
    public InputStream open(String path, int mode) throws IOException { return open(path); }
    public String[] list(String path) {
        for (File r : roots) { File d = new File(r, path); if (d.isDirectory()) { String[] l = d.list(); return l == null ? new String[0] : l; } }
        return new String[0];
    }
}
