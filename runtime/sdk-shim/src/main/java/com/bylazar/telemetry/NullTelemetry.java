package com.bylazar.telemetry;

import org.firstinspires.ftc.robotcore.external.Func;
import org.firstinspires.ftc.robotcore.external.Telemetry;

/** Telemetry that accepts everything and shows nothing. */
class NullTelemetry implements Telemetry {
    private final Item item = new Item() {
        @Override public String getCaption() { return ""; }
        @Override public Item setCaption(String c) { return this; }
        @Override public Item setValue(String f, Object... a) { return this; }
        @Override public Item setValue(Object v) { return this; }
        @Override public <T> Item setValue(Func<T> f) { return this; }
        @Override public <T> Item setValue(String f, Func<T> fn) { return this; }
        @Override public Item setRetained(Boolean r) { return this; }
        @Override public boolean isRetained() { return false; }
        @Override public Item addData(String c, String f, Object... a) { return this; }
        @Override public Item addData(String c, Object v) { return this; }
        @Override public <T> Item addData(String c, Func<T> f) { return this; }
        @Override public <T> Item addData(String c, String f, Func<T> fn) { return this; }
    };
    private final Line line = new Line() {
        @Override public Item addData(String c, String f, Object... a) { return item; }
        @Override public Item addData(String c, Object v) { return item; }
        @Override public <T> Item addData(String c, Func<T> f) { return item; }
        @Override public <T> Item addData(String c, String f, Func<T> fn) { return item; }
    };
    @Override public Item addData(String c, String f, Object... a) { return item; }
    @Override public Item addData(String c, Object v) { return item; }
    @Override public <T> Item addData(String c, Func<T> f) { return item; }
    @Override public <T> Item addData(String c, String f, Func<T> fn) { return item; }
    @Override public boolean removeItem(Item i) { return true; }
    @Override public void clear() {}
    @Override public void clearAll() {}
    @Override public Object addAction(Runnable a) { return a; }
    @Override public boolean removeAction(Object t) { return true; }
    @Override public void speak(String t) {}
    @Override public void speak(String t, String l, String c) {}
    @Override public boolean update() { return true; }
    @Override public Line addLine() { return line; }
    @Override public Line addLine(String c) { return line; }
    @Override public boolean removeLine(Line l) { return true; }
    @Override public boolean isAutoClear() { return true; }
    @Override public void setAutoClear(boolean b) {}
    @Override public int getMsTransmissionInterval() { return 250; }
    @Override public void setMsTransmissionInterval(int ms) {}
    @Override public String getItemSeparator() { return " | "; }
    @Override public void setItemSeparator(String s) {}
    @Override public String getCaptionValueSeparator() { return " : "; }
    @Override public void setCaptionValueSeparator(String s) {}
    @Override public void setDisplayFormat(DisplayFormat f) {}
    @Override public Log log() { return new Log() {
        @Override public int getCapacity() { return 9; } @Override public void setCapacity(int c) {}
        @Override public DisplayOrder getDisplayOrder() { return DisplayOrder.OLDEST_FIRST; } @Override public void setDisplayOrder(DisplayOrder o) {}
        @Override public void add(String e) {} @Override public void add(String f, Object... a) {} @Override public void clear() {}
    }; }
}
