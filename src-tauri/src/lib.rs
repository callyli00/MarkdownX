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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .manage(WatcherState::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main").or_else(|| app.webview_windows().values().next().cloned()) {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                let _ = window.emit("open-file-from-cli", args);
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
            stop_watching_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
