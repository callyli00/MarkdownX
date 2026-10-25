// Every import here is used only by desktop-only code paths: the on-disk file watcher,
// the devtools opener and the always-on-top toggle. Mobile compiles none of them, so the
// whole block is gated to keep the Android build warning-free.
#[cfg(desktop)]
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
#[cfg(desktop)]
use std::collections::HashMap;
// Deliberately NOT gated, unlike the rest of this block: the workspace-index commands
// compile on every target, so `Path`/`PathBuf` must exist for Android too. They used to
// sit inside the desktop block because only the watcher needed them.
use std::path::{Path, PathBuf};
#[cfg(desktop)]
use std::sync::Mutex;
#[cfg(desktop)]
use tauri::{AppHandle, Emitter, Manager, State};
// Android needs `Manager` on its own: this is the only place it calls `app.manage(...)`.
#[cfg(target_os = "android")]
use tauri::Manager;

// Reading the update manifest and deciding "is this newer" - pure logic, unit-tested on the
// host. See the module docs for why the network half lives in Kotlin instead.
mod android_update;

#[derive(serde::Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Desktop-only: owns the `notify` watcher that reloads a document when it changes on
/// disk. Mobile has no watcher at all (the commands below are no-ops there).
#[cfg(desktop)]
#[derive(Default)]
pub struct WatcherState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    watched_paths: Mutex<HashMap<String, PathBuf>>,
}

#[tauri::command]
fn get_cli_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

/// What a path handed to the app actually is: a workspace FOLDER, a document, or nothing.
///
/// The app accepts either on the command line (and on drop). Passing a folder opens it as
/// the workspace - the root the sidebar tree, the wiki index and the backlink panels all
/// build on. Before this the only way in was the OS folder picker, a native dialog that no
/// script (and therefore no automated smoke test) can answer.
#[tauri::command]
fn path_kind(path: String) -> String {
    let candidate = PathBuf::from(&path);
    if candidate.is_dir() {
        "dir".to_string()
    } else if candidate.is_file() {
        "file".to_string()
    } else {
        "missing".to_string()
    }
}

/// The platform this binary was compiled for. The frontend gates desktop-only
/// affordances (workspace folder tree, auto-update, always-on-top) on this instead of
/// guessing from a user agent.
#[tauri::command]
fn get_host_platform() -> &'static str {
    platform_name()
}

/// Careful: none of these values may be reported by two branches - the frontend treats
/// "mobile" and "desktop" as disjoint sets.
fn platform_name() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

#[tauri::command]
fn read_file_from_path(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_dir_files(dir_path: String) -> Result<Vec<FileEntry>, String> {
    let p = std::path::Path::new(&dir_path);
    if !p.is_dir() {
        return Err("Not a valid directory".to_string());
    }
    let mut entries = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(p) {
        for entry in read_dir.flatten() {
            let item_path = entry.path();
            let is_dir = item_path.is_dir();
            let name = item_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            if is_dir {
                if !name.starts_with('.') && name != "node_modules" && name != "target" {
                    entries.push(FileEntry {
                        name,
                        path: item_path.to_string_lossy().to_string(),
                        is_dir: true,
                    });
                }
            } else {
                let ext = item_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if ["md", "markdown", "txt", "pdf", "png", "jpg", "jpeg", "svg", "tex"].contains(&ext.as_str()) {
                    entries.push(FileEntry {
                        name,
                        path: item_path.to_string_lossy().to_string(),
                        is_dir: false,
                    });
                }
            }
        }
    }
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });
    Ok(entries)
}

// ---------------------------------------------------------------------------
// Workspace index: one walk, then one batched read
// ---------------------------------------------------------------------------
// The backlink / tag / unresolved-link panels need the whole workspace flattened into a
// path list, then the text of every note in that list. Two commands, both pure blocking
// `std::fs` work.
//
// Both are declared `#[tauri::command(async)]` while keeping a plain `fn` signature: a
// command without that marker runs on the main thread, so a walk of a network share would
// freeze the window for its entire duration. The marker is what moves the body onto the
// sync thread pool; the generated argument parsing is unchanged.
//
// Unlike the watcher, the font list or the Android bridge above, nothing here has a
// platform-specific twin: only `std::path`/`std::fs` are used, so one implementation
// compiles for Windows and Android alike and there is no `#[cfg(...)]` pair to keep in
// sync. Paths are always built by joining `PathBuf`s - never by pasting a `/` or `\` -
// because the two targets disagree about the separator.

