/** Robot appearance: colour swatches, decals and the team-number plate texture. Pure data plus one canvas painter. */
import type { Decal, RobotLook, RobotSpec } from "./robotSpec";

export const COLOR_SWATCHES: { name: string; hex: number }[] = [
  { name: "Aluminium", hex: 0xe8e8e8 }, { name: "Graphite", hex: 0x3a3f47 }, { name: "Black", hex: 0x15181c },
  { name: "Honey", hex: 0xf2c200 }, { name: "Orange", hex: 0xf07a1a }, { name: "Red", hex: 0xd42a2a },
  { name: "Magenta", hex: 0xc43b9a }, { name: "Purple", hex: 0x6e3fcf }, { name: "Blue", hex: 0x2a5bd4 },
  { name: "Teal", hex: 0x1fa6a6 }, { name: "Green", hex: 0x3e8e2f }, { name: "Lime", hex: 0x9ccf2f },
];
export const DECALS: { id: Decal; label: string }[] = [
  { id: "none", label: "None" }, { id: "stripe", label: "Racing stripe" }, { id: "chevron", label: "Chevron" }, { id: "checker", label: "Checker" },
];

export function defaultLook(color = 0xe8e8e8): RobotLook {
  return { color, accent: 0xf2c200, decal: "none", plateText: "36682" };
}
/** The look of a spec, filling in older saves that only carried `color`. */
export function lookOf(spec: Pick<RobotSpec, "color" | "look">): RobotLook {
  return spec.look ?? defaultLook(spec.color);
}
export const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
/** Perceived brightness 0-1, to pick black or white text on a colour. */
export function luminance(n: number): number {
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
export const lookSignature = (l: RobotLook) => `${l.color}/${l.accent}/${l.decal}/${l.plateText}`;

/** Paint the livery: a top-down panel with the decal in the accent colour and the team number plate across it.
 *  Returns null outside a browser (tests) or when the canvas is unavailable. */
export function paintLivery(look: RobotLook, aspect: number, px = 256): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const w = px, h = Math.max(32, Math.round(px / Math.max(0.3, aspect)));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); if (!g) return null;
  g.fillStyle = hex(look.color); g.fillRect(0, 0, w, h);
  g.fillStyle = hex(look.accent);
  if (look.decal === "stripe") { g.fillRect(w * 0.10, 0, w * 0.07, h); g.fillRect(w * 0.20, 0, w * 0.04, h); } // off-centre racing stripes along the length, clear of the plate
  else if (look.decal === "chevron") {
    for (let i = -2; i < 8; i++) { g.beginPath(); const x = i * w * 0.16; g.moveTo(x, 0); g.lineTo(x + w * 0.08, 0); g.lineTo(x + w * 0.08 + h * 0.5, h / 2); g.lineTo(x + w * 0.08, h); g.lineTo(x, h); g.lineTo(x + h * 0.5, h / 2); g.closePath(); g.fill(); }
  } else if (look.decal === "checker") {
    const n = 8, s = w / n; for (let i = 0; i < n; i++) for (let j = 0; j < Math.ceil(h / s); j++) if ((i + j) % 2 === 0) g.fillRect(i * s, j * s, s, s);
  }
  // number plate: a rounded white or black plate with the text, centred (FTC plates: team number, readable from afar)
  const text = (look.plateText || "").trim().slice(0, 8);
  if (text) {
    const pw = Math.min(w * 0.7, Math.max(w * 0.3, text.length * w * 0.11)), ph = h * 0.42;
    const dark = luminance(look.color) > 0.55;
    g.fillStyle = dark ? "#111" : "#fafafa";
    roundRect(g, (w - pw) / 2, (h - ph) / 2, pw, ph, ph * 0.2); g.fill();
    g.fillStyle = dark ? "#fafafa" : "#111";
    g.font = `bold ${Math.round(ph * 0.7)}px system-ui, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, w / 2, h / 2 + ph * 0.02);
  }
  return c;
}
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
