/** FTC-legal UVC webcams commonly used with the Control Hub. FOV values are
 * manufacturer diagonal figures unless noted; override in the UI if you have
 * measured your own lens. */
export interface CameraPreset {
  id: string;
  name: string;
  width: number;
  height: number;
  /** diagonal FOV in degrees (preferred) */
  diagFovDeg?: number;
  /** or horizontal FOV in degrees if that is what the datasheet gives */
  hfovDeg?: number;
  fps: number;
  globalShutter: boolean;
  notes?: string;
}

export const CAMERA_PRESETS: CameraPreset[] = [
  { id: "c270", name: "Logitech C270", width: 1280, height: 720, diagFovDeg: 55, fps: 30, globalShutter: false, notes: "Older units are 60 deg diagonal." },
  { id: "c920", name: "Logitech C920 / C922", width: 1920, height: 1080, diagFovDeg: 78, fps: 30, globalShutter: false },
  { id: "c930e", name: "Logitech C930e", width: 1920, height: 1080, diagFovDeg: 90, fps: 30, globalShutter: false },
  { id: "brio78", name: "Logitech Brio (78 deg mode)", width: 1920, height: 1080, diagFovDeg: 78, fps: 60, globalShutter: false },
  { id: "brio90", name: "Logitech Brio (90 deg mode)", width: 1920, height: 1080, diagFovDeg: 90, fps: 60, globalShutter: false },
  { id: "lifecam3000", name: "Microsoft LifeCam HD-3000", width: 1280, height: 720, diagFovDeg: 68.5, fps: 30, globalShutter: false },
  { id: "ov9281-70", name: "Arducam OV9281 global shutter (70 deg lens)", width: 1280, height: 800, hfovDeg: 70, fps: 120, globalShutter: true, notes: "Mono. Lens options vary; set FOV to your lens." },
  { id: "ov9281-100", name: "Arducam OV9281 global shutter (100 deg lens)", width: 1280, height: 800, hfovDeg: 100, fps: 120, globalShutter: true, notes: "Mono, wide. Expect barrel distortion." },
  { id: "ov9782", name: "Arducam OV9782 colour global shutter", width: 1280, height: 800, hfovDeg: 70, fps: 120, globalShutter: true },
  { id: "ll3a", name: "Limelight 3A", width: 1280, height: 960, hfovDeg: 54.5, fps: 90, globalShutter: false, notes: "54.5 x 41.7 deg. Runs its own pipeline." },
  { id: "custom", name: "Custom", width: 1280, height: 720, diagFovDeg: 70, fps: 30, globalShutter: false },
];

export function presetById(id: string): CameraPreset {
  return CAMERA_PRESETS.find((p) => p.id === id) ?? CAMERA_PRESETS[CAMERA_PRESETS.length - 1];
}
