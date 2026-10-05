package com.bylazar.panels.reflection;

import kotlin.jvm.functions.Function1;

import java.io.File;
import java.util.*;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

/**
 * Shadows Panels' ClassFinder (which reads the APK's dex files) with a classpath scanner. Same API, same class name, so
 * Panels and its plugins find plugins, plugin configs and @Configurable classes exactly as on the robot.
 */
public final class ClassFinder {
    public static final ClassFinder INSTANCE = new ClassFinder();
    private static final Set<String> DEFAULT_IGNORED_PACKAGES = new LinkedHashSet<>(Arrays.asList(
        "java.", "javax.", "jdk.", "sun.", "kotlin.", "kotlinx.", "org.jetbrains.", "com.google.", "fi.iki.", "org.json.", "org.java_websocket.",
        "org.slf4j.", "org.tukaani.", "android.", "androidx.", "org.biobuzz.sim.host.", "com.qualcomm.", "org.firstinspires.ftc.robotcore.", "org.firstinspires.ftc.vision.", "org.firstinspires.ftc.ftccommon."));
    private static String apkPath = "";
    private static List<ClassEntry> allClasses = Collections.emptyList();
    private ClassFinder() {}

    public static final class ClassEntry {
        private final String className;
        public ClassEntry(String className) { this.className = className; }
        public String getClassName() { return className; }
        public String component1() { return className; }
        public ClassEntry copy(String name) { return new ClassEntry(name); }
        @Override public String toString() { return "ClassEntry(className=" + className + ")"; }
        @Override public int hashCode() { return className.hashCode(); }
        @Override public boolean equals(Object o) { return o instanceof ClassEntry && ((ClassEntry) o).className.equals(className); }
    }

    public Set<String> getDEFAULT_IGNORED_PACKAGES() { return DEFAULT_IGNORED_PACKAGES; }
    public String getApkPath() { return apkPath; }
    public void setApkPath(String p) { apkPath = p; }
    public List<ClassEntry> getAllClasses() { return allClasses; }
    public void setAllClasses(List<ClassEntry> l) { allClasses = l; }

    /** @param ignoredApkPath the robot passes the APK path; here the classpath is scanned */
    public synchronized void init(String ignoredApkPath) {
        apkPath = ignoredApkPath == null ? "" : ignoredApkPath;
        if (!allClasses.isEmpty()) return;
        List<ClassEntry> out = new ArrayList<>();
        for (String entry : System.getProperty("java.class.path", "").split(File.pathSeparator)) {
            File f = new File(entry);
            if (f.isDirectory()) walk(f, f, out);
            else if (f.isFile() && f.getName().endsWith(".jar")) scanJar(f, out);
        }
        allClasses = out;
    }
    private static void walk(File root, File dir, List<ClassEntry> out) {
        File[] kids = dir.listFiles(); if (kids == null) return;
        for (File k : kids) { if (k.isDirectory()) walk(root, k, out); else if (k.getName().endsWith(".class")) add(root.toPath().relativize(k.toPath()).toString(), out); }
    }
    private static void scanJar(File jar, List<ClassEntry> out) {
        try (JarFile j = new JarFile(jar)) { for (Enumeration<JarEntry> en = j.entries(); en.hasMoreElements();) { String n = en.nextElement().getName(); if (n.endsWith(".class")) add(n, out); } } catch (Exception ignored) {}
    }
    private static void add(String path, List<ClassEntry> out) {
        String name = path.replace(File.separatorChar, '.').replace('/', '.');
        name = name.substring(0, name.length() - ".class".length());
        if (name.equals("module-info") || name.endsWith("package-info")) return;
        for (String p : DEFAULT_IGNORED_PACKAGES) if (name.startsWith(p)) return;
        out.add(new ClassEntry(name));
    }

    public List<ClassEntry> findClasses(Function1<? super Class<?>, Boolean> predicate) {
        if (allClasses.isEmpty()) init(apkPath);
        List<ClassEntry> out = new ArrayList<>();
        ClassLoader loader = Thread.currentThread().getContextClassLoader() != null ? Thread.currentThread().getContextClassLoader() : ClassFinder.class.getClassLoader();
        for (ClassEntry e : allClasses) {
            try {
                Class<?> c = Class.forName(e.getClassName(), false, loader);
                if (predicate == null || Boolean.TRUE.equals(predicate.invoke(c))) out.add(e);
            } catch (Throwable ignored) { /* missing dependency, broken static init, etc.: not a candidate */ }
        }
        return out;
    }
    /** Kotlin default-argument bridge: findClasses() with no predicate. */
    public static List<ClassEntry> findClasses$default(ClassFinder self, Function1<? super Class<?>, Boolean> predicate, int mask, Object marker) {
        return self.findClasses((mask & 1) != 0 ? null : predicate);
    }
}
