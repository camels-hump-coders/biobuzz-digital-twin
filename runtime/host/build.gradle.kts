plugins { application }
dependencies {
    implementation(project(":sdk-shim"))
    implementation(project(":panels")) // the real FTC Panels dashboard, served by the host on :8001/:8002
    implementation("org.java-websocket:Java-WebSocket:1.5.7")
    implementation("com.google.code.gson:gson:2.11.0")
    implementation("org.slf4j:slf4j-simple:2.0.16")
    // OpMode sources to run: the samples by default, plus the team module when present
    runtimeOnly(project(":samples"))
    runtimeOnly(project(":team"))
}
tasks.named<JavaExec>("run") {
    // TeamCode assets (hardwareMap.appContext.getAssets()) and the SharedPreferences store
    dependsOn(":panels:extractPanels")
    // asset roots: the team\'s assets first, then Panels\' unpacked web UI so its StaticServer can list and serve it
    val panelsAssets = project(":panels").layout.buildDirectory.dir("panels/assets").get().asFile.path
    systemProperty("sim.assets", listOfNotNull((findProperty("simAssets") as String?)?.takeIf { it.isNotBlank() }, panelsAssets).joinToString(","))
    systemProperty("sim.panelsAssets", panelsAssets) // not a team asset: hidden from the TeamCode settings panel
    systemProperty("sim.panels", (findProperty("simPanels") as String?) ?: "true")
    systemProperty("sim.runs", rootProject.file("runs").absolutePath) // finished runs from the browser, for agents and later sessions
    systemProperty("sim.bindings", (findProperty("simBindings") as String?) ?: "")
    systemProperty("sim.settings", (findProperty("simSettings") as String?) ?: rootProject.file("twin-settings.json").absolutePath) // the twin's settings file (server mode)
    // SIM_DEBUG=true prints OpMode lifecycle notifications and turns on Panels' own logs
    systemProperty("sim.debugLifecycle", System.getenv("SIM_DEBUG") ?: "false")
    systemProperty("sim.prefs", (findProperty("simPrefs") as String?) ?: layout.projectDirectory.dir("../.sim-prefs").asFile.path)
}

application {
    mainClass.set("org.biobuzz.sim.host.Main")
    applicationDefaultJvmArgs = listOf("-Dorg.slf4j.simpleLogger.defaultLogLevel=warn")
}
