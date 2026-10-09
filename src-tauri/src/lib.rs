use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Mutex;
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

mod protocol;
mod windows_api;

pub struct LogState {
    file: Mutex<Option<std::fs::File>>,
}

impl LogState {
    fn new() -> Self {
        // ponytail: never panic at startup — logging is best-effort
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(std::env::temp_dir().join("jumpscare_debug.log"))
            .ok();
        Self {
            file: Mutex::new(file),
        }
    }

    fn write(&self, msg: &str) {
        if let Ok(mut guard) = self.file.lock() {
            if let Some(f) = guard.as_mut() {
                let _ = writeln!(f, "{}", msg);
                let _ = f.flush();
            }
        }
    }
}

pub struct AppState {}

#[tauri::command]
fn log_write(msg: String, state: tauri::State<'_, LogState>) {
    state.write(&msg);
}

#[tauri::command]
fn log_path() -> String {
    std::env::temp_dir()
        .join("jumpscare_debug.log")
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
fn show_overlay(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window("overlay") {
        Some(window) => {
            // ponytail: physical pixels — no per-monitor scale reinterpretation; topmost reasserted every show
            #[cfg(target_os = "windows")]
            if let Some((mx, my, mw, mh)) = windows_api::foreground_monitor_rect() {
                let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: mx - 4, y: my - 4 }));
                let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: (mw + 8) as u32, height: (mh + 8) as u32 }));
            }
            let _ = window.set_always_on_top(true);
            window.show().map_err(|e| e.to_string())?;
            #[cfg(target_os = "windows")]
            {
                windows_api::set_clickthrough(&window)?;
            }
            Ok(())
        }
        None => Err("overlay window not found".to_string()),
    }
}

#[tauri::command]
fn hide_overlay(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window("overlay") {
        Some(window) => window.hide().map_err(|e| e.to_string()),
        None => Err("overlay window not found".to_string()),
    }
}

#[tauri::command]
fn minimize_to_tray(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_guide(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window("guide") {
        Some(w) => {
            w.show().map_err(|e| e.to_string())?;
            w.set_focus().map_err(|e| e.to_string())?;
            Ok(())
        }
        None => Err("guide window not found".to_string()),
    }
}

fn ffmpeg_data_dir() -> std::path::PathBuf {
    std::env::var("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("jumpscare-multiplayer")
        .join("ffmpeg")
}

// Preferred home for binaries: dependencies/ next to the exe.
// Falls back to app-data when the exe dir isn't writable (e.g. Program Files).
fn exe_bin_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|d| d.join("dependencies"))
}

fn find_ffmpeg(app: &AppHandle) -> PathBuf {
    if let Some(dir) = exe_bin_dir() {
        let p = dir.join("ffmpeg.exe");
        if p.exists() { return p; }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("ffmpeg.exe");
            if p.exists() { return p; }
        }
    }
    let data = ffmpeg_data_dir().join("ffmpeg.exe");
    if data.exists() { return data; }
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("ffmpeg").join("ffmpeg.exe");
        if p.exists() { return p; }
    }
    PathBuf::from("ffmpeg.exe")
}

