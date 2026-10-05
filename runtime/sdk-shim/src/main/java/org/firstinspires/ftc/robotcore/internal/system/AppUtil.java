package org.firstinspires.ftc.robotcore.internal.system;

import android.app.Activity;

/** Desktop stand-in for the SDK's application utilities: one fake activity, UI work runs inline. */
public class AppUtil {
    private static final AppUtil INSTANCE = new AppUtil();
    private final Activity activity = new Activity();
    public static AppUtil getInstance() { return INSTANCE; }
    public static AppUtil getDefContext() { return INSTANCE; }
    public Activity getActivity() { return activity; }
    public Activity getRootActivity() { return activity; }
    public android.content.Context getApplication() { return activity; }
    public void runOnUiThread(Runnable r) { r.run(); }
    public void showToast(Object uiContext, String msg) { System.out.println("[toast] " + msg); }
}
