package android.content.res;

/** Desktop stand-in: no Android resources exist, every lookup fails softly. */
public class Resources {
    public int getIdentifier(String name, String defType, String defPackage) { return 0; }
    public float getDimension(int id) { return 0f; }
    public String getString(int id) { return ""; }
}