#[derive(serde::Serialize)]
pub struct ScannedFile {
    pub path: String,
    /// Unix seconds. 0 means "unknown" (the stat failed), not "epoch".
    pub mtime: i64,
    pub size: u64,
}

#[derive(serde::Serialize)]
pub struct ReadTextResult {
    pub path: String,
    pub content: Option<String>,
    pub error: Option<String>,
}

/// Returned as a partial result instead of an error once reached, so a 100k-file share
/// still yields a usable index rather than blank panels.
const MAX_SCAN_FILES: usize = 20_000;
const MAX_SCAN_DEPTH: usize = 32;

/// Above this a file is reported as an error rather than read. 4 MiB because the index
/// only needs links/headings/tags, and the whole result travels back over one IPC reply.
const MAX_TEXT_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// Notes and attachments the index cares about. Compared case-insensitively: `IMG.JPG`
/// off a camera roll or a Windows share must match, or the preview shows a broken embed
/// that the file browser happily lists.
const INDEX_EXTENSIONS: [&str; 22] = [
    // notes
    "md", "markdown", "mdown", "mkd", "mdx", "txt", // attachments
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "pdf", "mp3", "mp4", "wav",
    "webm", "ogg", "m4a", "mov",
];

/// Directories that never hold workspace content. `.git`, `.obsidian`, `.hg` and `.svn`
/// are already caught by the dot-prefix rule below; they stay listed so the intent
/// survives if that rule is ever loosened. The rest are build output that is merely
/// expensive to walk: on a share with a checked-out project, `node_modules` alone can
/// swallow the whole file budget.
const SKIPPED_DIRS: [&str; 8] = [
    ".git", ".obsidian", "node_modules", "dist", "target", ".hg", ".svn", "__pycache__",
];

fn is_indexable_file(path: &Path) -> bool {
    match path.extension().and_then(|ext| ext.to_str()) {
        // `to_ascii_lowercase` rather than `to_lowercase`: file extensions are ASCII, and
        // this runs once per entry on a potentially huge listing.
        Some(ext) => INDEX_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

fn is_skipped_dir(name: &str) -> bool {
    // Anything dot-prefixed is tooling/VCS/per-user metadata by convention on every
    // platform we ship. Walking it can dominate the scan (an `.obsidian` plugin cache is
    // thousands of JSON files that would never be indexed anyway).
    name.starts_with('.') || SKIPPED_DIRS.contains(&name)
}

fn push_scanned_file(
    files: &mut Vec<ScannedFile>,
    path: &Path,
    meta: Option<std::fs::Metadata>,
) {
    files.push(ScannedFile {
        path: path.to_string_lossy().to_string(),
        // Metadata can vanish between the directory listing and the stat (deleted, or an
        // SMB handle that just expired). 0 keeps the entry: the index treats the file as
        // present-but-undated, which is far better than dropping a note whose links other
        // files point at.
        mtime: meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
        size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
    });
}

#[tauri::command(async)]
fn scan_workspace_files(root: String) -> Result<Vec<ScannedFile>, String> {
    scan_workspace_files_with_caps(&root, MAX_SCAN_FILES, MAX_SCAN_DEPTH)
}

/// The walk itself, with both caps as parameters.
///
/// Split out of the command purely so the caps are testable: a fixture with three files and
/// `max_files = 1` proves the cap yields a PARTIAL list rather than an error or a silent
/// truncation that looks like a complete index.
fn scan_workspace_files_with_caps(
    root: &str,
    max_files: usize,
    max_depth: usize,
) -> Result<Vec<ScannedFile>, String> {
    let root_path = PathBuf::from(root);
    if !root_path.is_dir() {
        // The only failure this command reports: the caller handed us something that is
        // not a directory at all. Everything that merely went *partially* wrong below
        // comes back as a short list plus a stderr note.
        return Err(format!("Not a directory: {root}"));
    }

    let mut files: Vec<ScannedFile> = Vec::new();
    // An explicit stack instead of recursion. Depth is capped at 32, but width is not,
    // and Android's default thread stack is far smaller than the desktop's - a deep
    // share should not turn a scan into a stack overflow.
    let mut stack: Vec<(PathBuf, usize)> = vec![(root_path, 0)];
    let mut hit_file_cap = false;
    let mut hit_depth_cap = false;
    let mut unreadable_dirs = 0usize;

    while let Some((dir, depth)) = stack.pop() {
        if files.len() >= max_files {
            hit_file_cap = true;
            break;
        }
        // One directory that refuses to list must cost only its own subtree. Permissions
        // errors and dropped SMB sessions are routine on the shares this app is pointed
        // at, so an `Err` here must never fail the whole scan.
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => {
                unreadable_dirs += 1;
                continue;
            }
        };

        for entry in entries.flatten() {
            if files.len() >= max_files {
                hit_file_cap = true;
                break;
            }
            // `file_type()` reports the link itself and does not stat the target, which
            // is both cheaper and the only way to spot a directory symlink before we
            // walk into it.
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();

            if file_type.is_symlink() {
                // A symlinked directory is the one real cycle hazard: a junction on a
                // mapped drive can point back at an ancestor, and the walk would then
                // spend its whole file budget re-reading the same tree. Symlinked *files*
                // are ordinary notes/attachments, so they stay - stat through the link so
                // size and mtime describe the target.
                if path.is_dir() {
                    continue;
                }
                if is_indexable_file(&path) {
                    push_scanned_file(&mut files, &path, path.metadata().ok());
                }
                continue;
            }

            if file_type.is_dir() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if is_skipped_dir(&name) {
                    continue;
                }
                if depth + 1 > max_depth {
                    hit_depth_cap = true;
                    continue;
                }
                stack.push((path, depth + 1));
            } else if file_type.is_file() && is_indexable_file(&path) {
                // `DirEntry::metadata` reuses what the directory listing already returned
                // where the platform provides it, and does not follow links - both matter
                // when the walk itself is the slow part.
                push_scanned_file(&mut files, &path, entry.metadata().ok());
            }
        }
    }

    // Sorted so a re-scan of an untouched workspace produces byte-identical output; the
    // frontend diffs against its previous index to decide what to re-parse.
    files.sort_by(|a, b| a.path.cmp(&b.path));

    // Partial results are deliberate (`Ok`, not `Err`): an incomplete index still powers
    // the panels, whereas an error blanks them. The reason goes to stderr because the
    // command's `Result` is reserved for a bad `root`.
    if hit_file_cap {
        eprintln!(
            "[workspace-scan] stopped at the {max_files}-file cap; returning a partial index ({} files)",
            files.len()
        );
    }
    if hit_depth_cap {
        eprintln!(
            "[workspace-scan] directories deeper than {max_depth} levels were not walked"
        );
    }
    if unreadable_dirs > 0 {
        eprintln!("[workspace-scan] skipped {unreadable_dirs} unreadable directories");
    }

    Ok(files)
}

