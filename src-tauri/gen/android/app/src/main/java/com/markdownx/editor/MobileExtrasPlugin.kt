package com.markdownx.editor

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.print.PrintManager
import android.provider.Settings
import android.webkit.WebView
import androidx.core.content.FileProvider
import app.tauri.Logger
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * The two capabilities an Android WebView cannot provide on its own.
 *
 * 1. **Printing.** `window.print()` is a silent no-op in an Android WebView (no dialog, no
 *    error, nothing in the console) and tauri's `Webview::print()` is `#[cfg(desktop)]`.
 *    The real facility is Android's print service: `PrintManager` + the WebView's own
 *    `createPrintDocumentAdapter`, which runs the SAME Chromium print pipeline the desktop
 *    build uses. That matters: the app's `@media print` stylesheet (hides every piece of
 *    chrome, flattens the layout, A4 `@page`) is what produces a clean document, so the
 *    printout here is the desktop printout, not a screenshot of the phone UI.
 *
 * 2. **Updating.** `tauri-plugin-updater` supports Windows/macOS/Linux only, so the APK
 *    path is ours: fetch `latest.json`, let Rust decide whether it is newer, download the
 *    APK into the app cache, then hand it to the system installer. Signature enforcement is
 *    Android's own: `PackageManager` refuses an APK whose signing certificate differs from
 *    the installed app's, so a tampered download cannot be installed over MarkdownX.
 *
 * Invoked from Rust (`run_mobile_plugin`), never from JS directly. Every command answers on
 * the main thread: `run_mobile_plugin` blocks a Rust thread until the `Invoke` resolves, and
 * resolving from a worker thread would exercise JNI attach paths for no benefit.
 */
@InvokeArg
class FetchTextArgs {
  lateinit var url: String
}

@InvokeArg
class InstallUpdateArgs {
  lateinit var url: String
  lateinit var version: String
}

@TauriPlugin
class MobileExtrasPlugin(private val activity: Activity) : Plugin(activity) {
  private var webView: WebView? = null

  // Download state. Written by the download thread, read by `downloadState` from another
  // thread, hence @Volatile on every field.
  @Volatile private var phase: String = "idle"
  @Volatile private var downloaded: Long = 0
  @Volatile private var total: Long = -1
  @Volatile private var lastError: String? = null
  @Volatile private var targetVersion: String = ""

  override fun load(webView: WebView) {
    this.webView = webView
  }

  // ---------------------------------------------------------------- printing

  @Command
  fun printDocument(invoke: Invoke) {
    val view = webView
    if (view == null) {
      invoke.reject("WebView 尚未就绪，无法打印")
      return
    }
    Handler(Looper.getMainLooper()).post {
      try {
        // A unique job name per invocation: Android keeps finished jobs in the print
        // history and reusing a name makes consecutive prints hard to tell apart.
        val jobName = "MarkdownX-" + System.currentTimeMillis()
        val printManager = activity.getSystemService(Context.PRINT_SERVICE) as PrintManager
        // The adapter snapshots the (untouched) WebView when the job actually runs, i.e.
        // after the user picks a printer in the system dialog - so nothing here may mutate
        // the DOM afterwards. The print stylesheet does all the work by itself.
        printManager.print(jobName, view.createPrintDocumentAdapter(jobName), null)
        invoke.resolve()
      } catch (e: Exception) {
        Logger.error(Logger.tags("MobileExtrasPlugin"), "failed to start print job", e)
        invoke.reject(e.message ?: "调用系统打印服务失败")
      }
    }
  }

  // ----------------------------------------------------------------- updates

  /** One manifest body as text; parsing and the version decision live in Rust. */
  @Command
  fun fetchText(invoke: Invoke) {
    val args = invoke.parseArgs(FetchTextArgs::class.java)
    Thread {
      try {
        val text = httpGetText(args.url)
        postToMain {
          val result = JSObject()
          result.put("text", text)
          invoke.resolve(result)
        }
      } catch (e: Exception) {
        postToMain { invoke.reject(e.message ?: "网络请求失败") }
      }
    }.start()
  }

  /**
   * Start downloading the APK and return at once. The frontend polls [downloadState] and the
   * installer is launched from the download thread when the bytes are complete.
   */
  @Command
  fun installUpdate(invoke: Invoke) {
    val args = invoke.parseArgs(InstallUpdateArgs::class.java)

    // "Install unknown apps" is off by default on Android 8+. Ask for it BEFORE spending
    // 20+ MB of the user's data on a download that could not be installed anyway.
    if (!canInstallPackages()) {
      phase = "permission"
      openUnknownSourcesSettings()
      postToMain { invoke.resolve(stateObject()) }
      return
    }

    if (phase == "downloading" || phase == "done") {
      // A second tap must not start a second download of the same file.
      postToMain { invoke.resolve(stateObject()) }
      return
    }

    phase = "downloading"
    downloaded = 0
    total = -1
    lastError = null
    targetVersion = args.version

    Thread {
      try {
        downloadApk(args.url, args.version)
      } catch (e: Exception) {
        Logger.error(Logger.tags("MobileExtrasPlugin"), "apk download failed", e)
        lastError = e.message ?: "下载失败"
        phase = "error"
      }
    }.start()

    postToMain { invoke.resolve(stateObject()) }
  }

