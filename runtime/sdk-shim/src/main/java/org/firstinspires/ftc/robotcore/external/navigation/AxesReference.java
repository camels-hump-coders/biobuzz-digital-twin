package org.firstinspires.ftc.robotcore.external.navigation;
public enum AxesReference { EXTRINSIC, INTRINSIC; public AxesReference reverse() { return this == EXTRINSIC ? INTRINSIC : EXTRINSIC; } }
