import posthog from "posthog-js";

const projectToken = import.meta.env.VITE_POSTHOG_KEY;
const host = import.meta.env.VITE_POSTHOG_HOST;

if (!projectToken) {
  if (import.meta.env.DEV) {
    throw new Error("VITE_POSTHOG_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once VITE_POSTHOG_KEY is configured");
  }
} else if (!host) {
  if (import.meta.env.DEV) {
    throw new Error("VITE_POSTHOG_HOST variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once VITE_POSTHOG_HOST is configured");
  }
} else {
  posthog.init(projectToken, {
    api_host: host,
    defaults: "2026-05-30",
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    // The runtime host on 127.0.0.1:8765 is usually not running; failing to reach it is expected, not an error.
    before_send: (event) => {
      if (event?.event !== "$exception") return event;
      const text = JSON.stringify(event.properties?.$exception_list ?? event.properties?.$exception_message ?? "");
      return /WebSocket connection to .* failed|127\.0\.0\.1:\d+/.test(text) ? null : event;
    },
  });
}

export default posthog;
