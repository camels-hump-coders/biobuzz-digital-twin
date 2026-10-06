/** Service-worker registration (vite-plugin-pwa) with an "update available" toast. No-op in dev. */
import { registerSW } from "virtual:pwa-register";

export function setupUpdates() {
  if (!("serviceWorker" in navigator)) return;
  // headless test pages must run exactly the bundle being served, never one a service worker cached earlier
  if (new URLSearchParams(location.search).get("ci") === "1") return;
  const toast = (text: string, action?: { label: string; onClick: () => void }) => {
    document.getElementById("update-toast")?.remove();
    const el = document.createElement("div");
    el.id = "update-toast";
    el.append(text);
    if (action) { const b = document.createElement("button"); b.textContent = action.label; b.onclick = action.onClick; el.append(b); }
    const x = document.createElement("button"); x.textContent = "×"; x.title = "Dismiss"; x.onclick = () => el.remove(); el.append(x);
    document.getElementById("app")!.append(el);
    if (!action) setTimeout(() => el.remove(), 6000);
  };
  const update = registerSW({
    immediate: true,
    onNeedRefresh() { toast("A new version of the twin is available.", { label: "Reload", onClick: () => update(true) }); },
    onOfflineReady() { toast("Ready to work offline: the twin is cached on this device."); },
  });
}
