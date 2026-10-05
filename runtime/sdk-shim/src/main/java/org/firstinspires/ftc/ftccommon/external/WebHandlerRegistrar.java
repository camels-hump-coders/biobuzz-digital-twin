package org.firstinspires.ftc.ftccommon.external;

import java.lang.annotation.*;

/** FTC SDK lifecycle hook annotation; the desktop host invokes the hooks it knows about explicitly. */
@Retention(RetentionPolicy.RUNTIME) @Target(ElementType.METHOD)
public @interface WebHandlerRegistrar {}
