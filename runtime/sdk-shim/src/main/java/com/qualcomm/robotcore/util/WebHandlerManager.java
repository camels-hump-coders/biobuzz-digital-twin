package com.qualcomm.robotcore.util;

import java.util.LinkedHashMap;
import java.util.Map;

/** Registry the robot controller's web server exposes to @WebHandlerRegistrar hooks. The desktop host keeps the registrations but serves nothing. */
public class WebHandlerManager {
    public final Map<String, Object> handlers = new LinkedHashMap<>();
    public void register(String path, Object handler) { handlers.put(path, handler); }
}
