package com.qualcomm.robotcore.eventloop.opmode;
import java.lang.annotation.*;
@Retention(RetentionPolicy.RUNTIME) @Target(ElementType.TYPE)
public @interface TeleOp { String name() default ""; String group() default ""; }
