// Build requirements (the IntelliJ Platform Gradle Plugin 2.16 needs Gradle 9+):
//   - Gradle >= 9.0
//   - a JDK 21 available to Gradle (set JAVA_HOME to a JDK 21, or register one
//     via org.gradle.java.installations.paths). Gradle uses it for the
//     jvmToolchain(21) the build declares.
// (A toolchain auto-resolver is intentionally not used: the versions that
// support Gradle 9 are not yet stable here, so a real JDK 21 is required.)

rootProject.name = "azerothjs-jetbrains"
