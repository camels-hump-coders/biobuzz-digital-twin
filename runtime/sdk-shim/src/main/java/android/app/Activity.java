package android.app;

import android.content.Context;
import android.content.res.Resources;
import android.view.View;

/** Desktop stand-in: there is no screen; UI calls are no-ops. */
public class Activity extends Context {
    private final Resources resources = new Resources();
    public Resources getResources() { return resources; }
    public View findViewById(int id) { return null; }
    public void runOnUiThread(Runnable r) { r.run(); }
}
