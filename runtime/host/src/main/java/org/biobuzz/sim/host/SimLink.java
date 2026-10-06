package org.biobuzz.sim.host;

import com.google.gson.*;
import com.qualcomm.robotcore.hardware.HardwareMap;
import org.biobuzz.sim.shim.SimHooks;
import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

import java.net.InetSocketAddress;
import java.util.*;
import java.util.concurrent.*;

/** WebSocket server the browser twin connects to. One JSON object per message, "type" field dispatches. */
public class SimLink extends WebSocketServer {
    private final Gson gson = new Gson();
    private final SimState state = new SimState();
    private final OpModeRunner runner;
    private final List<OpModeScanner.Entry> opModes;
    private volatile HardwareMap hardwareMap = new HardwareMap();
    private volatile String hardwareJson = "";
    /** name -> {kind, port, ticksPerRev} for devices the browser knows from its presets */
    private volatile JsonObject hints = new JsonObject();
    private final Set<WebSocket> clients = ConcurrentHashMap.newKeySet();
    private final ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor(r -> { Thread t = new Thread(r, "sim-link"); t.setDaemon(true); return t; });
    private volatile List<String> lastTelemetry = Collections.emptyList();
    private final boolean panels;
    /** agent API plumbing: requests awaiting the browser's answer, and the recent host output */
    private final Map<String, CompletableFuture<JsonObject>> pending = new ConcurrentHashMap<>();
    private final Deque<JsonObject> logRing = new ArrayDeque<>();
    private static final int LOG_RING = 3000;

    public SimLink(int port, List<OpModeScanner.Entry> opModes) {
        super(new InetSocketAddress("127.0.0.1", port));
        this.opModes = opModes;
        SimHooks.setTagSource(state);
        // TeamCode asked for a device the browser's hardware map lacks: create it here so INIT continues, and tell
        // the browser so it appears in the Hardware map panel (role/port still need a human look).
        SimHooks.setMissingDeviceListener((name, type) -> {
            JsonObject m = new JsonObject(); m.addProperty("type", "missingDevice"); m.addProperty("name", name); m.addProperty("requested", type); broadcastJson(m);
            int hubPort = (int) hardwareMap.getAll(com.qualcomm.robotcore.hardware.HardwareDevice.class).stream().filter(d -> sameKind(d, type)).count();
            double tpr = 537.7;
            JsonObject hint = hints.has(name) ? hints.getAsJsonObject(name) : null;
            if (hint != null) { if (hint.has("port")) hubPort = hint.get("port").getAsInt(); if (hint.has("ticksPerRev")) tpr = hint.get("ticksPerRev").getAsDouble(); }
            if (type.matches(".*(DcMotor|DcMotorEx|DcMotorSimple).*")) return new Devices.SimMotor(name, state, tpr, hubPort);
            if (type.contains("CRServo")) return new Devices.SimCRServo(name, state, hubPort);
            if (type.matches(".*Servo.*")) return new Devices.SimServo(name, state, hubPort);
            if (type.matches(".*(IMU|Gyro|BNO055).*")) return new Devices.SimImu(name, state);
            if (type.matches(".*(Webcam|Camera).*")) return new Devices.SimWebcam(name);
            if (type.contains("Distance")) return new Devices.SimDistance(name, state);
            if (type.contains("Touch")) return new Devices.SimTouch(name);
            return null;
        });
        runner = new OpModeRunner(state, lines -> { lastTelemetry = lines; broadcastJson(telemetryMessage(lines)); }, s -> broadcastJson(statusMessage()));
        panels = PanelsBoot.start(runner, opModes, () -> hardwareMap);
        setReuseAddr(true);
        exec.scheduleAtFixedRate(() -> { if (!clients.isEmpty()) { broadcastJson(state.actuatorMessage()); holdSensorsIfStalled(); } }, 20, 20, TimeUnit.MILLISECONDS);
    }

