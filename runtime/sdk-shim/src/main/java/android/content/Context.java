package android.content;

import android.content.res.AssetManager;
import java.io.File;

/** Desktop stand-in for the Android Context handed out as hardwareMap.appContext.
 * Assets come from the TeamCode module's src/main/assets (system property sim.assets, comma separated dirs);
 * SharedPreferences persist as .properties files under sim.prefs (default runtime/.sim-prefs). */
public class Context {
    public static final int MODE_PRIVATE = 0;
    public static final int MODE_WORLD_READABLE = 1;
    public static final int MODE_WORLD_WRITEABLE = 2;
    public static final int MODE_APPEND = 32768;
    private final AssetManager assets = new AssetManager();
    private final File filesDir;

    public Context() {
        filesDir = new File(System.getProperty("sim.prefs", ".sim-prefs"), "files");
        filesDir.mkdirs();
    }
    public AssetManager getAssets() { return assets; }
    public SharedPreferences getSharedPreferences(String name, int mode) { return SharedPreferences.open(name); }
    public File getFilesDir() { return filesDir; }
    public File getCacheDir() { File f = new File(filesDir.getParentFile(), "cache"); f.mkdirs(); return f; }
    public File getExternalFilesDir(String type) { File f = new File(filesDir, type == null ? "external" : type); f.mkdirs(); return f; }
    public File getDatabasePath(String name) { File d = new File(filesDir.getParentFile(), "databases"); d.mkdirs(); return new File(d, name); }
    public Context getApplicationContext() { return this; }
    public String getPackageName() { return "org.biobuzz.sim"; }
    public Object getSystemService(String name) { return null; }
    /** Panels passes this to its class scanner; the desktop scanner reads the classpath instead. */
    public String getPackageCodePath() { return System.getProperty("java.class.path", ""); }
    public android.content.res.Resources getResources() { return new android.content.res.Resources(); }
}
