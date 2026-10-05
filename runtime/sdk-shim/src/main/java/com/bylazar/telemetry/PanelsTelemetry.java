package com.bylazar.telemetry;

import org.firstinspires.ftc.robotcore.external.Telemetry;

/** Panels dashboard telemetry (com.bylazar:fullpanels). In the sim there is no dashboard, so this is a sink. */
public final class PanelsTelemetry {
    public static final PanelsTelemetry INSTANCE = new PanelsTelemetry();
    private final TelemetryManager manager = new TelemetryManager();
    private PanelsTelemetry() {}
    public Telemetry getFtcTelemetry() { return manager.ftc; }
    public TelemetryManager getTelemetry() { return manager; }
}
