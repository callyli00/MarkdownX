use tauri::{Manager, Emitter, State, AppHandle};
use std::sync::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

#[derive(serde::Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Default)]
pub struct WatcherState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    watched_paths: Mutex<HashMap<String, PathBuf>>,
}

#[tauri::command]
fn get_cli_args() -> Vec<String> {
    std::env::args().skip(1).collect()
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
                if ["md", "markdown", "txt", "png", "jpg", "jpeg", "svg", "tex"].contains(&ext.as_str()) {
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

#[tauri::command]
fn toggle_fullscreen(window: tauri::Window) -> Result<bool, String> {
    let current = window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(!current).map_err(|e| e.to_string())?;
    Ok(!current)
}

#[tauri::command]
fn toggle_always_on_top(window: tauri::Window, enable: bool) -> Result<bool, String> {
    window.set_always_on_top(enable).map_err(|e| e.to_string())?;
    Ok(enable)
}

#[tauri::command]
fn open_devtools(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main").or_else(|| app.webview_windows().values().next().cloned()) {
        window.open_devtools();
    }
}

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

// List the font families installed on this machine by reading the Windows
// registry Fonts key. Returns the primary face name of each entry (the label
// before the parenthetical, e.g. "宋体 & NSimSun" -> "宋体", "Segoe UI Bold"
// -> "Segoe UI") sorted case-insensitively, with icon/symbol fonts dropped.
// The frontend uses this to let the user pick from the fonts actually present,
// instead of a hardcoded list.
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

const ICON_SYMBOL_FONTS: [&str; 8] = [
    "Segoe MDL2 Assets", "Segoe Fluent Icons", "Segoe Material", "Webdings",
    "Wingdings", "Symbol", "Marlett", "Segoe Icons",
];

// Last whitespace-separated word of `s` (or "" if none). Rust String has no
// `rsplit_whitespace`, so reimplement the small piece we need.
fn last_word(s: &str) -> Option<&str> {
    s.split_whitespace().next_back()
}

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .manage(WatcherState::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        // Auto-update: the UI asks the plugin to check a signed manifest; the user
        // decides whether to download and install it. The private signing key never
        // enters this project - only the public key is in tauri.conf.json.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
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
    }

    builder
        .invoke_handler(tauri::generate_handler![
            get_cli_args,
            read_file_from_path,
            read_dir_files,
            toggle_fullscreen,
            toggle_always_on_top,
            open_devtools,
            start_watching_file,
            stop_watching_file,
            list_system_fonts
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
