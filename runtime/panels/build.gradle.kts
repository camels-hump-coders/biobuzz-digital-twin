// The real FTC Panels dashboard (com.bylazar), straight from its Maven repository. The AARs are Android libraries, but
// their code is plain Kotlin on NanoHTTPD, so the desktop host can run them: this module unpacks each AAR's classes and
// bundled web assets, adds the JVM libraries Panels needs, and supplies the two small shadow classes (a classpath
// scanner instead of the APK dex scanner, a no-op for the robot-controller screen text).
plugins { `java-library` }

repositories {
    maven { url = uri("https://mymaven.bylazar.com/releases"); content { includeGroup("com.bylazar") } }
}

// core + the plugins fullpanels 1.0.13 ships (the ones that do not need a real robot: battery, lights, gamepad and the
// Limelight proxy are left out). Field/camerastream are the newer builds whose AARs include the browser assets.
val panelsArtifacts = mapOf(
    "panels" to "1.0.5", "telemetry" to "1.0.5", "field" to "1.0.10", "camerastream" to "1.0.2", "graph" to "1.0.4",
    "configurables" to "1.0.5", "opmodecontrol" to "1.0.3", "capture" to "1.0.3", "themes" to "1.0.3", "docs" to "1.0.5",
    "utils" to "1.0.4", "pinger" to "1.0.3",
)
val panelsAars: Configuration by configurations.creating { isTransitive = false }

val classesDir = layout.buildDirectory.dir("panels/classes")
val assetsDir = layout.buildDirectory.dir("panels/assets")

val extractPanels by tasks.registering {
    description = "Unpack the Panels AARs: classes to build/panels/classes, web assets to build/panels/assets"
    inputs.files(panelsAars)
    outputs.dir(classesDir); outputs.dir(assetsDir)
    doLast {
        delete(classesDir, assetsDir)
        panelsAars.files.forEach { aar ->
            val classesJar = zipTree(aar).matching { include("classes.jar") }.singleFile
            copy { from(zipTree(classesJar)) { exclude("META-INF/**") }; into(classesDir) }
            copy { from(zipTree(aar)) { include("assets/**"); includeEmptyDirs = false; eachFile { path = path.removePrefix("assets/") } }; into(assetsDir) }
        }
    }
}
tasks.named("compileJava") { dependsOn(extractPanels) }
tasks.named("processResources") { dependsOn(extractPanels) }

dependencies {
    panelsArtifacts.forEach { (artifact, version) -> panelsAars("com.bylazar:$artifact:$version@aar") }
    // the unpacked Panels classes ride along with this module for everything that depends on it
    api(files(classesDir).builtBy(extractPanels))
    api("org.jetbrains.kotlin:kotlin-stdlib:2.1.20")
    api("org.jetbrains.kotlin:kotlin-reflect:2.1.20")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.8.1")
    api("com.google.code.gson:gson:2.11.0")
    api("org.nanohttpd:nanohttpd:2.3.1")
    api("org.nanohttpd:nanohttpd-websocket:2.3.1")
    api("org.tukaani:xz:1.9")
    compileOnly(project(":sdk-shim"))
}

/** Where the unpacked web assets live; the host adds this to the asset roots so Panels can serve its UI. */
val panelsAssetsDir: Provider<Directory> = assetsDir
extensions.add("panelsAssetsDir", panelsAssetsDir)
