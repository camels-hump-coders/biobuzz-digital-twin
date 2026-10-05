package com.qualcomm.ftccommon;

import com.qualcomm.robotcore.eventloop.opmode.OpModeManagerImpl;

/** The robot controller's event loop, as handed to @OnCreateEventLoop hooks. The desktop host builds one around its runner. */
public class FtcEventLoop {
    private final OpModeManagerImpl opModeManager;
    public FtcEventLoop(OpModeManagerImpl opModeManager) { this.opModeManager = opModeManager; }
    public OpModeManagerImpl getOpModeManager() { return opModeManager; }
}
