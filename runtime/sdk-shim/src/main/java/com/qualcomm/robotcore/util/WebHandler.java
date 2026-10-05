package com.qualcomm.robotcore.util;

/** FTC SDK web handler (NanoHTTPD based on the robot). Not served on the desktop. */
public interface WebHandler { Object getResponse(Object session) throws java.io.IOException; }
