package android.graphics;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;

/** android.graphics.BitmapFactory via ImageIO. */
public final class BitmapFactory {
    private BitmapFactory() {}
    public static Bitmap decodeByteArray(byte[] data, int offset, int length) {
        try { BufferedImage img = javax.imageio.ImageIO.read(new ByteArrayInputStream(data, offset, length)); return img == null ? null : new Bitmap(img); } catch (Exception e) { return null; }
    }
    public static Bitmap decodeStream(java.io.InputStream in) { try { BufferedImage img = javax.imageio.ImageIO.read(in); return img == null ? null : new Bitmap(img); } catch (Exception e) { return null; } }
}
