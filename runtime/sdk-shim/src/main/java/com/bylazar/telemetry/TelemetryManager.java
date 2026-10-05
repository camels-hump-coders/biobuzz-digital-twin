package com.bylazar.telemetry;

import org.firstinspires.ftc.robotcore.external.Telemetry;

/** Panels TelemetryManager stand-in: accepts data, prints nothing. */
public class TelemetryManager {
    final Telemetry ftc = new NullTelemetry();
    public TelemetryManager debug(String... lines) { return this; }
    public TelemetryManager debug(Object o) { return this; }
    public TelemetryManager addData(String key, Object value) { return this; }
    public TelemetryManager addLine(String line) { return this; }
    public void update() {}
    public void update(Telemetry alsoTo) { if (alsoTo != null) alsoTo.update(); }
    public Telemetry getFtcTelemetry() { return ftc; }
}
