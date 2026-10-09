#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ponytail: allow unmuted autoplay app-wide - the overlay window never receives a user
    // gesture, so without this every scare plays silent. Must run before any WebView exists.
    // Existing args (e.g. remote-debugging-port) are preserved.
    let mut args = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    if !args.contains("autoplay-policy") {
        if !args.is_empty() {
            args.push(' ');
        }
        args.push_str("--autoplay-policy=no-user-gesture-required");
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
    }
    jumpscare_multiplayer_lib::run();
}
