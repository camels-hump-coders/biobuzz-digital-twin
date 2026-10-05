package org.biobuzz.sim.host;

import com.qualcomm.robotcore.eventloop.opmode.Autonomous;
import com.qualcomm.robotcore.eventloop.opmode.Disabled;
import com.qualcomm.robotcore.eventloop.opmode.OpMode;
import com.qualcomm.robotcore.eventloop.opmode.TeleOp;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.Modifier;
import java.nio.file.*;
import java.util.*;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

/** Finds @TeleOp / @Autonomous OpMode classes on the classpath (directories and jars). */
public class OpModeScanner {
    public static class Entry {
        public final String name, group, flavor; public final Class<? extends OpMode> cls;
        Entry(String n, String g, String f, Class<? extends OpMode> c) { name = n; group = g; flavor = f; cls = c; }
    }

    public static List<Entry> scan() {
        List<Entry> out = new ArrayList<>();
        Set<String> classNames = new TreeSet<>();
        for (String cp : System.getProperty("java.class.path").split(File.pathSeparator)) {
            File f = new File(cp);
            if (f.isDirectory()) collectDir(f.toPath(), f.toPath(), classNames);
            else if (f.getName().endsWith(".jar") && !isLibraryJar(f.getName())) collectJar(f, classNames);
        }
        for (String cn : classNames) {
            try {
                Class<?> c = Class.forName(cn, false, OpModeScanner.class.getClassLoader());
                if (!OpMode.class.isAssignableFrom(c) || Modifier.isAbstract(c.getModifiers())) continue;
                if (c.isAnnotationPresent(Disabled.class)) continue;
                TeleOp t = c.getAnnotation(TeleOp.class);
                Autonomous a = c.getAnnotation(Autonomous.class);
                if (t == null && a == null) continue;
                String name = t != null ? t.name() : a.name();
                if (name.isEmpty()) name = c.getSimpleName();
                @SuppressWarnings("unchecked") Class<? extends OpMode> oc = (Class<? extends OpMode>) c;
                out.add(new Entry(name, t != null ? t.group() : a.group(), t != null ? "TeleOp" : "Autonomous", oc));
            } catch (Throwable ignored) { /* classes that fail to load are not OpModes we can run */ }
        }
        out.sort(Comparator.comparing((Entry e) -> e.flavor).thenComparing(e -> e.name));
        return out;
    }
    private static boolean isLibraryJar(String n) {
        return n.startsWith("gson") || n.startsWith("Java-WebSocket") || n.startsWith("slf4j") || n.startsWith("sdk-shim");
    }
    private static void collectDir(Path root, Path dir, Set<String> out) {
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
            for (Path p : ds) {
                if (Files.isDirectory(p)) collectDir(root, p, out);
                else if (p.toString().endsWith(".class")) out.add(toClassName(root.relativize(p).toString()));
            }
        } catch (IOException ignored) {}
    }
    private static void collectJar(File jar, Set<String> out) {
        try (JarFile jf = new JarFile(jar)) {
            Enumeration<JarEntry> en = jf.entries();
            while (en.hasMoreElements()) { JarEntry e = en.nextElement(); if (e.getName().endsWith(".class")) out.add(toClassName(e.getName())); }
        } catch (IOException ignored) {}
    }
    private static String toClassName(String path) { return path.replace('/', '.').replace(File.separatorChar, '.').replaceAll("\\.class$", ""); }
}
