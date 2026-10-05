package android.view;

/** Desktop stand-in. */
public class ViewGroup extends View {
    public static class LayoutParams { public static final int MATCH_PARENT = -1, WRAP_CONTENT = -2; public int width, height; public LayoutParams(int w, int h) { width = w; height = h; } }
    public int getChildCount() { return 0; }
    public View getChildAt(int i) { return null; }
    public void addView(View v, int index) {}
    public void addView(View v) {}
    public void removeView(View v) {}
}
