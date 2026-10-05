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
    private final Set<WebSocket> clients = ConcurrentHashMap.newKeySet();
    private final ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor(r -> { Thread t = new Thread(r, "sim-link"); t.setDaemon(true); return t; });
    private volatile List<String> lastTelemetry = Collections.emptyList();

    public SimLink(int port, List<OpModeScanner.Entry> opModes) {
        super(new InetSocketAddress("127.0.0.1", port));
        this.opModes = opModes;
        SimHooks.setTagSource(state);
        runner = new OpModeRunner(state, lines -> { lastTelemetry = lines; broadcastJson(telemetryMessage(lines)); }, s -> broadcastJson(statusMessage()));
        setReuseAddr(true);
        exec.scheduleAtFixedRate(() -> { if (!clients.isEmpty()) broadcastJson(state.actuatorMessage()); }, 20, 20, TimeUnit.MILLISECONDS);
    }

    @Override public void onOpen(WebSocket conn, ClientHandshake hs) {
        clients.add(conn);
        send(conn, opModesMessage()); send(conn, statusMessage()); send(conn, telemetryMessage(lastTelemetry));
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
            case "hardware": { // the browser's hardware map: [{name, kind, ticksPerRev}]; rebuild only when it actually changed
                String j = gson.toJson(msg.getAsJsonArray("devices"));
                if (!j.equals(hardwareJson)) { hardwareJson = j; if (runner.status() == OpModeRunner.Status.RUNNING || runner.status() == OpModeRunner.Status.INIT) runner.stop(); hardwareMap = buildHardwareMap(msg.getAsJsonArray("devices")); }
                break;
            }
            case "init": {
                String name = msg.get("opMode").getAsString();
                opModes.stream().filter(e -> e.name.equals(name)).findFirst().ifPresent(e -> runner.init(e, hardwareMap));
                break;
            }
            case "start": runner.start(); break;
            case "stop": runner.stop(); break;
            case "list": send(conn, opModesMessage()); break;
            default: break;
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
        m.add("opModes", arr); return m;
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
