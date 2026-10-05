package com.qualcomm.robotcore.eventloop.opmode;
import java.lang.annotation.*;
@Retention(RetentionPolicy.RUNTIME) @Target(ElementType.TYPE)
public @interface Autonomous { String name() default ""; String group() default ""; String preselectTeleOp() default ""; }
