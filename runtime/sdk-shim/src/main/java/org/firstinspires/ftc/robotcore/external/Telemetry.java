package org.firstinspires.ftc.robotcore.external;
import java.util.Locale;
public interface Telemetry {
    enum DisplayFormat { CLASSIC, MONOSPACE, HTML }
    interface Item {
        String getCaption(); Item setCaption(String c);
        Item setValue(String format, Object... args); Item setValue(Object value); <T> Item setValue(Func<T> f); <T> Item setValue(String format, Func<T> f);
        Item setRetained(Boolean retained); boolean isRetained();
        Item addData(String caption, String format, Object... args); Item addData(String caption, Object value); <T> Item addData(String caption, Func<T> f); <T> Item addData(String caption, String format, Func<T> f);
    }
    interface Line { Item addData(String caption, String format, Object... args); Item addData(String caption, Object value); <T> Item addData(String caption, Func<T> f); <T> Item addData(String caption, String format, Func<T> f); }
    interface Log { enum DisplayOrder { NEWEST_FIRST, OLDEST_FIRST } int getCapacity(); void setCapacity(int c); DisplayOrder getDisplayOrder(); void setDisplayOrder(DisplayOrder o); void add(String entry); void add(String format, Object... args); void clear(); }
    Item addData(String caption, String format, Object... args);
    Item addData(String caption, Object value);
    <T> Item addData(String caption, Func<T> valueProducer);
    <T> Item addData(String caption, String format, Func<T> valueProducer);
    boolean removeItem(Item item);
    void clear();
    void clearAll();
    Object addAction(Runnable action);
    boolean removeAction(Object token);
    void speak(String text);
    void speak(String text, String languageCode, String countryCode);
    boolean update();
    Line addLine();
    Line addLine(String lineCaption);
    boolean removeLine(Line line);
    boolean isAutoClear();
    void setAutoClear(boolean autoClear);
    int getMsTransmissionInterval();
    void setMsTransmissionInterval(int ms);
    String getItemSeparator();
    void setItemSeparator(String s);
    String getCaptionValueSeparator();
    void setCaptionValueSeparator(String s);
    void setDisplayFormat(DisplayFormat f);
    Log log();
    default Locale locale() { return Locale.US; }
}
