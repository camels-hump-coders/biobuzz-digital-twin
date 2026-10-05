package com.qualcomm.robotcore.eventloop.opmode;

/** Lifecycle notifications dashboards subscribe to (FTC SDK API). */
public interface OpModeManagerNotifier {
    interface Notifications {
        void onOpModePreInit(OpMode opMode);
        void onOpModePreStart(OpMode opMode);
        void onOpModePostStop(OpMode opMode);
    }
    OpMode registerListener(Notifications listener);
    void unregisterListener(Notifications listener);
}
