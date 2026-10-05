package org.firstinspires.ftc.robotcore.internal.opmode;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/** The SDK's registry of OpModes; the desktop host fills it from its scanner. */
public class RegisteredOpModes {
    private static final RegisteredOpModes INSTANCE = new RegisteredOpModes();
    private final List<OpModeMeta> opModes = new CopyOnWriteArrayList<>();
    public static RegisteredOpModes getInstance() { return INSTANCE; }
    public void setOpModes(List<OpModeMeta> metas) { opModes.clear(); opModes.addAll(metas); }
    public List<OpModeMeta> getOpModes() { return new ArrayList<>(opModes); }
    public void waitOpModesRegistered() {}
    public boolean areOpModesRegistered() { return true; }
}
