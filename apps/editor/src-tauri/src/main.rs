#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fonts;
mod memory;

use pamatcad_core::{
    error::{CoreError, ErrorCode},
    protocol::{Request, Response},
};
use pamatcad_host::Host;
use tauri::{
    menu::{MenuBuilder, SubmenuBuilder},
    webview::NewWindowResponse,
    Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

#[tauri::command]
async fn list_fonts(app: tauri::AppHandle) -> Result<Vec<fonts::FontInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<fonts::Fonts>().list())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_font(app: tauri::AppHandle, id: String) -> Result<fonts::FontData, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<fonts::Fonts>().load(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
    }
    Ok(())
}

#[tauri::command]
fn open_project() -> Result<(), String> {
    let url = "https://github.com/pamatcad/pamatcad";
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(url).status();
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .status();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let status = std::process::Command::new("xdg-open").arg(url).status();
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(_) => Err("Could not open the project website".into()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn close_output(app: tauri::AppHandle) -> tauri::Result<()> {
    if let Some(output) = app.get_webview_window("output") {
        output.close()?;
    }
    Ok(())
}

#[tauri::command]
async fn execute(host: State<'_, Host>, request: Request) -> Result<Response, CoreError> {
    host.execute(request)
        .await
        .map_err(|message| CoreError::new(ErrorCode::InvalidState, message))?
}

#[tauri::command]
async fn memory_footprint() -> Option<memory::Footprint> {
    tauri::async_runtime::spawn_blocking(memory::footprint)
        .await
        .ok()
        .flatten()
}

#[tauri::command]
async fn save_screenshot(window: tauri::WebviewWindow, filename: String, bytes: Vec<u8>) -> Result<bool, String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Screenshot is not a PNG image".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(not(feature = "editor-smoke"))]
        let path = {
            use tauri_plugin_dialog::DialogExt;
            let path = window.dialog().file()
                .set_parent(&window)
                .set_file_name(&filename)
                .add_filter("PNG image", &["png"])
                .blocking_save_file();
            let Some(path) = path else { return Ok(false); };
            path.into_path().map_err(|e| e.to_string())?
        };
        // The smoke build substitutes only the picker; PNG bytes still cross IPC and reach disk.
        #[cfg(feature = "editor-smoke")]
        let path = {
            let _ = window;
            std::env::temp_dir().join(filename)
        };
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        #[cfg(feature = "editor-smoke")]
        {
            if std::fs::read(&path).map_err(|e| e.to_string())? != bytes {
                return Err("Saved screenshot bytes differ".into());
            }
            println!("Screenshot PNG saved: {}", path.display());
        }
        Ok(true)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(feature = "editor-smoke")]
#[tauri::command]
fn click_pop_out(window: tauri::WebviewWindow) -> tauri::Result<()> {
    // WebKit requires user activation for window.open. Start this click in its own
    // evaluation, after the asynchronous modeling portion of the smoke test.
    window.eval("document.getElementById('dock-location').click()")
}

#[cfg(feature = "editor-smoke")]
#[tauri::command]
fn finish_smoke(app: tauri::AppHandle, success: bool, report: String) {
    println!("{report}");
    app.exit(if success { 0 } else { 1 });
}

fn main() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(feature = "editor-smoke")]
    let builder = builder
        .invoke_handler(tauri::generate_handler![list_fonts, load_font, execute, close_output, memory_footprint, show_main_window, open_project, save_screenshot, click_pop_out, finish_smoke])
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Finished {
                let fixture = include_str!("../../../../tests/editor/rectangle.js");
                let dock = include_str!("../../../../tests/editor/output.js");
                let documents = include_str!("../../../../tests/editor/documents.js");
                let screenshots = include_str!("../../../../tests/editor/screenshots.js");
                webview.eval(format!(r#"{fixture}
                    {dock}
                    {documents}
                    {screenshots}
                    testRectangleEditor().then(async result => {{
                      const screenshots = await testScreenshotEditor();
                      await testOutputDock();
                      const fonts = await window.__TAURI_INTERNALS__.invoke('list_fonts');
                      if (!fonts.length) throw new Error('No native fonts were listed');
                      const font = await window.__TAURI_INTERNALS__.invoke('load_font', {{id: fonts[0].id}});
                      if (!font.fontBase64 || !Number.isInteger(font.fontIndex)) throw new Error('Native font bytes/face index missing');
                      return {{...result, ...(await testDocumentEditor()), screenshots, installedFonts: fonts.length}};
                    }}).then(
                      result => window.__TAURI_INTERNALS__.invoke('finish_smoke', {{success:true, report:JSON.stringify(result)}}),
                      error => window.__TAURI_INTERNALS__.invoke('finish_smoke', {{success:false, report:String(error)}})
                    );"#)).expect("Could not start editor smoke test");
            }
        });
    #[cfg(not(feature = "editor-smoke"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        list_fonts,
        load_font,
        execute,
        close_output,
        memory_footprint,
        show_main_window,
        open_project,
        save_screenshot
    ]);
    builder
        .manage(Host::default())
        .manage(fonts::Fonts::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .ok_or("Missing main editor window configuration")?;
            WebviewWindowBuilder::from_config(app, config)?
                .visible(false)
                .on_new_window(move |url, features| {
                    if url.as_str() != "about:blank" {
                        return NewWindowResponse::Deny;
                    }
                    match WebviewWindowBuilder::new(&handle, "output", WebviewUrl::External(url))
                        .window_features(features)
                        .title("PamatCAD · Output")
                        .min_inner_size(360.0, 180.0)
                        .build()
                    {
                        Ok(window) => NewWindowResponse::Create { window },
                        Err(error) => {
                            eprintln!("Could not open the output window: {error}");
                            NewWindowResponse::Deny
                        }
                    }
                })
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                match window.label() {
                    "output" => {
                        let _ = window.emit_to("main", "output-closed", ());
                    }
                    "main" => {
                        let _ = close_output(window.app_handle().clone());
                    }
                    _ => {}
                }
            }
        })
        .menu(|app| {
            let file = SubmenuBuilder::new(app, "File")
                .text("new", "New scene")
                .build()?;
            let help = SubmenuBuilder::new(app, "Help")
                .text("reset-ui", "Reset UI")
                .text("about", "About")
                .build()?;
            let screenshots = SubmenuBuilder::new(app, "Capture screenshot")
                .text("screenshot-app", "Full app")
                .text("screenshot-viewport-ui", "Viewport with UI")
                .text("screenshot-viewport", "Viewport without UI")
                .build()?;
            let tools = SubmenuBuilder::new(app, "Tools").item(&screenshots).build()?;
            let menu = MenuBuilder::new(app);
            #[cfg(target_os = "macos")]
            let menu = {
                let application = SubmenuBuilder::new(app, "PamatCAD")
                    .text("app-about", "About PamatCAD")
                    .separator()
                    .hide()
                    .quit()
                    .build()?;
                menu.item(&application)
            };
            let edit = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            menu.items(&[&file, &edit, &tools, &help]).build()
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if matches!(id, "new" | "reset-ui" | "about" | "app-about" |
                "screenshot-app" | "screenshot-viewport-ui" | "screenshot-viewport") {
                let _ = app.emit("editor-menu", if id == "app-about" { "about" } else { id });
            }
        })
        .run(tauri::generate_context!())
        .expect("Could not launch PamatCAD");
}
