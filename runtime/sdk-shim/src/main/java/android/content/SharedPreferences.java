package android.content;

import java.io.*;
import java.util.*;

/** File-backed key/value store with the Android SharedPreferences shape. */
public class SharedPreferences {
    private static final Map<String, SharedPreferences> OPEN = new HashMap<>();
    private final File file; private final Properties props = new Properties();

    static synchronized SharedPreferences open(String name) {
        return OPEN.computeIfAbsent(name, n -> new SharedPreferences(new File(System.getProperty("sim.prefs", ".sim-prefs"), n + ".properties")));
    }
    private SharedPreferences(File file) {
        this.file = file;
        if (file.exists()) try (InputStream in = new FileInputStream(file)) { props.load(in); } catch (IOException ignored) {}
    }
    public String getString(String key, String def) { return props.getProperty(key, def); }
    public int getInt(String key, int def) { String v = props.getProperty(key); return v == null ? def : Integer.parseInt(v); }
    public long getLong(String key, long def) { String v = props.getProperty(key); return v == null ? def : Long.parseLong(v); }
    public float getFloat(String key, float def) { String v = props.getProperty(key); return v == null ? def : Float.parseFloat(v); }
    public boolean getBoolean(String key, boolean def) { String v = props.getProperty(key); return v == null ? def : Boolean.parseBoolean(v); }
    public boolean contains(String key) { return props.containsKey(key); }
    public Map<String, ?> getAll() { Map<String, Object> m = new HashMap<>(); for (String k : props.stringPropertyNames()) m.put(k, props.getProperty(k)); return m; }
    public Editor edit() { return new Editor(); }
    public interface OnSharedPreferenceChangeListener { void onSharedPreferenceChanged(SharedPreferences p, String key); }
    public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) {}
    public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) {}

    public class Editor {
        private final Map<String, String> pending = new LinkedHashMap<>(); private boolean clear;
        public Editor putString(String k, String v) { pending.put(k, v); return this; }
        public Editor putInt(String k, int v) { pending.put(k, Integer.toString(v)); return this; }
        public Editor putLong(String k, long v) { pending.put(k, Long.toString(v)); return this; }
        public Editor putFloat(String k, float v) { pending.put(k, Float.toString(v)); return this; }
        public Editor putBoolean(String k, boolean v) { pending.put(k, Boolean.toString(v)); return this; }
        public Editor remove(String k) { pending.put(k, null); return this; }
        public Editor clear() { clear = true; return this; }
        public boolean commit() {
            synchronized (SharedPreferences.this) {
                if (clear) props.clear();
                for (Map.Entry<String, String> e : pending.entrySet()) { if (e.getValue() == null) props.remove(e.getKey()); else props.setProperty(e.getKey(), e.getValue()); }
                file.getParentFile().mkdirs();
                try (OutputStream out = new FileOutputStream(file)) { props.store(out, "BIOBUZZ sim SharedPreferences"); return true; } catch (IOException e) { return false; }
            }
        }
        public void apply() { commit(); }
    }
}
