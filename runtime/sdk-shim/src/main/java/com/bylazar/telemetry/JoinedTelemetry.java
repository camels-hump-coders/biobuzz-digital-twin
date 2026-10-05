package com.bylazar.telemetry;

import org.firstinspires.ftc.robotcore.external.Func;
import org.firstinspires.ftc.robotcore.external.Telemetry;

/** Writes to several Telemetry sinks at once; reads come from the first (the Driver Station one). */
public class JoinedTelemetry implements Telemetry {
    private final Telemetry[] all; private final Telemetry first;
    public JoinedTelemetry(Telemetry... telemetries) { all = telemetries; first = telemetries[0]; }
    @Override public Item addData(String c, String f, Object... a) { Item r = first.addData(c, f, a); for (int i = 1; i < all.length; i++) all[i].addData(c, f, a); return r; }
    @Override public Item addData(String c, Object v) { Item r = first.addData(c, v); for (int i = 1; i < all.length; i++) all[i].addData(c, v); return r; }
    @Override public <T> Item addData(String c, Func<T> f) { Item r = first.addData(c, f); for (int i = 1; i < all.length; i++) all[i].addData(c, f); return r; }
    @Override public <T> Item addData(String c, String f, Func<T> fn) { Item r = first.addData(c, f, fn); for (int i = 1; i < all.length; i++) all[i].addData(c, f, fn); return r; }
    @Override public boolean removeItem(Item item) { return first.removeItem(item); }
    @Override public void clear() { for (Telemetry t : all) t.clear(); }
    @Override public void clearAll() { for (Telemetry t : all) t.clearAll(); }
    @Override public Object addAction(Runnable a) { return first.addAction(a); }
    @Override public boolean removeAction(Object t) { return first.removeAction(t); }
    @Override public void speak(String text) { first.speak(text); }
    @Override public void speak(String text, String l, String c) { first.speak(text, l, c); }
    @Override public boolean update() { boolean r = true; for (Telemetry t : all) r &= t.update(); return r; }
    @Override public Line addLine() { Line r = first.addLine(); for (int i = 1; i < all.length; i++) all[i].addLine(); return r; }
    @Override public Line addLine(String c) { Line r = first.addLine(c); for (int i = 1; i < all.length; i++) all[i].addLine(c); return r; }
    @Override public boolean removeLine(Line l) { return first.removeLine(l); }
    @Override public boolean isAutoClear() { return first.isAutoClear(); }
    @Override public void setAutoClear(boolean b) { for (Telemetry t : all) t.setAutoClear(b); }
    @Override public int getMsTransmissionInterval() { return first.getMsTransmissionInterval(); }
    @Override public void setMsTransmissionInterval(int ms) { for (Telemetry t : all) t.setMsTransmissionInterval(ms); }
    @Override public String getItemSeparator() { return first.getItemSeparator(); }
    @Override public void setItemSeparator(String s) { for (Telemetry t : all) t.setItemSeparator(s); }
    @Override public String getCaptionValueSeparator() { return first.getCaptionValueSeparator(); }
    @Override public void setCaptionValueSeparator(String s) { for (Telemetry t : all) t.setCaptionValueSeparator(s); }
    @Override public void setDisplayFormat(DisplayFormat f) { for (Telemetry t : all) t.setDisplayFormat(f); }
    @Override public Log log() { return first.log(); }
}
