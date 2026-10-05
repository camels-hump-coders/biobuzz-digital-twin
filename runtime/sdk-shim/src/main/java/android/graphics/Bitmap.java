package android.graphics;

import java.awt.image.BufferedImage;
import java.io.OutputStream;

/** android.graphics.Bitmap backed by a BufferedImage, enough for camera-frame JPEG round trips. */
public class Bitmap {
    public enum CompressFormat { JPEG, PNG, WEBP, WEBP_LOSSY, WEBP_LOSSLESS }
    public enum Config { ALPHA_8, RGB_565, ARGB_4444, ARGB_8888, RGBA_F16, HARDWARE }
    final BufferedImage image;
    private boolean recycled;
    Bitmap(BufferedImage image) { this.image = image; }
    public static Bitmap createBitmap(int width, int height, Config config) { return new Bitmap(new BufferedImage(Math.max(1, width), Math.max(1, height), BufferedImage.TYPE_INT_RGB)); }
    public int getWidth() { return image.getWidth(); }
    public int getHeight() { return image.getHeight(); }
    public boolean compress(CompressFormat format, int quality, OutputStream out) {
        try {
            String fmt = format == CompressFormat.PNG ? "png" : "jpg";
            BufferedImage src = image;
            if (fmt.equals("jpg") && src.getType() != BufferedImage.TYPE_INT_RGB) { BufferedImage rgb = new BufferedImage(src.getWidth(), src.getHeight(), BufferedImage.TYPE_INT_RGB); rgb.getGraphics().drawImage(src, 0, 0, null); src = rgb; }
            if (fmt.equals("jpg")) {
                javax.imageio.ImageWriter w = javax.imageio.ImageIO.getImageWritersByFormatName("jpeg").next();
                javax.imageio.ImageWriteParam p = w.getDefaultWriteParam();
                p.setCompressionMode(javax.imageio.ImageWriteParam.MODE_EXPLICIT); p.setCompressionQuality(Math.max(1, Math.min(100, quality)) / 100f);
                try (javax.imageio.stream.ImageOutputStream ios = javax.imageio.ImageIO.createImageOutputStream(out)) { w.setOutput(ios); w.write(null, new javax.imageio.IIOImage(src, null, null), p); }
                w.dispose();
                return true;
            }
            return javax.imageio.ImageIO.write(src, fmt, out);
        } catch (Exception e) { return false; }
    }
    public void recycle() { recycled = true; }
    public boolean isRecycled() { return recycled; }
    public BufferedImage asBufferedImage() { return image; }
}
