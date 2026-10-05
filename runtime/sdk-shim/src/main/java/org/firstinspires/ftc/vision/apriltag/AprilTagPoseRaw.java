package org.firstinspires.ftc.vision.apriltag;
import org.firstinspires.ftc.robotcore.external.matrices.MatrixF;
/** Raw pose in the OpenCV camera frame: x right, y down, z forward; R rotates tag axes into camera axes. */
public class AprilTagPoseRaw { public double x, y, z; public MatrixF R = MatrixF.identityMatrix(3); }
