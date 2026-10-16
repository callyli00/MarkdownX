import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction
import javax.inject.Inject
import org.gradle.process.ExecOperations

abstract class BuildTask : DefaultTask() {
    @get:Inject
    abstract val execOperations: ExecOperations

    @Input
    var rootDirRel: String? = null
    @Input
    var projectDir: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        // On Windows `npm` is a shell script backed by npm.cmd, and CreateProcess - which is what
        // Gradle's exec uses - can start neither a .cmd nor a .bat (only real executables). So
        // none of the old fallback candidates (`npm`, `npm.exe`, `npm.cmd`, `npm.bat`) could be
        // spawned, and the chain reported the LAST one it tried: "Cannot run program npm.bat
        // ... CreateProcess error=2". That reads as "npm is not installed" even though it is,
        // which is why this task was being skipped with `-x rustBuild*` - and skipping it also
        // skipped the Kotlin generation it performs, leaving MainActivity's `TauriActivity`
        // unresolved. Route the call through the command interpreter instead.
        val windows = Os.isFamily(Os.FAMILY_WINDOWS)
        runTauriCli(if (windows) "cmd" else "npm", if (windows) listOf("/c", "npm") else emptyList())
    }

    fun runTauriCli(executable: String, prefixArgs: List<String> = emptyList()) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val args = prefixArgs + listOf("run", "--", "tauri", "android", "android-studio-script");

        execOperations.exec {
            workingDir(File(projectDir, rootDirRel))
            executable(executable)
            args(args)
            if (logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}