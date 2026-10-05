plugins { application }
dependencies {
    implementation(project(":sdk-shim"))
    implementation("org.java-websocket:Java-WebSocket:1.5.7")
    implementation("com.google.code.gson:gson:2.11.0")
    implementation("org.slf4j:slf4j-simple:2.0.16")
    // OpMode sources to run: the samples by default, plus the team module when present
    runtimeOnly(project(":samples"))
    runtimeOnly(project(":team"))
}
tasks.named<JavaExec>("run") {
    // TeamCode assets (hardwareMap.appContext.getAssets()) and the SharedPreferences store
    systemProperty("sim.assets", (findProperty("simAssets") as String?) ?: "")
    systemProperty("sim.prefs", (findProperty("simPrefs") as String?) ?: layout.projectDirectory.dir("../.sim-prefs").asFile.path)
}

application {
    mainClass.set("org.biobuzz.sim.host.Main")
    applicationDefaultJvmArgs = listOf("-Dorg.slf4j.simpleLogger.defaultLogLevel=warn")
}
