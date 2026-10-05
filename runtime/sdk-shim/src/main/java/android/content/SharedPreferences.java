package android.content;

import java.io.*;
import java.util.*;

/** Android's SharedPreferences contract (an interface, as libraries such as Panels expect), backed by a .properties file. */
public interface SharedPreferences {
    String getString(String key, String def);
    int getInt(String key, int def);
    long getLong(String key, long def);
    float getFloat(String key, float def);
    boolean getBoolean(String key, boolean def);
    boolean contains(String key);
    Map<String, ?> getAll();
    Editor edit();
    interface OnSharedPreferenceChangeListener { void onSharedPreferenceChanged(SharedPreferences p, String key); }
    default void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) {}
    default void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) {}

    interface Editor {
        Editor putString(String k, String v);
        Editor putInt(String k, int v);
        Editor putLong(String k, long v);
        Editor putFloat(String k, float v);
        Editor putBoolean(String k, boolean v);
        Editor putStringSet(String k, Set<String> v);
        Editor remove(String k);
        Editor clear();
        boolean commit();
        void apply();
    }

    static SharedPreferences open(String name) { return FilePreferences.open(name); }

    /** The one implementation: sim.prefs/<name>.properties */
    final class FilePreferences implements SharedPreferences {
        private static final Map<String, FilePreferences> OPEN = new HashMap<>();
        private final File file; private final Properties props = new Properties();
        static synchronized SharedPreferences open(String name) {
            return OPEN.computeIfAbsent(name, n -> new FilePreferences(new File(System.getProperty("sim.prefs", ".sim-prefs"), n + ".properties")));
        }
        private FilePreferences(File file) {
            this.file = file;
            if (file.exists()) try (InputStream in = new FileInputStream(file)) { props.load(in); } catch (IOException ignored) {}
        }
        @Override public String getString(String key, String def) { return props.getProperty(key, def); }
        @Override public int getInt(String key, int def) { String v = props.getProperty(key); return v == null ? def : Integer.parseInt(v); }
        @Override public long getLong(String key, long def) { String v = props.getProperty(key); return v == null ? def : Long.parseLong(v); }
        @Override public float getFloat(String key, float def) { String v = props.getProperty(key); return v == null ? def : Float.parseFloat(v); }
        @Override public boolean getBoolean(String key, boolean def) { String v = props.getProperty(key); return v == null ? def : Boolean.parseBoolean(v); }
        @Override public boolean contains(String key) { return props.containsKey(key); }
        @Override public Map<String, ?> getAll() { Map<String, Object> m = new HashMap<>(); for (String k : props.stringPropertyNames()) m.put(k, props.getProperty(k)); return m; }
        @Override public Editor edit() { return new FileEditor(); }

        private final class FileEditor implements Editor {
            private final Map<String, String> pending = new LinkedHashMap<>(); private boolean clear;
            @Override public Editor putString(String k, String v) { pending.put(k, v); return this; }
            @Override public Editor putInt(String k, int v) { pending.put(k, Integer.toString(v)); return this; }
            @Override public Editor putLong(String k, long v) { pending.put(k, Long.toString(v)); return this; }
            @Override public Editor putFloat(String k, float v) { pending.put(k, Float.toString(v)); return this; }
            @Override public Editor putBoolean(String k, boolean v) { pending.put(k, Boolean.toString(v)); return this; }
            @Override public Editor putStringSet(String k, Set<String> v) { pending.put(k, String.join("\n", v)); return this; }
            @Override public Editor remove(String k) { pending.put(k, null); return this; }
            @Override public Editor clear() { clear = true; return this; }
            @Override public boolean commit() {
                synchronized (FilePreferences.this) {
                    if (clear) props.clear();
                    for (Map.Entry<String, String> e : pending.entrySet()) { if (e.getValue() == null) props.remove(e.getKey()); else props.setProperty(e.getKey(), e.getValue()); }
                    file.getParentFile().mkdirs();
                    try (OutputStream out = new FileOutputStream(file)) { props.store(out, "BIOBUZZ sim SharedPreferences"); return true; } catch (IOException e) { return false; }
                }
            }
            @Override public void apply() { commit(); }
        }
    }
}
