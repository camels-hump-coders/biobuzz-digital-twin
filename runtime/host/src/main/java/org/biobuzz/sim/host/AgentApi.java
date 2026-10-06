package org.biobuzz.sim.host;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Local HTTP API for coding agents (and scripts) to look into, and act on, a LIVE twin session: the browser a human
 * has open. Listens on 127.0.0.1 only, at the WebSocket port + 1 (default http://127.0.0.1:8766/).
 *
 * Served by the host itself:        GET /api/status  GET /api/telemetry  GET /api/log?tail=200
 * Forwarded to the browser session:  GET /api/snapshot?seconds=30 (Markdown)  GET /api/timeline?seconds=30
 *                                    GET /api/state  GET /api/knobs  GET /api/overrides
 *                                    POST /api/overrides  POST /api/twin  POST /api/match  POST /api/gamepad  POST /api/pose
 * Any other /api/<action> is forwarded too (query parameters and the JSON body become the action's parameters), so
 * the browser (src/main.ts, link.onAgent) can grow actions without touching the host. GET / lists everything.
 */
public final class AgentApi {
    private static final Gson gson = new Gson();
    public static volatile String URL = "";

    public static void start(SimLink link, int port) {
        try {
            HttpServer http = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 8);
            http.createContext("/", ex -> handle(link, ex));
            http.setExecutor(null);
            http.start();
            URL = "http://127.0.0.1:" + port + "/";
            System.out.println("agent API      " + URL + "  (GET / for the endpoint list)");
        } catch (IOException e) {
            System.err.println("agent API: could not listen on 127.0.0.1:" + port + " (" + e.getMessage() + "); agents cannot query this session");
        }
    }

    private static void handle(SimLink link, HttpExchange ex) throws IOException {
        try {
            String path = ex.getRequestURI().getPath();
            JsonObject params = new JsonObject();
            String q = ex.getRequestURI().getRawQuery();
            if (q != null) for (String kv : q.split("&")) { int i = kv.indexOf('='); if (i > 0) params.addProperty(URLDecoder.decode(kv.substring(0, i), StandardCharsets.UTF_8), URLDecoder.decode(kv.substring(i + 1), StandardCharsets.UTF_8)); }
            String body;
            try (InputStream in = ex.getRequestBody()) { body = new String(in.readAllBytes(), StandardCharsets.UTF_8); }
            if (!body.isBlank()) {
                JsonElement b = JsonParser.parseString(body);
                if (b.isJsonObject()) for (Map.Entry<String, JsonElement> e : b.getAsJsonObject().entrySet()) params.add(e.getKey(), e.getValue());
                else params.add("body", b);
            }
            if (path.equals("/") || path.equals("/api") || path.equals("/api/")) { reply(ex, 200, "application/json", gson.toJson(help(link))); return; }
            if (!path.startsWith("/api/")) { reply(ex, 404, "text/plain", "not found; GET / for the endpoint list\n"); return; }
            String action = path.substring(5);
            switch (action) {
                case "status": reply(ex, 200, "application/json", gson.toJson(link.agentStatus())); return;
                case "telemetry": { JsonObject o = new JsonObject(); o.add("lines", gson.toJsonTree(link.telemetry())); reply(ex, 200, "application/json", gson.toJson(o)); return; }
                case "runs": { // saved runs on disk (server mode): list, or fetch one with ?file=
                    java.io.File dir = link.runsDir();
                    if (params.has("file")) {
                        String name = params.get("file").getAsString().replace("/", "").replace("\\", "");
                        java.io.File f = new java.io.File(dir, name);
                        if (!f.isFile()) { reply(ex, 404, "application/json", "{\"error\":\"no such run\"}"); return; }
                        reply(ex, 200, "application/json", java.nio.file.Files.readString(f.toPath())); return;
                    }
                    com.google.gson.JsonArray arr = new com.google.gson.JsonArray();
                    java.io.File[] all = dir.listFiles((d, n) -> n.endsWith(".json"));
                    if (all != null) { java.util.Arrays.sort(all, java.util.Comparator.comparing(java.io.File::getName)); for (java.io.File f : all) { JsonObject o = new JsonObject(); o.addProperty("file", f.getName()); o.addProperty("bytes", f.length()); o.addProperty("modified", f.lastModified()); arr.add(o); } }
                    JsonObject o = new JsonObject(); o.addProperty("dir", dir.getAbsolutePath()); o.add("runs", arr); o.addProperty("latest", link.lastRunFile);
                    reply(ex, 200, "application/json", gson.toJson(o)); return;
                }
                case "log": { int tail = params.has("tail") ? Integer.parseInt(params.get("tail").getAsString()) : 200; JsonObject o = new JsonObject(); o.add("lines", link.logTail(tail)); reply(ex, 200, "application/json", gson.toJson(o)); return; }
                default: break;
            }
            if (!link.hasBrowser()) { reply(ex, 503, "application/json", "{\"error\":\"no browser session is connected to this host; open the twin (pnpm sim) first\"}"); return; }
            JsonObject res = link.askBrowser(action, params, 8000);
            if (res == null) { reply(ex, 504, "application/json", "{\"error\":\"the browser did not answer within 8 s (tab in the background? reload it)\"}"); return; }
            boolean ok = !res.has("ok") || res.get("ok").getAsBoolean();
            String ct = res.has("contentType") ? res.get("contentType").getAsString() : "application/json";
            if (!ok) { JsonObject err = new JsonObject(); err.addProperty("error", res.has("error") ? res.get("error").getAsString() : "request failed"); reply(ex, 400, "application/json", gson.toJson(err)); return; }
            if (ct.startsWith("text/")) reply(ex, 200, ct, res.has("result") ? res.get("result").getAsString() : "");
            else reply(ex, 200, ct, gson.toJson(res.has("result") ? res.get("result") : res));
        } catch (Exception e) {
            reply(ex, 500, "application/json", gson.toJson(Map.of("error", String.valueOf(e))));
        }
    }

    private static JsonObject help(SimLink link) {
        JsonObject h = new JsonObject();
        h.addProperty("about", "BIOBUZZ twin agent API: inspect and steer the live browser session. Localhost only.");
        h.addProperty("browserConnected", link.hasBrowser());
        JsonObject e = new JsonObject();
        e.addProperty("GET /api/status", "runtime status, current OpMode, error, OpMode list, Panels URL");
        e.addProperty("GET /api/telemetry", "latest telemetry lines from the OpMode");
        e.addProperty("GET /api/log?tail=200", "recent host output (OpMode prints, RobotLog, exceptions) with millis");
        e.addProperty("GET /api/snapshot?seconds=30", "Markdown snapshot of the last N seconds: context, events, telemetry (same as the panel's Copy)");
        e.addProperty("GET /api/timeline?seconds=30", "raw 10 Hz samples and events for the last N seconds (JSON)");
        e.addProperty("GET /api/state", "pose, match phase/clock, score, inventories, hive states, selected OpMode, alliance");
        e.addProperty("GET /api/knobs", "twin knob catalogue (what twin-bindings.json can reference) with values");
        e.addProperty("GET /api/overrides", "asset overrides: manual (panel) and bound (twin bindings)");
        e.addProperty("GET /api/shot?rangeIn=68", "required exit speed / RPM / flywheel power to score in the up cell at that horizontal range (or rangesIn=48,60,72 for a table; hoodDeg= to try another angle); the live value for the current pose is /api/state -> shot");
        e.addProperty("GET /api/run", "recorded runs (INIT->STOP) in the browser session, the latest one, and the replay cursor");
        e.addProperty("GET /api/replay?offset=12.5", "the recorded sample 12.5 s into the latest run (pose, other robots, balls, hive tilts, telemetry, sticks, score); offset<0 counts from the run's end; t=<ms> or step=<n> also work; add scrub=false to not move the human's view");
        e.addProperty("POST /api/replay", "{\"offset\": 12.5} | {\"step\": -1} | {\"t\": 1791...} scrub the human's field to that moment (live sim pauses); {\"live\": true} resumes");
        e.addProperty("GET /api/runs", "runs saved on disk by the host (runtime/runs/*.json); ?file=<name> returns one (context, samples, events)");
        e.addProperty("POST /api/overrides", "{\"biobuzz/robot-profile.json\": {\"matchAuto.startPosition\": \"FAR_SIDE\"}}  merge into the panel's overrides (sent to TeamCode at INIT); {\"clear\": \"<path>\"} forgets a file's overrides");
        e.addProperty("GET /api/settings", "the twin's settings file (server mode: <team repo>/twin-settings.json): path, exists, whether the browser differs from it, and the browser's current settings");
        e.addProperty("POST /api/settings", "{\"save\": true} writes the browser's settings to the file; {\"load\": true} applies the file to the browser; {\"text\": \"{...}\"} applies given settings JSON (and saves if also save:true)");
        e.addProperty("POST /api/save", "{\"file\": \"robot-profile.json\"} or {\"all\": true}  write the merged settings file(s) back into the team repo's assets folder (what the robot build uses); overrides for them are cleared");
        e.addProperty("POST /api/twin", "{\"alliance\": \"red\", \"launcher.elevationDeg\": 52, \"hive.blue\": \"audience\", \"opponents\": false}  set twin settings by path (whitelisted)");
        e.addProperty("POST /api/match", "{\"action\": \"init\"|\"start\"|\"stop\"|\"reset\", \"opMode\": \"name\"}  Driver-Station flow; init selects the OpMode first");
        e.addProperty("POST /api/gamepad", "{\"pad\": 1, \"values\": {\"a\": true, \"ly\": -0.5}, \"holdMs\": 300}  inject gamepad fields (held until changed, or released after holdMs)");
        e.addProperty("POST /api/pose", "{\"xIn\": 0, \"zIn\": 36, \"headingDeg\": 90}  teleport our robot");
        h.add("endpoints", e);
        return h;
    }

    private static void reply(HttpExchange ex, int code, String type, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", type + "; charset=utf-8");
        ex.sendResponseHeaders(code, b.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(b); }
    }
}
