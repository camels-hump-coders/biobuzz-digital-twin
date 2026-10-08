/** Robot appearance: colour swatches and small colour helpers. Pure data. */
import type { RobotLook, RobotSpec } from "./robotSpec";

export const COLOR_SWATCHES: { name: string; hex: number }[] = [
  { name: "Aluminium", hex: 0xe8e8e8 }, { name: "Graphite", hex: 0x3a3f47 }, { name: "Black", hex: 0x15181c },
  { name: "Honey", hex: 0xf2c200 }, { name: "Orange", hex: 0xf07a1a }, { name: "Red", hex: 0xd42a2a },
  { name: "Magenta", hex: 0xc43b9a }, { name: "Purple", hex: 0x6e3fcf }, { name: "Blue", hex: 0x2a5bd4 },
  { name: "Teal", hex: 0x1fa6a6 }, { name: "Green", hex: 0x3e8e2f }, { name: "Lime", hex: 0x9ccf2f },
];

export function defaultLook(color = 0xe8e8e8): RobotLook { return { color }; }
/** The look of a spec, filling in older saves that only carried `color`. */
export function lookOf(spec: Pick<RobotSpec, "color" | "look">): RobotLook { return spec.look ?? defaultLook(spec.color); }
export const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
/** Perceived brightness 0-1, to pick black or white text on a colour. */
export function luminance(n: number): number {
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
export const lookSignature = (l: RobotLook) => `${l.color}`;