    @Override public void onOpen(WebSocket conn, ClientHandshake hs) {
        clients.add(conn);
        send(conn, opModesMessage()); send(conn, statusMessage()); send(conn, telemetryMessage(lastTelemetry)); send(conn, assetsMessage()); send(conn, settingsMessage());
        System.out.println("browser connected from " + conn.getRemoteSocketAddress() + " (" + clients.size() + " connected)");
    }
    @Override public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        clients.remove(conn);
        if (driver == conn) driver = null;
        System.out.println("browser disconnected (" + clients.size() + " left)");
        if (clients.isEmpty()) runner.stop();
    }
    @Override public void onError(WebSocket conn, Exception ex) { System.err.println("link error: " + ex); }
    /** set once the socket is bound and accepting (Main's startup watchdog reads it) */
    public volatile boolean started = false;
    @Override public void onStart() { started = true; System.out.println("BIOBUZZ runtime listening on ws://127.0.0.1:" + getPort() + "  (" + opModes.size() + " OpModes)"); }

    @Override public void onMessage(WebSocket conn, String message) {
        JsonObject msg;
        try { msg = JsonParser.parseString(message).getAsJsonObject(); } catch (Exception e) { return; }
        String type = msg.has("type") ? msg.get("type").getAsString() : "";
        switch (type) {
            case "sensors":
                // only one browser drives the simulated robot: the first to connect, or the one that last pressed INIT.
                // A second viewer (a human watching an agent's run, a stale tab) must not interleave its own encoder
                // ticks and gamepad with the driver's; its packets are counted and dropped
                if (driver != null && driver != conn && driver.isOpen()) { ignoredSensorPackets++; break; }
                driver = conn;
                synchronized (sensorLock) { noteSensorPacket(); lastSensorsMsg = msg; state.ingest(msg); }
                runner.updateGamepads(msg.getAsJsonObject("gamepad1"), msg.getAsJsonObject("gamepad2"));
                break;
            case "hardware": { // the browser's hardware map: [{name, kind, ticksPerRev, port}] plus preset hints
                if (msg.has("hints") && msg.get("hints").isJsonObject()) hints = msg.getAsJsonObject("hints");
                String j = gson.toJson(msg.getAsJsonArray("devices"));
                if (!j.equals(hardwareJson)) {
                    hardwareJson = j;
                    // Always update the ONE hardware map in place. Swapping in a new map (the old behaviour when no
                    // OpMode was live) raced with an OpMode that was just starting: part of its init() got device objects
                    // from the old map and part from the new one, so e.g. two "Left Drive" motors existed, only one of
                    // which had its encoder reset, and readings alternated between two series.
                    JsonArray devs = msg.getAsJsonArray("devices");
                    updateHardwareMap(devs);
                    boolean live = runner.status() == OpModeRunner.Status.RUNNING || runner.status() == OpModeRunner.Status.INIT;
                    if (!live && devs != null) { // drop devices the browser no longer lists (never under a running OpMode)
                        java.util.Set<String> keep = new java.util.HashSet<>();
                        for (JsonElement el : devs) keep.add(el.getAsJsonObject().get("name").getAsString());
                        for (String n : hardwareMap.names()) if (!keep.contains(n)) { hardwareMap.unregister(n); state.actuators.remove(n); }
                    }
                }
                break;
            }
            case "init": {
                driver = conn; // whoever INITs is the driver from now on
                String name = msg.get("opMode").getAsString();
                opModes.stream().filter(e -> e.name.equals(name)).findFirst().ifPresent(e -> runner.init(e, hardwareMap));
                break;
            }
            case "start": runner.start(); break;
            case "stop": runner.stop(); break;
            case "list": send(conn, opModesMessage()); send(conn, assetsMessage()); break;
            case "settingsLoad": send(conn, settingsMessage()); break;
            case "settingsSave": { // {text}: the twin's settings file (server mode): versioned next to the team's bindings
                JsonObject r = new JsonObject(); r.addProperty("type", "settingsSaved");
                try {
                    java.io.File f = settingsFile();
                    String text = msg.has("text") ? msg.get("text").getAsString() : "";
                    new JsonParser().parse(text);
                    if (f.getParentFile() != null) f.getParentFile().mkdirs();
                    java.nio.file.Files.writeString(f.toPath(), text);
                    r.addProperty("ok", true); r.addProperty("path", f.getAbsolutePath());
                    System.out.println("settings saved: " + f.getPath());
                } catch (Exception e) { r.addProperty("ok", false); r.addProperty("error", String.valueOf(e.getMessage() != null ? e.getMessage() : e)); }
                send(conn, r);
                broadcastJson(settingsMessage());
                break;
            }
            case "writeAsset": { // {path, text}: save the merged settings file where the robot build reads it (team assets root)
                String path = msg.has("path") ? msg.get("path").getAsString().replace('\\', '/') : "";
                String text = msg.has("text") ? msg.get("text").getAsString() : null;
                JsonObject r = new JsonObject(); r.addProperty("type", "assetWritten"); r.addProperty("path", path);
                try {
                    if (path.isBlank() || path.contains("..") || path.startsWith("/") || text == null || !path.endsWith(".json")) throw new IllegalArgumentException("refusing: path must be a relative .json asset");
                    new JsonParser().parse(text); // must still be JSON
                    java.io.File target = null;
                    String panelsRoot = System.getProperty("sim.panelsAssets", "");
                    for (String root : System.getProperty("sim.assets", "").split(",")) {
                        if (root.isBlank()) continue;
                        java.io.File dir = new java.io.File(root.trim());
                        if (!panelsRoot.isBlank() && dir.getAbsolutePath().equals(new java.io.File(panelsRoot).getAbsolutePath())) continue;
                        java.io.File f = new java.io.File(dir, path);
                        if (f.isFile() && f.getCanonicalPath().startsWith(dir.getCanonicalPath())) { target = f; break; }
                    }
                    if (target == null) throw new java.io.FileNotFoundException("no existing asset " + path + " under the team assets roots (only files that already exist are written)");
                    java.nio.file.Files.writeString(target.toPath(), text);
                    r.addProperty("ok", true); r.addProperty("file", target.getAbsolutePath());
                    System.out.println("asset written: " + target.getPath());
                } catch (Exception e) { r.addProperty("ok", false); r.addProperty("error", String.valueOf(e.getMessage() != null ? e.getMessage() : e)); }
                send(conn, r);
                broadcastJson(assetsMessage()); // every browser sees the new committed values
                break;
            }
            case "run": { // a finished run from the browser: keep it under runtime/runs/ for agents and later sessions
                try {
                    java.io.File dir = new java.io.File(System.getProperty("sim.runs", "runs")); dir.mkdirs();
                    JsonObject run = msg.getAsJsonObject("run");
                    String op = run.has("opMode") && !run.get("opMode").isJsonNull() ? run.get("opMode").getAsString().replaceAll("[^A-Za-z0-9]+", "-") : "keyboard";
                    String iso = run.has("startIso") ? run.get("startIso").getAsString().replace(":", "").replace("-", "").substring(0, 15) : String.valueOf(System.currentTimeMillis());
                    java.io.File f = new java.io.File(dir, iso + "-" + op + ".json");
                    java.nio.file.Files.writeString(f.toPath(), gson.toJson(run));
                    lastRunFile = f.getName();
                    System.out.println("run saved: " + f.getPath());
                    // keep the newest 40
                    java.io.File[] all = dir.listFiles((d, n) -> n.endsWith(".json"));
                    if (all != null && all.length > 40) { Arrays.sort(all, Comparator.comparing(java.io.File::getName)); for (int i = 0; i < all.length - 40; i++) all[i].delete(); }
                } catch (Exception e) { System.err.println("run save failed: " + e); }
                break;
            }
            case "agentReply": { // the browser answered an agent API request: {type, id, ok, result|error, contentType}
                CompletableFuture<JsonObject> f = msg.has("id") ? pending.remove(msg.get("id").getAsString()) : null;
                if (f != null) f.complete(msg);
                break;
            }
            case "assetOverrides": { // {overrides: {path: {dotted.key: value}}} from the browser's TeamCode settings panel
                Map<String, org.json.JSONObject> all = new HashMap<>();
                if (msg.has("overrides") && msg.get("overrides").isJsonObject())
                    for (Map.Entry<String, JsonElement> e : msg.getAsJsonObject("overrides").entrySet())
                        if (e.getValue().isJsonObject() && !e.getValue().getAsJsonObject().isEmpty()) all.put(e.getKey(), new org.json.JSONObject(gson.toJson(e.getValue())));
                SimHooks.setAssetOverrides(all);
                break;
            }
            default: break;
        }
    }

    private static boolean sameKind(com.qualcomm.robotcore.hardware.HardwareDevice d, String type) {
        if (type.matches(".*(DcMotor|DcMotorEx|DcMotorSimple).*")) return d instanceof com.qualcomm.robotcore.hardware.DcMotor;
        if (type.contains("CRServo")) return d instanceof com.qualcomm.robotcore.hardware.CRServo;
        if (type.matches(".*Servo.*")) return d instanceof com.qualcomm.robotcore.hardware.Servo;
        return false;
    }

    /** In-place update while an OpMode holds references: adjust ports/ticks of existing devices and add missing ones. */
    private void updateHardwareMap(JsonArray devices) {
        if (devices == null) return;
        for (JsonElement el : devices) {
            JsonObject d = el.getAsJsonObject();
            String name = d.get("name").getAsString(), kind = d.get("kind").getAsString();
            int port = d.has("port") ? d.get("port").getAsInt() : 0;
            com.qualcomm.robotcore.hardware.HardwareDevice existing = hardwareMap.get(name);
            if (existing instanceof Devices.SimMotor) { ((Devices.SimMotor) existing).port = port; if (d.has("ticksPerRev")) ((Devices.SimMotor) existing).ticksPerRev = d.get("ticksPerRev").getAsDouble(); continue; }
            if (existing instanceof Devices.SimServo) { ((Devices.SimServo) existing).port = port; continue; }
            if (existing instanceof Devices.SimCRServo) { ((Devices.SimCRServo) existing).port = port; continue; }
            if (existing != null) continue;
            switch (kind) {
                case "motor": hardwareMap.register(name, new Devices.SimMotor(name, state, d.has("ticksPerRev") ? d.get("ticksPerRev").getAsDouble() : 537.7, port)); break;
                case "servo": hardwareMap.register(name, new Devices.SimServo(name, state, port)); break;
                case "crservo": hardwareMap.register(name, new Devices.SimCRServo(name, state, port)); break;
                case "imu": hardwareMap.register(name, new Devices.SimImu(name, state)); break;
                case "webcam": hardwareMap.register(name, new Devices.SimWebcam(name)); break;
                case "distance": hardwareMap.register(name, new Devices.SimDistance(name, state)); break;
                case "touch": hardwareMap.register(name, new Devices.SimTouch(name)); break;
                default: break;
            }
        }
    }

    private HardwareMap buildHardwareMap(JsonArray devices) {
        HardwareMap map = new HardwareMap();
        state.actuators.clear();
        if (devices != null) for (JsonElement el : devices) {
            JsonObject d = el.getAsJsonObject();
            String name = d.get("name").getAsString(), kind = d.get("kind").getAsString();
            int port = d.has("port") ? d.get("port").getAsInt() : 0;
            switch (kind) {
                case "motor": map.register(name, new Devices.SimMotor(name, state, d.has("ticksPerRev") ? d.get("ticksPerRev").getAsDouble() : 537.7, port)); break;
                case "servo": map.register(name, new Devices.SimServo(name, state, port)); break;
                case "crservo": map.register(name, new Devices.SimCRServo(name, state, port)); break;
                case "imu": map.register(name, new Devices.SimImu(name, state)); break;
                case "webcam": map.register(name, new Devices.SimWebcam(name)); break;
                case "distance": map.register(name, new Devices.SimDistance(name, state)); break;
                case "touch": map.register(name, new Devices.SimTouch(name)); break;
                default: break;
            }
        }
        map.register("Control Hub", new Devices.SimVoltage(state));
        return map;
    }

    private JsonObject opModesMessage() {
        JsonObject m = new JsonObject(); m.addProperty("type", "opmodes");
        JsonArray arr = new JsonArray();
        for (OpModeScanner.Entry e : opModes) { JsonObject o = new JsonObject(); o.addProperty("name", e.name); o.addProperty("group", e.group); o.addProperty("flavor", e.flavor); o.addProperty("className", e.cls.getName()); arr.add(o); }
        m.add("opModes", arr);
        if (panels) m.addProperty("panelsUrl", PanelsBoot.URL);
        if (!AgentApi.URL.isEmpty()) m.addProperty("agentUrl", AgentApi.URL);
        return m;
    }

    // ---- agent API (AgentApi.java) -------------------------------------------------------------------------------
    // cadence of the browser's sensor packets (tags, encoders, gamepads): a gap over the team's camera-freshness
    // window looks to the OpMode like a stale camera, so it is measured here and reported by /api/status
    private long lastSensorNanos = 0, sensorGapMaxNanos = 0, sensorGapMax10sNanos = 0, sensorWindowStart = 0, firstSensorNanos = 0;
    private int sensorPackets10s = 0, sensorGapsOver300 = 0, sensorGapsOver100 = 0;
    private volatile JsonObject sensorStats = new JsonObject();
    private volatile JsonObject lastSensorsMsg;
    private int heldFrames = 0;
    private final JsonArray gapLog = new JsonArray();
    /** The browser's main thread can stall for a few hundred ms (a software-GL render, a big panel rebuild). The
     * simulated world does not advance during a stall, so the sensors are still true; re-stamping the last packet is
     * what a real camera does when it keeps seeing an unchanged scene. Held only for short stalls. */
    private final Object sensorLock = new Object();
    private volatile WebSocket driver; // the browser whose sensors and gamepads the OpMode sees
    private int ignoredSensorPackets = 0;
    private void holdSensorsIfStalled() {
        // under the same lock as the ws thread's ingest, so a held (older) packet can never land after a newer one
        synchronized (sensorLock) {
            JsonObject m = lastSensorsMsg;
            if (m == null || lastSensorNanos == 0) return;
            long gap = System.nanoTime() - lastSensorNanos;
            if (gap > 60_000_000L && gap < 2_000_000_000L) { state.ingest(m); heldFrames++; }
        }
    }
    private void noteSensorPacket() {
        long now = System.nanoTime();
        if (lastSensorNanos != 0) {
            long gap = now - lastSensorNanos;
            if (gap > sensorGapMaxNanos) sensorGapMaxNanos = gap;
            if (gap > sensorGapMax10sNanos) sensorGapMax10sNanos = gap;
            if (gap > 300_000_000L) sensorGapsOver300++;
            if (gap > 100_000_000L) { sensorGapsOver100++; if (gapLog.size() < 50) { JsonObject g = new JsonObject(); g.addProperty("gapMs", Math.round(gap / 1e6)); g.addProperty("atMs", Math.round((now - firstSensorNanos) / 1e6)); g.addProperty("status", runner.status().name()); gapLog.add(g); } }
        }
        if (firstSensorNanos == 0) firstSensorNanos = now;
        lastSensorNanos = now; sensorPackets10s++;
        if (sensorWindowStart == 0) sensorWindowStart = now;
        if (now - sensorWindowStart >= 10_000_000_000L) {
            JsonObject o = new JsonObject();
            o.addProperty("packetsPerSecond", Math.round(sensorPackets10s / ((now - sensorWindowStart) / 1e9)));
            o.addProperty("maxGapMsLast10s", Math.round(sensorGapMax10sNanos / 1e6));
            o.addProperty("maxGapMsEver", Math.round(sensorGapMaxNanos / 1e6));
            o.addProperty("gapsOver100msEver", sensorGapsOver100); o.addProperty("gapsOver300msEver", sensorGapsOver300);
            o.addProperty("heldFramesEver", heldFrames); o.add("gapsOver100ms", gapLog.deepCopy());
            sensorStats = o; sensorWindowStart = now; sensorPackets10s = 0; sensorGapMax10sNanos = 0;
        }
    }
    private java.io.File settingsFile() { return new java.io.File(System.getProperty("sim.settings", "twin-settings.json")); }
    /** {type:"settings", path, exists, text}: the repo's twin settings file as it is on disk right now. */
    public JsonObject settingsMessage() {
        JsonObject m = new JsonObject(); m.addProperty("type", "settings");
        java.io.File f = settingsFile();
        m.addProperty("path", f.getAbsolutePath()); m.addProperty("exists", f.isFile());
        if (f.isFile()) { try { m.addProperty("text", java.nio.file.Files.readString(f.toPath())); m.addProperty("modified", f.lastModified()); } catch (Exception e) { m.addProperty("error", String.valueOf(e)); } }
        return m;
    }
    public volatile String lastRunFile = "";
    public java.io.File runsDir() { return new java.io.File(System.getProperty("sim.runs", "runs")); }
    public boolean hasBrowser() { return !clients.isEmpty(); }
    public List<String> telemetry() { return lastTelemetry; }
    public JsonObject agentStatus() {
        JsonObject m = statusMessage(); m.remove("type");
        m.addProperty("browserConnected", hasBrowser());
        m.addProperty("browserClients", clients.size());
        m.addProperty("ignoredSensorPacketsFromOtherClients", ignoredSensorPackets);
        JsonObject ss = sensorStats.deepCopy(); if (lastSensorNanos != 0) ss.addProperty("sinceLastPacketMs", Math.round((System.nanoTime() - lastSensorNanos) / 1e6)); m.add("sensors", ss);
        m.add("opModes", opModesMessage().get("opModes"));
        if (panels) m.addProperty("panelsUrl", PanelsBoot.URL);
        m.addProperty("agentUrl", AgentApi.URL);
        return m;
    }
    public JsonArray logTail(int n) {
        JsonArray a = new JsonArray();
        synchronized (logRing) { int skip = Math.max(0, logRing.size() - n); int i = 0; for (JsonObject o : logRing) if (i++ >= skip) a.add(o); }
        return a;
    }
    /** Forward an action to the (first) connected browser and wait for its reply; null on timeout. */
    public JsonObject askBrowser(String action, JsonObject params, long timeoutMs) {
        WebSocket target = null;
        for (WebSocket c : clients) if (c.isOpen()) { target = c; break; }
        if (target == null) return null;
        String id = UUID.randomUUID().toString();
        CompletableFuture<JsonObject> f = new CompletableFuture<>();
        pending.put(id, f);
        JsonObject m = new JsonObject(); m.addProperty("type", "agent"); m.addProperty("id", id); m.addProperty("action", action); m.add("params", params);
        send(target, m);
        try { return f.get(timeoutMs, TimeUnit.MILLISECONDS); } catch (Exception e) { pending.remove(id); return null; }
    }
    /** Every JSON asset under the sim.assets roots (not the .sim.json variants), with its text, for the browser's settings panel. */
    private JsonObject assetsMessage() {
        JsonObject m = new JsonObject(); m.addProperty("type", "assets");
        JsonArray files = new JsonArray();
        String panelsRoot = System.getProperty("sim.panelsAssets", "");
        for (String root : System.getProperty("sim.assets", "").split(",")) {
            if (root.isBlank()) continue;
            java.io.File dir = new java.io.File(root.trim());
            if (!dir.isDirectory()) continue;
            // Panels' unpacked web UI lives on the same asset path so its StaticServer can serve it, but it is not a
            // robot setting: keep it out of the TeamCode settings panel
            if (!panelsRoot.isBlank() && dir.getAbsolutePath().equals(new java.io.File(panelsRoot).getAbsolutePath())) continue;
            if (dir.getAbsolutePath().replace('\\', '/').endsWith("/panels/build/panels/assets")) continue;
            try (java.util.stream.Stream<java.nio.file.Path> walk = java.nio.file.Files.walk(dir.toPath())) {
                walk.filter(p -> p.toString().endsWith(".json") && !p.toString().endsWith(".sim.json") && java.nio.file.Files.isRegularFile(p)).sorted().forEach(p -> {
                    try {
                        if (java.nio.file.Files.size(p) > 200_000) return;
                        JsonObject f = new JsonObject();
                        f.addProperty("path", dir.toPath().relativize(p).toString().replace('\\', '/'));
                        f.addProperty("text", java.nio.file.Files.readString(p));
                        files.add(f);
                    } catch (Exception ignored) {}
                });
            } catch (Exception ignored) {}
        }
        m.add("files", files);
        // the team's twin-bindings.json (asset keys derived from twin knobs), re-read every time so edits show up on reconnect
        String bindings = System.getProperty("sim.bindings", "");
        if (!bindings.isBlank()) {
            java.io.File f = new java.io.File(bindings);
            if (f.isFile()) { try { JsonObject b = new JsonObject(); b.addProperty("path", f.getName()); b.addProperty("text", java.nio.file.Files.readString(f.toPath())); m.add("bindings", b); } catch (Exception ignored) {} }
        }
        return m;
    }
    private JsonObject statusMessage() {
        JsonObject m = new JsonObject(); m.addProperty("type", "status"); m.addProperty("status", runner.status().name()); m.addProperty("opMode", runner.currentName()); m.addProperty("error", runner.error()); return m;
    }
    private JsonObject telemetryMessage(List<String> lines) {
        JsonObject m = new JsonObject(); m.addProperty("type", "telemetry"); m.add("lines", gson.toJsonTree(lines)); return m;
    }
    /** A line the host printed (OpMode output, RobotLog, exceptions): {type:"log", level, text, millis}. */
    public void broadcastLog(String level, String text) {
        JsonObject m = new JsonObject(); m.addProperty("type", "log"); m.addProperty("level", level); m.addProperty("text", text); m.addProperty("millis", System.currentTimeMillis());
        synchronized (logRing) { logRing.addLast(m); while (logRing.size() > LOG_RING) logRing.removeFirst(); }
        if (clients.isEmpty()) return;
        broadcastJson(m);
    }
    private void send(WebSocket c, JsonObject o) { try { if (c.isOpen()) c.send(gson.toJson(o)); } catch (Exception ignored) {} }
    private void broadcastJson(JsonObject o) { String s = gson.toJson(o); for (WebSocket c : clients) try { if (c.isOpen()) c.send(s); } catch (Exception ignored) {} }
}
