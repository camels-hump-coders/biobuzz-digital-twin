package com.qualcomm.robotcore.hardware;

/** Gamepad state, mirrored from the browser (Gamepad API or keyboard emulation). */
public class Gamepad {
    public float left_stick_x, left_stick_y, right_stick_x, right_stick_y;
    public boolean dpad_up, dpad_down, dpad_left, dpad_right;
    public boolean a, b, x, y, guide, start, back, left_bumper, right_bumper, left_stick_button, right_stick_button;
    public float left_trigger, right_trigger;
    // PS-style aliases
    public boolean circle, cross, triangle, square, share, options, touchpad, ps;
    public float touchpad_finger_1_x, touchpad_finger_1_y;
    public boolean touchpad_finger_1;
    public long timestamp;
    public byte user = 1;
    public String id = "sim";

    public boolean atRest() {
        return left_stick_x == 0 && left_stick_y == 0 && right_stick_x == 0 && right_stick_y == 0 && left_trigger == 0 && right_trigger == 0;
    }
    public void copy(Gamepad o) {
        left_stick_x = o.left_stick_x; left_stick_y = o.left_stick_y; right_stick_x = o.right_stick_x; right_stick_y = o.right_stick_y;
        dpad_up = o.dpad_up; dpad_down = o.dpad_down; dpad_left = o.dpad_left; dpad_right = o.dpad_right;
        a = o.a; b = o.b; x = o.x; y = o.y; guide = o.guide; start = o.start; back = o.back;
        left_bumper = o.left_bumper; right_bumper = o.right_bumper; left_stick_button = o.left_stick_button; right_stick_button = o.right_stick_button;
        left_trigger = o.left_trigger; right_trigger = o.right_trigger; timestamp = o.timestamp;
        syncAliases();
    }
    public void syncAliases() { cross = a; circle = b; square = x; triangle = y; share = back; options = start; ps = guide; }
    // rumble / LED are no-ops in the sim
    public void rumble(int ms) {}
    public void rumble(double l, double r, int ms) {}
    public void rumbleBlips(int n) {}
    public void stopRumble() {}
    public boolean isRumbling() { return false; }
    public void setLedColor(double r, double g, double b, int ms) {}
    public static final int RUMBLE_DURATION_CONTINUOUS = -1;
    public static final int LED_DURATION_CONTINUOUS = -1;
    @Override public String toString() { return String.format("lx=%.2f ly=%.2f rx=%.2f ry=%.2f a=%b b=%b x=%b y=%b", left_stick_x, left_stick_y, right_stick_x, right_stick_y, a, b, x, y); }
}