#[tauri::command]
async fn pick_video_file() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<String, String> {
        let file = rfd::FileDialog::new()
            .set_title("Select Jumpscare File")
            .add_filter("Video", &["mp4", "mkv", "avi", "webm", "mov", "flv", "wmv"])
            .add_filter("Images", &["gif", "png", "webp"])
            .add_filter("All", &["*"])
            .pick_file()
            .ok_or("No file selected")?;
        Ok(file.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_to_temp(name: String, data: Vec<u8>) -> Result<String, String> {
    // ponytail: basename only — callers must not control directories
    let safe_name: String = std::path::Path::new(&name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "ve_input.mp4".to_string());
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let path = std::env::temp_dir().join(&safe_name);
        std::fs::write(&path, &data).map_err(|e| e.to_string())?;
        // to_string_lossy is fine here: temp_dir on Windows is ASCII-safe in practice,
        // and a lossy path would fail loudly at ffmpeg instead of silently
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    // ponytail: lets the editor hand its export to sync without re-picking the file
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_output_dir() -> Result<String, String> {
    // Prefer next-to-exe (user asked for it); fall back to app-data when read-only (Program Files)
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("transparent_videos"));
        }
    }
    candidates.push(ffmpeg_data_dir().join("transparent_videos"));
    let mut last_err = "no writable output dir".to_string();
    for dir in candidates {
        match std::fs::create_dir_all(&dir) {
            Ok(()) => return Ok(dir.to_string_lossy().to_string()),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(last_err)
}

#[tauri::command]
async fn open_folder(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer.exe")
                .arg(&path)
                .creation_flags(0x00000008) // DETACHED_PROCESS — don't steal focus
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            std::process::Command::new("xdg-open")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn convert_video(app: AppHandle, input_path: String, output_path: String, color_hex: String, tolerance: f64, trim_start: f64, trim_end: f64) -> Result<String, String> {
    let ffmpeg_path = find_ffmpeg(&app);
    if !ffmpeg_path.exists() {
        return Err("FFmpeg not found. Download it in Settings first.".to_string());
    }
    if color_hex.len() != 6 || !color_hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid key color.".to_string());
    }
    if !(0.0..=1.0).contains(&tolerance) {
        return Err("Invalid tolerance.".to_string());
    }
    if !std::path::Path::new(&input_path).exists() {
        return Err("Input file not found.".to_string());
    }
    if trim_start < 0.0 || trim_end < 0.0 {
        return Err("Invalid trim range.".to_string());
    }
    let filter = format!("colorkey=0x{}:{:.3}", color_hex, tolerance);
    let use_trim = trim_end > trim_start;
    let ss = trim_start.to_string();
    let to = trim_end.to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let mut cmd = std::process::Command::new(&ffmpeg_path);
        cmd.arg("-y").arg("-i").arg(&input_path);
        if use_trim {
            cmd.arg("-ss").arg(&ss).arg("-to").arg(&to);
        }
        cmd.args(["-vf", &filter, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-cpu-used", "4", "-row-mt", "1", "-c:a", "libopus", &output_path]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let out = cmd.output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(output_path)
        } else {
            // ponytail: last stderr line only — full dumps leak paths and flood the UI
            let stderr = String::from_utf8_lossy(&out.stderr);
            let last = stderr.lines().last().unwrap_or("ffmpeg failed").trim();
            let short: String = last.chars().take(300).collect();
            Err(format!("FFmpeg failed: {}", short))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ffmpeg_status(app: AppHandle) -> Result<String, String> {
    // Same lookup as convert_video so the UI never disagrees with the export path
    if let Some(dir) = exe_bin_dir() {
        let p = dir.join("ffmpeg.exe");
        if p.exists() {
            return Ok(p.to_string_lossy().to_string());
        }
    }
    let p = find_ffmpeg(&app);
    if p.exists() {
        // but only report real installs, not a CWD-relative fallback
        if p.is_absolute() {
            return Ok(p.to_string_lossy().to_string());
        }
    }
    Err("Not downloaded".to_string())
}

#[tauri::command]
async fn download_ffmpeg() -> Result<String, String> {
    let dir = ffmpeg_data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join("ffmpeg.exe");
    if dest.exists() { return Ok(dest.to_string_lossy().to_string()); }

    let dest_escaped = dir.join("ffmpeg.exe").to_string_lossy().replace("'", "''");
    let dir_escaped = dir.to_string_lossy().replace("'", "''");
    let script = format!(
        "Write-Host '=== Jumpscare Multiplayer - FFmpeg Installer ===' -ForegroundColor Cyan\n\
         Write-Host ''\n\
         Write-Host 'Installing FFmpeg via winget...' -ForegroundColor Yellow\n\
         try {{\n\
         \x20 winget install Gyan.FFmpeg --accept-package-agreements --accept-source-agreements\n\
         \x20 Write-Host ''\n\
         \x20 Write-Host 'Copying ffmpeg.exe to app folder...' -ForegroundColor Yellow\n\
         \x20 $pkg = Get-ChildItem 'C:\\Users\\*\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg*' -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1\n\
         \x20 if ($pkg) {{\n\
         \x20 \x20 New-Item -ItemType Directory -Path '{dir}' -Force | Out-Null\n\
         \x20 \x20 Copy-Item $pkg.FullName '{dest}' -Force\n\
         \x20 \x20 Write-Host 'Done! FFmpeg installed.' -ForegroundColor Green\n\
         \x20 }} else {{\n\
         \x20 \x20 Write-Host 'Installed but could not find ffmpeg.exe. Try restarting the app.' -ForegroundColor Yellow\n\
         \x20 }}\n\
         }} catch {{\n\
         \x20 Write-Host ('Error: ' + $_.Exception.Message) -ForegroundColor Red\n\
         }}\n\
         Write-Host ''\n\
         Read-Host 'Press Enter to close'",
        dir = dir_escaped,
        dest = dest_escaped,
    );
    let script_path = std::env::temp_dir().join("install_ffmpeg.ps1");
    std::fs::write(&script_path, &script).map_err(|e| e.to_string())?;
    std::process::Command::new("powershell.exe")
        .args(["-NoExit", "-ExecutionPolicy", "Bypass", "-File", &script_path.to_string_lossy()])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok("Installer opened in terminal".to_string())
}

fn ytdlp_path() -> PathBuf {
    if let Some(dir) = exe_bin_dir() {
        if std::fs::create_dir_all(&dir).is_ok() {
            return dir.join("yt-dlp.exe");
        }
    }
    ffmpeg_data_dir().join("yt-dlp.exe")
}

fn fetch_ytdlp(dest: &PathBuf) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // ponytail: silent Invoke-WebRequest, no new cargo deps for one download
    let ps = format!(
        "Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile '{}'",
        dest.to_string_lossy().replace('\'', "''")
    );
    let st = {
        let mut c = std::process::Command::new("powershell.exe");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps]);
        #[cfg(target_os = "windows")]
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW — no popup terminal
        c.output().map_err(|e| e.to_string())?
    };
    if !st.status.success() || !dest.exists() {
        return Err("Could not download yt-dlp (check internet).".to_string());
    }
    Ok(())
}

fn ensure_ytdlp() -> Result<PathBuf, String> {
    let dest = ytdlp_path();
    if dest.exists() {
        return Ok(dest);
    }
    fetch_ytdlp(&dest)?;
    Ok(dest)
}

#[tauri::command]
async fn download_ytdlp() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(ensure_ytdlp)
        .await
        .map_err(|e| e.to_string())?
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn ytdlp_status() -> Result<String, String> {
    let p = ytdlp_path();
    if p.exists() {
        return Ok(p.to_string_lossy().to_string());
    }
    Err("Not downloaded".to_string())
}

#[tauri::command]
fn download_progress() -> Result<String, String> {
    // ponytail: biggest in-progress ve_url.* file size in bytes ("" = nothing yet) — UI polls this
    let tmp = std::env::temp_dir();
    let best = std::fs::read_dir(&tmp)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("ve_url."))
        .filter_map(|e| e.metadata().ok().map(|m| m.len()))
        .max()
        .unwrap_or(0);
    Ok(best.to_string())
}

#[tauri::command]
async fn download_url(app: AppHandle, url: String) -> Result<String, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Paste an http(s) video URL.".to_string());
    }
    // Resolve ffmpeg dir first (yt-dlp needs it for merges)
    let ff_loc = {
        let ff = find_ffmpeg(&app);
        ff.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default()
    };
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let dest = ensure_ytdlp()?;
        let tmp = std::env::temp_dir();
        // clear stale downloads so the newest match below is always ours
        if let Ok(entries) = std::fs::read_dir(&tmp) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with("ve_url.") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        let tmpl = tmp.join("ve_url.%(ext)s").to_string_lossy().replace('\\', "/");
        let mut cmd = std::process::Command::new(&dest);
        cmd.args(["--no-playlist", "--no-warnings", "-f", "bv*+ba/b", "--merge-output-format", "mp4"]);
        if !ff_loc.is_empty() {
            cmd.arg("--ffmpeg-location").arg(&ff_loc);
        }
        cmd.args(["-o", &tmpl, &url]);
        // ponytail: hidden console — progress is polled via download_progress into the UI instead
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let out = cmd.output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let last = err.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("download failed");
            let short: String = last.chars().take(200).collect();
            return Err(format!("Download failed: {}", short));
        }
        let newest = std::fs::read_dir(&tmp)
            .map_err(|e| e.to_string())?
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("ve_url."))
            .filter_map(|e| e.metadata().ok().and_then(|m| m.modified().ok()).map(|t| (t, e.path())))
            .max_by_key(|(t, _)| *t)
            .map(|(_, p)| p);
        match newest {
            Some(p) => Ok(p.to_string_lossy().to_string()),
            None => Err("Download finished but file not found.".to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log_state = LogState::new();
    log_state.write("=== JUMPSCARE MULTIPLAYER STARTED ===");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::Builder::new().app_name("Jumpscare Multiplayer").args(["--minimized"]).build())
        .manage(AppState {})
        .manage(log_state)
        .invoke_handler(tauri::generate_handler![
            show_overlay,
            hide_overlay,
            minimize_to_tray,
            show_main_window,
            show_guide,
            pick_video_file,
            save_to_temp,
            read_file_bytes,
            get_output_dir,
            open_folder,
            convert_video,
            download_ffmpeg,
            ffmpeg_status,
            ytdlp_status,
            download_progress,
            download_ytdlp,
            download_url,
            log_write,
            log_path,
        ])
        .setup(|app| {
            let log_path = std::env::temp_dir().join("jumpscare_debug.log");
            eprintln!("JUMPSCARE LOG: {}", log_path.display());

            create_tray(app)?;

            // F12 anywhere = force jumpscare (frontend checks admin + lobby).
            // ponytail: never fail startup over a hotkey — a second instance or another app may own F12
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new().build(),
                )?;
                if let Err(e) = app.global_shortcut().on_shortcut("F12", |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = app.emit("force-hotkey", ());
                    }
                }) {
                    eprintln!("global shortcut F12 unavailable: {e}");
                }
            }

            // Start minimized to tray when launched at boot
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(main_window) = app.get_webview_window("main") {
                    let _ = main_window.hide();
                }
            }

            // DPI-aware monitor size for overlay
            let (sw, sh) = if let Some(monitor) = app.primary_monitor().ok().flatten() {
                let size = monitor.size();
                let scale = monitor.scale_factor();
                (size.width as f64 / scale, size.height as f64 / scale)
            } else {
                (1920.0, 1080.0)
            };

            let overlay_url = WebviewUrl::App("overlay.html".into());
            let _overlay = WebviewWindowBuilder::new(app, "overlay", overlay_url)
                .title("Jumpscare Overlay")
                // ponytail: +2px overscan — fractional DPI scaling rounds window size and leaves a 1px desktop line
                .inner_size(sw + 2.0, sh + 2.0)
                .position(-1.0, -1.0)
                .decorations(false)
                .resizable(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible(false)
                .build()?;
            // ponytail: clickthrough flags from birth — setting them on first show races activation and steals focus once
            #[cfg(target_os = "windows")]
            if let Some(overlay_window) = app.get_webview_window("overlay") {
                let _ = windows_api::set_clickthrough(&overlay_window);
            }

            let guide_url = WebviewUrl::App("guide.html".into());
            let _guide = WebviewWindowBuilder::new(app, "guide", guide_url)
                .title("Supabase Setup Guide")
                .inner_size(620.0, 700.0)
                .resizable(true)
                .visible(false)
                .build()?;

            // Intercept close on main window — hide to tray instead of quitting
            if let Some(main_window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn create_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let show_item = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let handle = app.handle().clone();

    // ponytail: 1x1 fallback so a missing icon can't abort startup
    let icon = app.default_window_icon().cloned()
        .unwrap_or_else(|| tauri::image::Image::new_owned(vec![0, 0, 0, 0], 1, 1));
    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("Jumpscare Multiplayer — Running")
        .on_menu_event(move |_tray, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => {
                // Signal JS to mark player offline, then exit
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.emit("quit-requested", ());
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
                std::process::exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
