package android.widget;

import android.view.ViewGroup;

/** Desktop stand-in. */
public class LinearLayout extends ViewGroup {
    public static class LayoutParams extends ViewGroup.LayoutParams { public LayoutParams(int w, int h) { super(w, h); } public void setMargins(int l, int t, int r, int b) {} }
}
