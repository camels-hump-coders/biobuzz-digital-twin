import posthog from "posthog-js";

const projectToken = import.meta.env.VITE_POSTHOG_KEY;
const host = import.meta.env.VITE_POSTHOG_HOST;

if (projectToken && host) {
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