#[tauri::command(async)]
fn read_text_files(paths: Vec<String>) -> Result<Vec<ReadTextResult>, String> {
    let mut results = Vec::with_capacity(paths.len());
    for path in paths {
        results.push(read_one_text_file(path));
    }
    // Never `Err`: the caller builds an index from whatever succeeded, and turning one
    // bad path into a failed batch would discard the other N-1 files for no reason.
    Ok(results)
}

fn read_one_text_file(path: String) -> ReadTextResult {
    // Owned copy on purpose: every branch below moves `path` into the reply, and borrowing
    // it from a long-lived `Path` fights the borrow checker for no gain - one small
    // allocation is nothing next to the file read that follows.
    let file_path = PathBuf::from(&path);

    if let Ok(meta) = std::fs::metadata(&file_path) {
        if meta.is_dir() {
            return ReadTextResult {
                path,
                content: None,
                error: Some("Is a directory".to_string()),
            };
        }
        if meta.len() > MAX_TEXT_FILE_BYTES {
            // Rejected before opening it, so a multi-GB file renamed to `.md` cannot be
            // pulled into memory on the IPC thread just to be discarded afterwards.
            return ReadTextResult {
                path,
                content: None,
                error: Some(format!(
                    "File is {} bytes, over the {MAX_TEXT_FILE_BYTES}-byte indexing limit",
                    meta.len()
                )),
            };
        }
    }

    let bytes = match std::fs::read(&file_path) {
        Ok(bytes) => bytes,
        Err(err) => {
            return ReadTextResult {
                path,
                content: None,
                error: Some(err.to_string()),
            }
        }
    };

    // Re-checked after the read: the file may have grown between the stat above and here,
    // or the stat may have failed while the read succeeded.
    if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
        // Deliberately an error instead of a truncated body: half a note would put
        // backlinks on text that does not exist and headings on lines that were cut.
        return ReadTextResult {
            path,
            content: None,
            error: Some(format!(
                "File is {} bytes, over the {MAX_TEXT_FILE_BYTES}-byte indexing limit",
                bytes.len()
            )),
        };
    }

    match String::from_utf8(bytes) {
        Ok(text) => ReadTextResult {
            path,
            content: Some(text),
            error: None,
        },
        Err(err) => {
            // Legacy notes here are frequently GBK, which is not UTF-8. Lossy decoding
            // keeps the ASCII-ish parts (wikilinks, tag syntax, headings) searchable and
            // makes the CJK noise instead of dropping the file; the error tells the caller
            // the text is approximate rather than exact.
            let text = String::from_utf8_lossy(err.as_bytes()).into_owned();
            ReadTextResult {
                path,
                content: Some(text),
                error: Some("Not valid UTF-8; decoded lossily".to_string()),
            }
        }
    }
}

