// Compiles the team's TeamCode sources against sdk-shim.
// Usage: ./gradlew :host:run -PteamCode=/path/to/FtcRobotController/TeamCode/src/main/java [-PteamExclude="**/Foo*.java,**/roadrunner/**"]
val teamCode: String? = (findProperty("teamCode") as String?)?.takeIf { it.isNotBlank() }
val teamExclude: List<String> = ((findProperty("teamExclude") as String?) ?: "").split(",").map { it.trim() }.filter { it.isNotEmpty() }
// Optional sim overrides: <TeamCode>/src/sim/java mirrors main; any file present there replaces the main one.
val teamSim: String? = (findProperty("teamSim") as String?)?.takeIf { it.isNotBlank() && file(it).isDirectory }
val overridden: List<String> = teamSim?.let { dir -> fileTree(dir).matching { include("**/*.java") }.files.map { it.relativeTo(file(dir)).path } } ?: emptyList()

dependencies { implementation(project(":sdk-shim")); implementation(project(":panels")) }

sourceSets {
    main {
        java {
            setSrcDirs(listOfNotNull(teamCode?.let { file(it) }, teamSim?.let { file(it) }))
            exclude(teamExclude)
            // exclude the main copies of overridden files (the sim copy keeps the same relative path)
            exclude { el -> !el.isDirectory && el.file.path.startsWith(file(teamCode ?: "/nonexistent").path) && overridden.contains(el.relativePath.pathString) }
        }
    }
}

tasks.named<JavaCompile>("compileJava") {
    doFirst {
        if (teamCode == null) logger.lifecycle("team: no -PteamCode given; only the sample OpModes will be available")
        else logger.lifecycle("team: compiling TeamCode from $teamCode" + (if (teamExclude.isNotEmpty()) " excluding ${teamExclude.size} pattern(s)" else "") + (if (overridden.isNotEmpty()) "; sim overrides: $overridden" else ""))
    }
}
