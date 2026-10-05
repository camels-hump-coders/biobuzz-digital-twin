subprojects {
    apply(plugin = "java")
    repositories {
        // Google's mirror of Maven Central first (Central itself rate-limits some networks), then Central
        maven { url = uri("https://maven-central.storage-download.googleapis.com/maven2/") }
        mavenCentral()
    }
    tasks.withType<JavaCompile>().configureEach {
        options.release.set(17)
        options.encoding = "UTF-8"
    }
}