#[cfg(desktop)]
#[tauri::command]
fn toggle_fullscreen(window: tauri::Window) -> Result<bool, String> {
    let current = window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(!current).map_err(|e| e.to_string())?;
    Ok(!current)
}

// `Window::set_fullscreen` does not exist on mobile in tauri 2.12.1 (only
// `is_fullscreen` does), so this cannot share one implementation. Worth noting the
// giveaway that the capability namespace alone would NOT have revealed:
// `core:window:allow-set-fullscreen` IS listed among the mobile permissions, but the API
// it gates is compiled out - so granting it on Android would be meaningless.
#[cfg(not(desktop))]
#[tauri::command]
fn toggle_fullscreen() -> Result<bool, String> {
    Ok(false)
}

#[cfg(desktop)]
#[tauri::command]
fn toggle_always_on_top(window: tauri::Window, enable: bool) -> Result<bool, String> {
    window.set_always_on_top(enable).map_err(|e| e.to_string())?;
    Ok(enable)
}

// A phone has no always-on-top concept. The command still exists so shared frontend code
// can call it on every platform without ever hitting "command not found".
#[cfg(not(desktop))]
#[tauri::command]
fn toggle_always_on_top(_enable: bool) -> Result<bool, String> {
    Ok(false)
}

#[cfg(desktop)]
#[tauri::command]
fn open_devtools(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main").or_else(|| app.webview_windows().values().next().cloned()) {
        window.open_devtools();
    }
}

// On mobile the WebView is inspected through chrome://inspect (remote debugging), not
// through an in-app devtools window. Keep the command so the menu entry cannot throw.
#[cfg(not(desktop))]
#[tauri::command]
fn open_devtools() {}

#[cfg(desktop)]
#[tauri::command]
fn start_watching_file(
    app: AppHandle,
    state: State<'_, WatcherState>,
    file_path: String,
) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Ok(());
    }

    let mut watcher_lock = state.watcher.lock().map_err(|e| e.to_string())?;
    let mut paths_lock = state.watched_paths.lock().map_err(|e| e.to_string())?;

    if paths_lock.contains_key(&file_path) {
        return Ok(());
    }

    if watcher_lock.is_none() {
        let app_clone = app.clone();
        let watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    match event.kind {
                        EventKind::Modify(_) | EventKind::Create(_) => {
                            for p in event.paths {
                                let path_str = p.to_string_lossy().to_string();
                                let _ = app_clone.emit("file-modified-on-disk", path_str);
                            }
                        }
                        _ => {}
                    }
                }
            },
            Config::default(),
        )
        .map_err(|e| e.to_string())?;

        *watcher_lock = Some(watcher);
    }

    if let Some(ref mut w) = *watcher_lock {
        let _ = w.watch(&path, RecursiveMode::NonRecursive);
        paths_lock.insert(file_path, path);
    }

    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn stop_watching_file(
    state: State<'_, WatcherState>,
    file_path: String,
) -> Result<(), String> {
    let mut watcher_lock = state.watcher.lock().map_err(|e| e.to_string())?;
    let mut paths_lock = state.watched_paths.lock().map_err(|e| e.to_string())?;

    if let Some(path) = paths_lock.remove(&file_path) {
        if let Some(ref mut w) = *watcher_lock {
            let _ = w.unwatch(&path);
        }
    }

    Ok(())
}

