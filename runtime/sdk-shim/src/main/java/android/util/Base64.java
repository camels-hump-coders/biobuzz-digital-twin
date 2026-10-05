package android.util;

/** android.util.Base64 on top of java.util.Base64. */
public final class Base64 {
    public static final int DEFAULT = 0, NO_PADDING = 1, NO_WRAP = 2, CRLF = 4, URL_SAFE = 8, NO_CLOSE = 16;
    private Base64() {}
    public static String encodeToString(byte[] input, int flags) { return new String(encode(input, flags), java.nio.charset.StandardCharsets.US_ASCII); }
    public static byte[] encode(byte[] input, int flags) {
        java.util.Base64.Encoder e = (flags & URL_SAFE) != 0 ? java.util.Base64.getUrlEncoder() : (flags & NO_WRAP) != 0 ? java.util.Base64.getEncoder() : java.util.Base64.getMimeEncoder(76, new byte[] { '\n' });
        if ((flags & NO_PADDING) != 0) e = e.withoutPadding();
        byte[] out = e.encode(input);
        if ((flags & NO_WRAP) == 0 && (flags & URL_SAFE) == 0) { byte[] withNl = new byte[out.length + 1]; System.arraycopy(out, 0, withNl, 0, out.length); withNl[out.length] = '\n'; return withNl; }
        return out;
    }
    public static byte[] decode(String s, int flags) { return ((flags & URL_SAFE) != 0 ? java.util.Base64.getUrlDecoder() : java.util.Base64.getMimeDecoder()).decode(s.trim()); }
    public static byte[] decode(byte[] b, int flags) { return decode(new String(b, java.nio.charset.StandardCharsets.US_ASCII), flags); }
}
