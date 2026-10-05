package org.firstinspires.ftc.robotcore.external.stream;

import android.graphics.Bitmap;
import org.firstinspires.ftc.robotcore.external.function.Consumer;
import org.firstinspires.ftc.robotcore.external.function.Continuation;

/** Anything that can hand a frame to a dashboard camera stream. */
public interface CameraStreamSource { void getFrameBitmap(Continuation<? extends Consumer<Bitmap>> continuation); }
