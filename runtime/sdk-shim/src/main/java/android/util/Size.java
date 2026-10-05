package android.util;
public final class Size {
    private final int w, h;
    public Size(int width, int height) { w = width; h = height; }
    public int getWidth() { return w; }
    public int getHeight() { return h; }
    @Override public String toString() { return w + "x" + h; }
    @Override public boolean equals(Object o) { return o instanceof Size && ((Size) o).w == w && ((Size) o).h == h; }
    @Override public int hashCode() { return w * 31 + h; }
}
