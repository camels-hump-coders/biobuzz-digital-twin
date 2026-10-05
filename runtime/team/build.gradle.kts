// Compiles the team's TeamCode sources against sdk-shim.
// Usage: ./gradlew :host:run -PteamCode=/path/to/FtcRobotController/TeamCode/src/main/java [-PteamExclude="**/Foo*.java,**/roadrunner/**"]
val teamCode: String? = (findProperty("teamCode") as String?)?.takeIf { it.isNotBlank() }
val teamExclude: List<String> = ((findProperty("teamExclude") as String?) ?: "").split(",").map { it.trim() }.filter { it.isNotEmpty() }

dependencies { implementation(project(":sdk-shim")) }

sourceSets {
    main {
        java {
            setSrcDirs(if (teamCode != null) listOf(file(teamCode)) else emptyList<File>())
            exclude(teamExclude)
        }
    }
}

tasks.named<JavaCompile>("compileJava") {
    doFirst {
        if (teamCode == null) logger.lifecycle("team: no -PteamCode given; only the sample OpModes will be available")
        else logger.lifecycle("team: compiling TeamCode from $teamCode" + (if (teamExclude.isNotEmpty()) " excluding $teamExclude" else ""))
    }
}
