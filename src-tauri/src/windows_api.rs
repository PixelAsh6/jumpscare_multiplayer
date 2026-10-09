/// Win32 API utilities for overlay clickthrough and transparency.

use tauri::WebviewWindow;

#[cfg(target_os = "windows")]
pub fn set_clickthrough(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{CreateRectRgn, SetWindowRgn};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, SetWindowPos, GetWindowRect,
        GWL_STYLE, GWL_EXSTYLE,
        WS_CAPTION, WS_THICKFRAME, WS_SYSMENU, WS_MINIMIZEBOX, WS_MAXIMIZEBOX,
        WS_EX_LAYERED, WS_EX_TRANSPARENT, WS_EX_TOPMOST,
        WS_EX_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_FRAMECHANGED,
    };

    let hwnd = window
        .hwnd()
        .map_err(|e| format!("Failed to get HWND: {e}"))?;

    let hwnd = HWND(hwnd.0 as _);

    unsafe {
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);

        let new_style = ex_style
            | WS_EX_LAYERED.0 as i32
            | WS_EX_TRANSPARENT.0 as i32
            | WS_EX_TOPMOST.0 as i32
            | WS_EX_NOACTIVATE.0 as i32;

        SetWindowLongW(hwnd, GWL_EXSTYLE, new_style);

        // ponytail: strip caption/sysmenu/thickframe at Win32 level — decorations(false)
        // doesn't always stick, and the leftover titlebar paints white when inactive
        let style = GetWindowLongW(hwnd, GWL_STYLE);
        let plain_style = style
            & !(WS_CAPTION.0 as i32)
            & !(WS_THICKFRAME.0 as i32)
            & !(WS_SYSMENU.0 as i32)
            & !(WS_MINIMIZEBOX.0 as i32)
            & !(WS_MAXIMIZEBOX.0 as i32);
        SetWindowLongW(hwnd, GWL_STYLE, plain_style);
        let _ = SetWindowPos(
            hwnd,
            HWND(std::ptr::null_mut()),
            0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
        );

        // ponytail: rectangular region kills the rounded DWM corners/border on borderless windows
        let mut rc: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rc).is_ok() {
            let hrgn = CreateRectRgn(0, 0, rc.right - rc.left, rc.bottom - rc.top);
            SetWindowRgn(hwnd, hrgn, true);
        }
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn set_clickthrough(_window: &WebviewWindow) -> Result<(), String> {
    Err("Clickthrough only supported on Windows".into())
}

/// Physical (x, y, w, h) of the monitor owning the current foreground window.
/// Physical pixels pass through unscaled, so mixed-DPI setups can't misplace
/// the overlay (logical coords get re-scaled per monitor by the window manager).
#[cfg(target_os = "windows")]
pub fn foreground_monitor_rect() -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::Graphics::Gdi::{
        MonitorFromWindow, GetMonitorInfoW,
        MONITOR_DEFAULTTOPRIMARY, MONITORINFO, HMONITOR,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let hmon: HMONITOR = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if !GetMonitorInfoW(hmon, &mut mi).as_bool() {
            return None;
        }
        let r = mi.rcMonitor;
        Some((r.left, r.top, r.right - r.left, r.bottom - r.top))
    }
}

#[cfg(not(target_os = "windows"))]
pub fn foreground_monitor_rect() -> Option<(i32, i32, i32, i32)> {
    None
}