// Mobile: no watcher exists, so both commands succeed as no-ops. They stay in the
// handler list so the frontend's fire-and-forget calls never error.
#[cfg(not(desktop))]
#[tauri::command]
fn start_watching_file(_file_path: String) -> Result<(), String> {
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
fn stop_watching_file(_file_path: String) -> Result<(), String> {
    Ok(())
}

// List the font families installed on this machine by reading the Windows
// registry Fonts key. Returns the primary face name of each entry (the label
// before the parenthetical, e.g. "宋体 & NSimSun" -> "宋体", "Segoe UI Bold"
// -> "Segoe UI") sorted case-insensitively, with icon/symbol fonts dropped.
// The frontend uses this to let the user pick from the fonts actually present,
// instead of a hardcoded list.
#[cfg(windows)]
#[tauri::command]
fn list_system_fonts() -> Result<Vec<String>, String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let root = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut fonts: Result<RegKey, String> =
        Err("Fonts registry key not found".to_string());
    for path in [
        "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Fonts",
    ] {
        if let Ok(sub) = root.open_subkey(path) {
            fonts = Ok(sub);
            break;
        }
    }
    let fonts = fonts?;

    let mut names: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for res in fonts.enum_values() {
        let (name, _) = res.map_err(|e| e.to_string())?;
        // The label is like "Segoe UI (TrueType)" or "宋体 & NSimSun (TrueType)".
        let paren = name.find('(').unwrap_or(name.len());
        let mut family = name[..paren].trim().to_string();
        if family.is_empty() {
            continue;
        }
        // The label can combine multiple faces; keep the primary one only.
        family = family
            .split(" & ")
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        // Collapse a recognized trailing style token ("Segoe UI Bold" -> "Segoe
        // UI") so every weight of a family becomes a single selectable entry.
        family = strip_style_token(&family);
        if family.is_empty() {
            continue;
        }
        let upper = family.to_uppercase();
        if ICON_SYMBOL_FONTS.iter().any(|s| upper.contains(*s)) {
            continue;
        }
        if seen.insert(family.clone()) {
            names.push(family);
        }
    }
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(names)
}

#[cfg(windows)]
const ICON_SYMBOL_FONTS: [&str; 8] = [
    "Segoe MDL2 Assets", "Segoe Fluent Icons", "Segoe Material", "Webdings",
    "Wingdings", "Symbol", "Marlett", "Segoe Icons",
];

// Last whitespace-separated word of `s` (or "" if none). Rust String has no
// `rsplit_whitespace`, so reimplement the small piece we need.
#[cfg(windows)]
fn last_word(s: &str) -> Option<&str> {
    s.split_whitespace().next_back()
}

#[cfg(windows)]
fn strip_style_token(s: &str) -> String {
    let mut result = s.trim().to_string();
    loop {
        let lower = result.to_lowercase();
        let last = last_word(&lower).unwrap_or("");
        let is_style = matches!(
            last,
            "bold"
                | "italic"
                | "light"
                | "semilight"
                | "semibold"
                | "extrabold"
                | "black"
                | "thin"
                | "medium"
                | "regular"
                | "demibold"
                | "deminlight"
        );
        if !is_style {
            break;
        }
        result = result[..result.len() - last.len()].trim_end().to_string();
    }
    result
}

/// Android and iOS expose no enumerable, user-installable font list, so there is nothing
/// to read. Return the families the shipped WebView is guaranteed to resolve, plus the CJK
/// families the app bundles, so the typography inspector still offers a usable set
/// instead of an empty dropdown.
#[cfg(not(windows))]
#[tauri::command]
fn list_system_fonts() -> Result<Vec<String>, String> {
    Ok(vec![
        "system-ui".to_string(),
        "sans-serif".to_string(),
        "serif".to_string(),
        "monospace".to_string(),
        "Noto Sans SC".to_string(),
        "Noto Serif SC".to_string(),
    ])
}

// ---------------------------------------------------------------------------
// Android native bridge
// ---------------------------------------------------------------------------
// Two things the WebView cannot do on Android and that are therefore implemented in Kotlin
// (`gen/android/app/src/main/java/com/markdownx/editor/MobileExtrasPlugin.kt`):
//
//   1. Printing. `window.print()` in an Android WebView is a silent no-op (no error, no
//      dialog, no console output) - the tauri `Webview::print()` API it would map to is
//      `#[cfg(desktop)]`. The real facility is Android's print service.
//   2. Updating. `tauri-plugin-updater` does not support Android, so the APK update path is
//      ours: fetch `latest.json`, compare versions here, download the APK, hand it to the
//      system installer (Android itself enforces that the signature matches the installed
//      app, so a tampered APK cannot be installed over it).
//
// The frontend reaches this through ordinary app commands (`native_print`, …) rather than
// `plugin:` commands: app commands are already allowed for this local-origin window, so no
// capability entry is involved and there is no ACL that can silently deny the call. The
// Kotlin class is still registered through a Tauri plugin *wrapper* because
// `register_android_plugin` only exists on a plugin's `PluginApi` - that wrapper declares
// no commands of its own.

/// Handle to the Kotlin plugin instance, held in managed state.
#[cfg(target_os = "android")]
#[derive(Clone)]
struct MobileNative(tauri::plugin::PluginHandle<tauri::Wry>);

