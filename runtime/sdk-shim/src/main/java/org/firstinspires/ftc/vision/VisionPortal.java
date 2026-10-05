package org.firstinspires.ftc.vision;

import android.util.Size;
import org.firstinspires.ftc.robotcore.external.hardware.camera.CameraName;
import org.firstinspires.ftc.vision.apriltag.AprilTagProcessor;
import java.util.*;

public class VisionPortal {
    public enum CameraState { OPENING_CAMERA_DEVICE, CAMERA_DEVICE_READY, STARTING_STREAM, STREAMING, STOPPING_STREAM, CLOSING_CAMERA_DEVICE, CAMERA_DEVICE_CLOSED, ERROR }
    public enum StreamFormat { YUY2, MJPEG }
    public enum MultiPortalLayout { VERTICAL, HORIZONTAL }
    public static final int DEFAULT_VIEW_CONTAINER_ID = 0;

    private final CameraName camera;
    private final List<VisionProcessor> processors;
    private final Map<VisionProcessor, Boolean> enabled = new HashMap<>();
    private volatile CameraState state = CameraState.STREAMING;
    private final Size resolution;

    VisionPortal(CameraName camera, List<VisionProcessor> processors, Size resolution) {
        this.camera = camera; this.processors = processors; this.resolution = resolution;
        for (VisionProcessor p : processors) { enabled.put(p, true); if (p instanceof AprilTagProcessor) ((AprilTagProcessor) p).internalAttach(camera); }
    }
    public static VisionPortal easyCreateWithDefaults(CameraName camera, VisionProcessor... processors) {
        Builder b = new Builder().setCamera(camera); for (VisionProcessor p : processors) b.addProcessor(p); return b.build();
    }
    public static int[] makeMultiPortalView(int numPortals, MultiPortalLayout layout) { int[] ids = new int[numPortals]; for (int i = 0; i < numPortals; i++) ids[i] = i + 1; return ids; }
    public void setProcessorEnabled(VisionProcessor p, boolean on) { enabled.put(p, on); if (p instanceof AprilTagProcessor) ((AprilTagProcessor) p).internalSetEnabled(on); }
    public boolean getProcessorEnabled(VisionProcessor p) { return enabled.getOrDefault(p, false); }
    public CameraState getCameraState() { return state; }
    public void stopStreaming() { state = CameraState.CAMERA_DEVICE_READY; for (VisionProcessor p : processors) if (p instanceof AprilTagProcessor) ((AprilTagProcessor) p).internalSetEnabled(false); }
    public void resumeStreaming() { state = CameraState.STREAMING; for (VisionProcessor p : processors) if (p instanceof AprilTagProcessor) ((AprilTagProcessor) p).internalSetEnabled(enabled.getOrDefault(p, true)); }
    public void stopLiveView() {}
    public void resumeLiveView() {}
    public float getFps() { return 30f; }
    public void close() { state = CameraState.CAMERA_DEVICE_CLOSED; stopStreaming(); }
    public void setActiveCamera(CameraName c) {}
    public CameraName getActiveCamera() { return camera; }
    public Size getResolution() { return resolution; }
    public <T> T getCameraControl(Class<T> controlType) { return null; }
    public void saveNextFrameRaw(String filename) {}

    public static class Builder {
        private CameraName camera; private final List<VisionProcessor> processors = new ArrayList<>(); private Size resolution = new Size(640, 480);
        public Builder setCamera(CameraName c) { camera = c; return this; }
        public Builder addProcessor(VisionProcessor p) { processors.add(p); return this; }
        public Builder addProcessors(VisionProcessor... ps) { processors.addAll(Arrays.asList(ps)); return this; }
        public Builder setCameraResolution(Size s) { resolution = s; return this; }
        public Builder setStreamFormat(StreamFormat f) { return this; }
        public Builder enableLiveView(boolean b) { return this; }
        public Builder setAutoStopLiveView(boolean b) { return this; }
        public Builder setLiveViewContainerId(int id) { return this; }
        public Builder setAutoStartStreamOnBuild(boolean b) { return this; }
        public Builder setShowStatsOverlay(boolean b) { return this; }
        public VisionPortal build() { return new VisionPortal(camera, processors, resolution); }
    }
}
