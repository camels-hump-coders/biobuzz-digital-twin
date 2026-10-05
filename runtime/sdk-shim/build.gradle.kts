plugins { `java-library` }
dependencies {
    // Android ships org.json in the platform; on the desktop we use the reference implementation (same API).
    api("org.json:json:20240303")
}