/// Body text as returned by the Kotlin `fetchText` command.
#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct FetchedText {
    text: String,
}

/// Reply of `android_update_check`, shaped for the JS side.
#[cfg(target_os = "android")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidUpdateCheck {
    available: bool,
    current_version: String,
    version: String,
    notes: String,
    url: String,
}

/// Run a Kotlin command off the async runtime's core threads: `run_mobile_plugin` blocks
/// until Kotlin resolves, and the fetch half of an update check can take seconds.
#[cfg(target_os = "android")]
async fn call_native<T>(
    handle: tauri::plugin::PluginHandle<tauri::Wry>,
    command: &'static str,
    payload: serde_json::Value,
) -> Result<T, String>
where
    T: serde::de::DeserializeOwned + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        handle
            .run_mobile_plugin::<T>(command, payload)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The updater endpoints already configured for the desktop updater
/// (`tauri.conf.json → plugins.updater.endpoints`), read back from the merged runtime
/// config so Android and desktop can never be pointed at different manifests.
#[cfg(target_os = "android")]
fn update_manifest_urls(app: &tauri::AppHandle) -> Vec<String> {
    let Some(updater) = app.config().plugins.0.get("updater") else {
        return Vec::new();
    };
    match updater.get("endpoints") {
        Some(serde_json::Value::String(single)) => vec![single.clone()],
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn native_print(state: tauri::State<'_, MobileNative>) -> Result<(), String> {
    call_native::<serde_json::Value>(
        state.0.clone(),
        "printDocument",
        serde_json::json!({}),
    )
    .await
    .map(|_| ())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn native_print() -> Result<(), String> {
    // Desktop prints through WebView2's own pipeline (`window.print()`), so the native
    // bridge has nothing to do there. The command keeps one name on every platform.
    Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_update_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, MobileNative>,
) -> Result<AndroidUpdateCheck, String> {
    let urls = update_manifest_urls(&app);
    if urls.is_empty() {
        return Err("没有可用的更新源（tauri.conf.json → plugins.updater.endpoints）".to_string());
    }

    let handle = state.0.clone();
    let body = tauri::async_runtime::spawn_blocking(move || {
        let mut last_error = String::from("更新源不可达");
        for url in urls {
            match handle.run_mobile_plugin::<FetchedText>(
                "fetchText",
                serde_json::json!({ "url": url }),
            ) {
                Ok(reply) => return Ok(reply.text),
                Err(err) => last_error = err.to_string(),
            }
        }
        Err(last_error)
    })
    .await
    .map_err(|e| e.to_string())??;

    let release = android_update::parse_manifest(&body)?;
    let current = app.package_info().version.to_string();
    Ok(AndroidUpdateCheck {
        available: android_update::is_newer(&release.version, &current),
        current_version: current,
        version: release.version,
        notes: release.notes,
        url: release.url,
    })
}

/// Start the download in the background and return at once; the frontend then polls
/// `android_update_progress`. When the bytes are complete the Kotlin side launches the
/// system installer itself.
#[cfg(target_os = "android")]
#[tauri::command]
async fn android_update_install(
    state: tauri::State<'_, MobileNative>,
    url: String,
    version: String,
) -> Result<serde_json::Value, String> {
    call_native::<serde_json::Value>(
        state.0.clone(),
        "installUpdate",
        serde_json::json!({ "url": url, "version": version }),
    )
    .await
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_update_progress(
    state: tauri::State<'_, MobileNative>,
) -> Result<serde_json::Value, String> {
    call_native::<serde_json::Value>(
        state.0.clone(),
        "downloadState",
        serde_json::json!({}),
    )
    .await
}

// Desktop/iOS stubs: the same command names exist everywhere so a shared frontend call can
// never fail with "command not found". Android is the only target that implements them.
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn android_update_check() -> Result<AndroidUpdateStub, String> {
    Err("应用内 APK 更新仅在 Android 上可用".to_string())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn android_update_install(_url: String, _version: String) -> Result<serde_json::Value, String> {
    Err("应用内 APK 更新仅在 Android 上可用".to_string())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn android_update_progress() -> Result<serde_json::Value, String> {
    Err("应用内 APK 更新仅在 Android 上可用".to_string())
}

/// Placeholder reply type for the non-Android stubs, only needed to give those commands a
/// concrete return type.
#[cfg(not(target_os = "android"))]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidUpdateStub {
    available: bool,
    current_version: String,
    version: String,
    notes: String,
    url: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Cross-platform plugins only. Rebinding `builder` inside a cfg block is the
    // idiomatic Tauri pattern for keeping a single run() across every target.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    // Desktop-only plugins. Updater, process and single-instance are unsupported on
    // android/ios (verified against the published plugin support matrix, MAINTENANCE
    // 13.4), and WatcherState only exists where `notify` is compiled in.
    #[cfg(desktop)]
    let builder = builder
        .manage(WatcherState::default())
        // Auto-update: the UI asks the plugin to check a signed manifest; the user
        // decides whether to download and install it. The private signing key never
        // enters this project - only the public key is in tauri.conf.json.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main").or_else(|| app.webview_windows().values().next().cloned()) {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                // `args` is the second instance's full command line, argv[0] included.
                // Forwarding it verbatim made the frontend open the app's own
                // executable as a ~13 MB "document" (the window then froze while
                // parsing binary). Drop the program name and any switches, exactly
                // as get_cli_args() does, before handing the paths to the UI.
                let files: Vec<String> = args
                    .into_iter()
                    .skip(1)
                    .filter(|arg| !arg.starts_with('-'))
                    .collect();
                let _ = window.emit("open-file-from-cli", files);
            }
        }));

    // Android: register the Kotlin class that owns printing and APK updates. This wrapper
    // declares no commands - the frontend calls app commands - it exists only because
    // `register_android_plugin` is reachable from a plugin's `PluginApi` and nowhere else.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(
        tauri::plugin::Builder::<tauri::Wry, ()>::new("markdownx-mobile")
            .setup(|app, api| {
                let handle = api
                    .register_android_plugin("com.markdownx.editor", "MobileExtrasPlugin")
                    .map_err(|e| e.to_string())?;
                app.manage(MobileNative(handle));
                Ok(())
            })
            .build(),
    );

    builder
        .invoke_handler(tauri::generate_handler![
            get_cli_args,
            path_kind,
            get_host_platform,
            read_file_from_path,
            read_dir_files,
            scan_workspace_files,
            read_text_files,
            toggle_fullscreen,
            toggle_always_on_top,
            open_devtools,
            start_watching_file,
            stop_watching_file,
            list_system_fonts,
            native_print,
            android_update_check,
            android_update_install,
            android_update_progress
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod platform_tests {
    use super::platform_name;

    #[test]
    fn reports_a_known_platform_name() {
        let name = platform_name();
        assert!(
            ["android", "ios", "windows", "macos", "linux"].contains(&name),
            "unexpected platform name: {name}"
        );
    }

    /// The mapping must agree with the target this test binary was built for. Guards
    /// against a branch being duplicated or a target silently falling through to the
    /// wrong name - the frontend treats mobile and desktop as disjoint sets.
    #[test]
    fn agrees_with_the_compile_time_target() {
        let expected = if cfg!(target_os = "android") {
            "android"
        } else if cfg!(target_os = "ios") {
            "ios"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        };
        assert_eq!(platform_name(), expected);
    }

    #[test]
    fn is_never_reported_as_both_mobile_and_desktop() {
        let name = platform_name();
        let mobile = name == "android" || name == "ios";
        let desktop = name == "windows" || name == "macos" || name == "linux";
        assert!(!(mobile && desktop), "platform {name} claims both");
    }
}

#[cfg(test)]
mod workspace_scan_tests {
    use super::*;

    /// No `tempfile` dependency: these fixtures only need a directory no other test
    /// touches, and pid + tag is unique per run. Removed on creation so a crashed run
    /// cannot poison the next one.
    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "markdownx-scan-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent dir");
        }
        std::fs::write(path, bytes).expect("write fixture");
    }

    fn scan(root: &Path) -> Vec<ScannedFile> {
        scan_workspace_files(root.to_string_lossy().to_string()).expect("scan should succeed")
    }

    #[test]
    fn walk_keeps_notes_and_attachments_but_not_noise() {
        let root = scratch_dir("walk");
        write_file(&root.join("a.md"), b"# a");
        write_file(&root.join("assets/IMG.JPG"), b"jpeg");
        write_file(&root.join("deep/er/b.markdown"), b"# b");
        // Junk that must not reach the index; `node_modules` and `.git` are the two the
        // ignore rules exist for, `.trash` covers the dot-prefix rule.
        write_file(&root.join(".git/HEAD"), b"ref: refs/heads/main");
        write_file(&root.join("node_modules/pkg/readme.md"), b"# dep");
        write_file(&root.join("deep/.obsidian/workspace.json"), b"{}");
        write_file(&root.join("scratch.tmp"), b"tmp");

        let files = scan(&root);
        let got: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(got.len(), 3, "unexpected entries: {got:?}");
        assert!(got.iter().any(|p| p.ends_with("a.md")));
        // Uppercase extension must still match, or Windows camera-roll images vanish.
        assert!(got.iter().any(|p| p.ends_with("IMG.JPG")));
        assert!(got.iter().any(|p| p.ends_with("b.markdown")));
        // Stable order for the frontend's diff against its previous index.
        let mut sorted = got.clone();
        sorted.sort_unstable();
        assert_eq!(got, sorted, "paths should come back sorted");

        let img = files.iter().find(|f| f.path.ends_with("IMG.JPG")).unwrap();
        assert_eq!(img.size, 4);
        assert!(img.mtime > 0, "mtime should be Unix seconds, got {}", img.mtime);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_reports_a_bad_root_instead_of_an_empty_index() {
        // Distinct from "empty workspace": the caller shows a different message for a path
        // that is not a directory at all.
        let root = scratch_dir("badroot");
        let file = root.join("note.md");
        write_file(&file, b"# n");
        assert!(scan_workspace_files(file.to_string_lossy().to_string()).is_err());
        let missing = root.join("nope");
        assert!(scan_workspace_files(missing.to_string_lossy().to_string()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_stops_at_the_depth_cap() {
        let root = scratch_dir("depth");
        // The cap counts DIRECTORY levels below the root, and files are never depth-checked
        // - their parent is. So a note in the directory at exactly MAX_SCAN_DEPTH is still
        // listed, and one level lower is unreachable. Pinning both sides here because an
        // off-by-one would silently hide a whole nested vault.
        let mut within = root.join("within");
        for _ in 1..MAX_SCAN_DEPTH {
            within.push("d");
        }
        write_file(&within.join("found.md"), b"# found");
        let mut beyond = root.join("beyond");
        for _ in 0..MAX_SCAN_DEPTH {
            beyond.push("d");
        }
        write_file(&beyond.join("lost.md"), b"# lost");

        let files = scan(&root);
        let got: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(got.iter().any(|p| p.ends_with("found.md")), "{got:?}");
        assert!(!got.iter().any(|p| p.ends_with("lost.md")), "{got:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_stops_at_the_file_cap_and_returns_a_partial_list() {
        // The cap exists so a share with a checked-out project cannot make the first scan
        // run for minutes. Its contract is "partial results, never an error": an error
        // would blank the panels, and an oversized list would stall the IPC reply.
        let root = scratch_dir("filecap");
        write_file(&root.join("a.md"), b"# a");
        write_file(&root.join("b.md"), b"# b");
        write_file(&root.join("c.md"), b"# c");

        let files = scan_workspace_files_with_caps(&root.to_string_lossy(), 2, MAX_SCAN_DEPTH)
            .expect("a capped scan is still a successful scan");
        assert_eq!(files.len(), 2, "cap must stop the walk at exactly max_files");
        // What did make it through is still sorted, i.e. the frontend can build a usable
        // (if incomplete) index from it and diff it against the previous one.
        let mut sorted: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
        let original = sorted.clone();
        sorted.sort_unstable();
        assert_eq!(original, sorted);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_batch_reports_each_file_independently() {
        let root = scratch_dir("read");
        let good = root.join("good.md");
        write_file(&good, "héllo".as_bytes());
        let oversized = root.join("big.md");
        write_file(&oversized, &vec![b'a'; MAX_TEXT_FILE_BYTES as usize + 1]);
        let not_utf8 = root.join("latin1.md");
        write_file(&not_utf8, &[0x23, 0x20, 0xFF, 0xFE]);
        let missing = root.join("missing.md");

        let paths: Vec<String> = [&good, &oversized, &not_utf8, &missing]
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        let results = read_text_files(paths.clone()).expect("batch never fails");
        assert_eq!(results.len(), paths.len());
        // Echoed back verbatim so the caller can key its index by the path it asked for.
        assert_eq!(results[0].path, paths[0]);

        assert_eq!(results[0].content.as_deref(), Some("héllo"));
        assert!(results[0].error.is_none());

        // Over the limit: an error, not a truncated body.
        assert!(results[1].content.is_none(), "oversized body must not be returned");
        assert!(results[1].error.is_some());

        // Invalid UTF-8 keeps lossy content AND flags it as approximate.
        let lossy = results[2].content.as_deref().expect("lossy content kept");
        assert!(lossy.starts_with("# "), "lossy text: {lossy:?}");
        assert!(results[2].error.is_some());

        assert!(results[3].content.is_none());
        assert!(results[3].error.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }
}
