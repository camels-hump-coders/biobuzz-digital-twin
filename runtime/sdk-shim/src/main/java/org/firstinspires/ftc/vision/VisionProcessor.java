package org.firstinspires.ftc.vision;
/** Custom frame processors are not fed frames in the sim (no OpenCV on the desktop); they are accepted so TeamCode compiles. */
public interface VisionProcessor {
    default void init(int width, int height, Object calibration) {}
    default Object processFrame(Object frame, long captureTimeNanos) { return null; }
    default void onDrawFrame(Object canvas, int onscreenWidth, int onscreenHeight, float scaleBmpPxToCanvasPx, float scaleCanvasDensity, Object userContext) {}
}