  @Command
  fun downloadState(invoke: Invoke) {
    postToMain { invoke.resolve(stateObject()) }
  }

  private fun downloadApk(url: String, version: String) {
    val dir = File(activity.cacheDir, "updates")
    if (!dir.isDirectory && !dir.mkdirs()) {
      throw IllegalStateException("无法创建更新缓存目录：${dir.absolutePath}")
    }
    val name = apkFileName(version)
    // Superseded packages are dead weight on a phone; drop every other apk first.
    dir.listFiles()?.forEach { if (it.name != name) it.delete() }

    val target = File(dir, name)
    val partial = File(dir, "$name.part")
    partial.delete()

    val connection = URL(url).openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = 15000
      connection.readTimeout = 30000
      connection.instanceFollowRedirects = true
      connection.setRequestProperty("User-Agent", "MarkdownX-Android-Updater")
      // No transparent decompression in HttpURLConnection: asking for identity keeps the
      // byte count in `downloaded` equal to what is actually written to disk.
      connection.setRequestProperty("Accept-Encoding", "identity")
      val code = connection.responseCode
      if (code != HttpURLConnection.HTTP_OK) {
        throw IllegalStateException("下载失败：HTTP $code")
      }
      total = connection.contentLengthLong
      connection.inputStream.use { input ->
        FileOutputStream(partial).use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            downloaded += read
          }
          output.flush()
        }
      }
    } finally {
      connection.disconnect()
    }

    if (total > 0 && partial.length() != total) {
      throw IllegalStateException("下载不完整（${partial.length()}/$total 字节）")
    }
    if (target.exists()) target.delete()
    if (!partial.renameTo(target)) {
      partial.copyTo(target, overwrite = true)
      partial.delete()
    }
    phase = "done"
    postToMain { launchInstaller(target) }
  }

  private fun launchInstaller(apk: File) {
    try {
      // The FileProvider declared by the Tauri template (`${applicationId}.fileprovider`)
      // with a `cache-path` root: the apk lives in cacheDir, so no extra provider config and
      // no storage permission is involved.
      val uri = FileProvider.getUriForFile(
        activity,
        activity.packageName + ".fileprovider",
        apk
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      activity.startActivity(intent)
      phase = "installer"
    } catch (e: Exception) {
      Logger.error(Logger.tags("MobileExtrasPlugin"), "failed to launch installer", e)
      lastError = e.message ?: "无法启动系统安装器"
      phase = "error"
    }
  }

  private fun canInstallPackages(): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      activity.packageManager.canRequestPackageInstalls()
    } else {
      // Before Android 8 the permission is granted at install time; nothing to ask for.
      true
    }

  private fun openUnknownSourcesSettings() {
    try {
      val intent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:" + activity.packageName)
      )
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.startActivity(intent)
    } catch (e: Exception) {
      // No such screen on some vendors' ROMs; the retry will simply ask again.
      Logger.error(Logger.tags("MobileExtrasPlugin"), "cannot open unknown-sources settings", e)
    }
  }

  private fun stateObject(): JSObject {
    val state = JSObject()
    state.put("phase", phase)
    state.put("downloaded", downloaded)
    state.put("total", total)
    state.put("error", lastError)
    state.put("version", targetVersion)
    return state
  }

  private fun apkFileName(version: String): String {
    val safe = version.replace(Regex("[^0-9A-Za-z._-]"), "_")
    return "MarkdownX-$safe.apk"
  }

  private fun httpGetText(url: String): String {
    val connection = URL(url).openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = 12000
      connection.readTimeout = 20000
      connection.instanceFollowRedirects = true
      connection.setRequestProperty("User-Agent", "MarkdownX-Android-Updater")
      connection.setRequestProperty("Accept-Encoding", "identity")
      connection.setRequestProperty("Cache-Control", "no-cache")
      val code = connection.responseCode
      if (code != HttpURLConnection.HTTP_OK) {
        throw IllegalStateException("HTTP $code：$url")
      }
      return connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    } finally {
      connection.disconnect()
    }
  }

  private fun postToMain(block: () -> Unit) {
    Handler(Looper.getMainLooper()).post(block)
  }
}
