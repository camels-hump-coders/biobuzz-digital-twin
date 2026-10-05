package com.qualcomm.hardware.rev;
import com.qualcomm.robotcore.hardware.ImuOrientationOnRobot;
public class RevHubOrientationOnRobot implements ImuOrientationOnRobot {
    public enum LogoFacingDirection { UP, DOWN, FORWARD, BACKWARD, LEFT, RIGHT }
    public enum UsbFacingDirection { UP, DOWN, FORWARD, BACKWARD, LEFT, RIGHT }
    public final LogoFacingDirection logo; public final UsbFacingDirection usb;
    public RevHubOrientationOnRobot(LogoFacingDirection logo, UsbFacingDirection usb) { this.logo = logo; this.usb = usb; }
    public RevHubOrientationOnRobot(org.firstinspires.ftc.robotcore.external.navigation.Orientation o) { this.logo = LogoFacingDirection.UP; this.usb = UsbFacingDirection.FORWARD; }
}
