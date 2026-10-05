package com.bylazar.panels.core;

/** Shadows Panels' TextHandler, which writes the dashboard URL onto the robot controller's screen. No screen here. */
public final class TextHandler {
    public static final TextHandler INSTANCE = new TextHandler();
    private TextHandler() {}
    public void injectText() {}
    public void updateText() {}
    public void removeText() {}
}
