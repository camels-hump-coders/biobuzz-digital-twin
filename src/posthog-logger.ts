import posthog from "./posthog";

// This dedicated logger is the only application path that exports PostHog logs.
// Existing console output and runtime-host logs remain local to the simulator.
export const posthogLogger = posthog.logger;
