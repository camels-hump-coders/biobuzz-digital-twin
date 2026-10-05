package org.biobuzz.sim.host;

import org.firstinspires.ftc.robotcore.external.Func;
import org.firstinspires.ftc.robotcore.external.Telemetry;

import java.util.*;
import java.util.function.Consumer;

/** Telemetry that renders to text lines and hands them to the link on update(). */
public class SimTelemetry implements Telemetry {
    private final Consumer<List<String>> sink;
    private final List<Entry> entries = new ArrayList<>();
    private final List<String> logLines = new ArrayList<>();
    private boolean autoClear = true; private int interval = 250; private String itemSep = " | ", cvSep = " : ";
    private final List<Runnable> actions = new ArrayList<>();

    public SimTelemetry(Consumer<List<String>> sink) { this.sink = sink; }

    private abstract static class Entry { abstract String render(String cvSep, String itemSep); boolean retained; }
    private class ItemImpl extends Entry implements Item {
        String caption; Object value; Func<?> func; String format; final LineImpl line;
        ItemImpl(String caption, LineImpl line) { this.caption = caption; this.line = line; }
        String renderSelf(String cvSep) {
            Object v = func != null ? func.value() : value;
            String s = format != null ? String.format(Locale.US, format, v) : String.valueOf(v);
            return (caption == null || caption.isEmpty() ? "" : caption + cvSep) + s;
        }
        @Override String render(String cvSep, String itemSep) { return renderSelf(cvSep); }
        @Override public String getCaption() { return caption; }
        @Override public Item setCaption(String c) { caption = c; return this; }
        @Override public Item setValue(String f, Object... args) { format = null; value = String.format(Locale.US, f, args); func = null; return this; }
        @Override public Item setValue(Object v) { format = null; value = v; func = null; return this; }
        @Override public <T> Item setValue(Func<T> f) { func = f; format = null; return this; }
        @Override public <T> Item setValue(String f, Func<T> fn) { func = fn; format = f; return this; }
        @Override public Item setRetained(Boolean r) { retained = r != null && r; return this; }
        @Override public boolean isRetained() { return retained; }
        @Override public Item addData(String c, String f, Object... a) { return line != null ? line.addData(c, f, a) : SimTelemetry.this.addData(c, f, a); }
        @Override public Item addData(String c, Object v) { return line != null ? line.addData(c, v) : SimTelemetry.this.addData(c, v); }
        @Override public <T> Item addData(String c, Func<T> f) { return line != null ? line.addData(c, f) : SimTelemetry.this.addData(c, f); }
        @Override public <T> Item addData(String c, String f, Func<T> fn) { return line != null ? line.addData(c, f, fn) : SimTelemetry.this.addData(c, f, fn); }
    }
    private class LineImpl extends Entry implements Line {
        final String caption; final List<ItemImpl> items = new ArrayList<>();
        LineImpl(String caption) { this.caption = caption; }
        @Override String render(String cvSep, String itemSep) {
            StringBuilder sb = new StringBuilder(caption == null ? "" : caption);
            for (int i = 0; i < items.size(); i++) { if (i > 0 || sb.length() > 0) sb.append(itemSep); sb.append(items.get(i).renderSelf(cvSep)); }
            return sb.toString();
        }
        private ItemImpl mk(String c) { ItemImpl it = new ItemImpl(c, this); items.add(it); return it; }
        @Override public Item addData(String c, String f, Object... a) { return mk(c).setValue(f, a); }
        @Override public Item addData(String c, Object v) { return mk(c).setValue(v); }
        @Override public <T> Item addData(String c, Func<T> f) { return mk(c).setValue(f); }
        @Override public <T> Item addData(String c, String f, Func<T> fn) { return mk(c).setValue(f, fn); }
    }

    private ItemImpl mk(String caption) { ItemImpl it = new ItemImpl(caption, null); synchronized (entries) { entries.add(it); } return it; }
    @Override public Item addData(String c, String f, Object... a) { return mk(c).setValue(f, a); }
    @Override public Item addData(String c, Object v) { return mk(c).setValue(v); }
    @Override public <T> Item addData(String c, Func<T> f) { return mk(c).setValue(f); }
    @Override public <T> Item addData(String c, String f, Func<T> fn) { return mk(c).setValue(f, fn); }
    @Override public boolean removeItem(Item item) { synchronized (entries) { return entries.remove(item); } }
    @Override public void clear() { synchronized (entries) { entries.removeIf(e -> !e.retained); } }
    @Override public void clearAll() { synchronized (entries) { entries.clear(); } actions.clear(); }
    @Override public Object addAction(Runnable a) { actions.add(a); return a; }
    @Override public boolean removeAction(Object t) { return actions.remove(t); }
    @Override public void speak(String text) { logLines.add("[speak] " + text); }
    @Override public void speak(String text, String l, String c) { speak(text); }
    @Override public boolean update() {
        for (Runnable a : actions) a.run();
        List<String> out = new ArrayList<>();
        synchronized (entries) { for (Entry e : entries) out.add(e.render(cvSep, itemSep)); }
        synchronized (logLines) { if (!logLines.isEmpty()) { out.add("— log —"); out.addAll(logLines); } }
        sink.accept(out);
        if (autoClear) clear();
        return true;
    }
    @Override public Line addLine() { return addLine(""); }
    @Override public Line addLine(String c) { LineImpl l = new LineImpl(c); synchronized (entries) { entries.add(l); } return l; }
    @Override public boolean removeLine(Line l) { synchronized (entries) { return entries.remove(l); } }
    @Override public boolean isAutoClear() { return autoClear; }
    @Override public void setAutoClear(boolean b) { autoClear = b; }
    @Override public int getMsTransmissionInterval() { return interval; }
    @Override public void setMsTransmissionInterval(int ms) { interval = ms; }
    @Override public String getItemSeparator() { return itemSep; }
    @Override public void setItemSeparator(String s) { itemSep = s; }
    @Override public String getCaptionValueSeparator() { return cvSep; }
    @Override public void setCaptionValueSeparator(String s) { cvSep = s; }
    @Override public void setDisplayFormat(DisplayFormat f) {}
    @Override public Log log() {
        return new Log() {
            int cap = 9; DisplayOrder order = DisplayOrder.OLDEST_FIRST;
            @Override public int getCapacity() { return cap; }
            @Override public void setCapacity(int c) { cap = c; }
            @Override public DisplayOrder getDisplayOrder() { return order; }
            @Override public void setDisplayOrder(DisplayOrder o) { order = o; }
            @Override public void add(String e) { synchronized (logLines) { logLines.add(e); while (logLines.size() > cap) logLines.remove(0); } }
            @Override public void add(String f, Object... a) { add(String.format(Locale.US, f, a)); }
            @Override public void clear() { synchronized (logLines) { logLines.clear(); } }
        };
    }
}
