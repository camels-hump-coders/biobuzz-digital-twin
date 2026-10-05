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

    public SimLink(int port, List<OpModeScanner.Entry> opModes) {
        super(new InetSocketAddress("127.0.0.1", port));
        this.opModes = opModes;
        SimHooks.setTagSource(state);
        SimHooks.setFrameSource(state);
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
        exec.scheduleAtFixedRate(() -> { if (!clients.isEmpty()) broadcastJson(state.actuatorMessage()); }, 20, 20, TimeUnit.MILLISECONDS);
    }

    @Override public void onOpen(WebSocket conn, ClientHandshake hs) {
        clients.add(conn);
        send(conn, opModesMessage()); send(conn, statusMessage()); send(conn, telemetryMessage(lastTelemetry)); send(conn, assetsMessage());
        System.out.println("browser connected from " + conn.getRemoteSocketAddress());
    }
    @Override public void onClose(WebSocket conn, int code, String reason, boolean remote) { clients.remove(conn); if (clients.isEmpty()) runner.stop(); }
    @Override public void onError(WebSocket conn, Exception ex) { System.err.println("link error: " + ex); }
    @Override public void onStart() { System.out.println("BIOBUZZ runtime listening on ws://127.0.0.1:" + getPort() + "  (" + opModes.size() + " OpModes)"); }

    @Override public void onMessage(WebSocket conn, String message) {
        JsonObject msg;
        try { msg = JsonParser.parseString(message).getAsJsonObject(); } catch (Exception e) { return; }
        String type = msg.has("type") ? msg.get("type").getAsString() : "";
        switch (type) {
            case "sensors":
                state.ingest(msg);
                runner.updateGamepads(msg.getAsJsonObject("gamepad1"), msg.getAsJsonObject("gamepad2"));
                break;
            case "hardware": { // the browser's hardware map: [{name, kind, ticksPerRev, port}] plus preset hints
                if (msg.has("hints") && msg.get("hints").isJsonObject()) hints = msg.getAsJsonObject("hints");
                String j = gson.toJson(msg.getAsJsonArray("devices"));
                if (!j.equals(hardwareJson)) {
                    hardwareJson = j;
                    boolean live = runner.status() == OpModeRunner.Status.RUNNING || runner.status() == OpModeRunner.Status.INIT;
                    if (live) updateHardwareMap(msg.getAsJsonArray("devices")); // keep the OpMode's device objects, refresh ports/ticks, add new
                    else hardwareMap = buildHardwareMap(msg.getAsJsonArray("devices"));
                }
                break;
            }
            case "init": {
                String name = msg.get("opMode").getAsString();
                opModes.stream().filter(e -> e.name.equals(name)).findFirst().ifPresent(e -> runner.init(e, hardwareMap));
                break;
            }
            case "start": runner.start(); break;
            case "stop": runner.stop(); break;
            case "list": send(conn, opModesMessage()); send(conn, assetsMessage()); break;
            case "frame": { // JPEG of a simulated webcam: {camera, jpeg (base64), nanos}
                try { state.setFrame(msg.get("camera").getAsString(), Base64.getDecoder().decode(msg.get("jpeg").getAsString()), msg.has("nanos") ? msg.get("nanos").getAsLong() : System.nanoTime()); } catch (Exception ignored) {}
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
        return m;
    }
    /** Every JSON asset under the sim.assets roots (not the .sim.json variants), with its text, for the browser's settings panel. */
    private JsonObject assetsMessage() {
        JsonObject m = new JsonObject(); m.addProperty("type", "assets");
        JsonArray files = new JsonArray();
        for (String root : System.getProperty("sim.assets", "").split(",")) {
            if (root.isBlank()) continue;
            java.io.File dir = new java.io.File(root.trim());
            if (!dir.isDirectory()) continue;
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
        m.add("files", files); return m;
    }
    private JsonObject statusMessage() {
        JsonObject m = new JsonObject(); m.addProperty("type", "status"); m.addProperty("status", runner.status().name()); m.addProperty("opMode", runner.currentName()); m.addProperty("error", runner.error()); return m;
    }
    private JsonObject telemetryMessage(List<String> lines) {
        JsonObject m = new JsonObject(); m.addProperty("type", "telemetry"); m.add("lines", gson.toJsonTree(lines)); return m;
    }
    private void send(WebSocket c, JsonObject o) { try { if (c.isOpen()) c.send(gson.toJson(o)); } catch (Exception ignored) {} }
    private void broadcastJson(JsonObject o) { String s = gson.toJson(o); for (WebSocket c : clients) try { if (c.isOpen()) c.send(s); } catch (Exception ignored) {} }
}
