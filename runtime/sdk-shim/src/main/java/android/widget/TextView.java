package android.widget;

import android.content.Context;
import android.graphics.Typeface;
import android.view.View;

/** Desktop stand-in. */
public class TextView extends View {
    private CharSequence text = "";
    public TextView(Context c) {}
    public void setText(CharSequence t) { text = t; }
    public CharSequence getText() { return text; }
    public void setTextColor(int c) {}
    public void setTypeface(Typeface t) {}
    public void setTextSize(float s) {}
    public void setPadding(int l, int t, int r, int b) {}
}
