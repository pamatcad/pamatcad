#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
    let builder = tauri::Builder::default();
    #[cfg(feature = "editor-smoke")]
    let builder = builder
        .invoke_handler(tauri::generate_handler![execute, close_output, click_pop_out, finish_smoke])
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Finished {
                let fixture = include_str!("../../../../tests/editor/rectangle.js");
                let dock = include_str!("../../../../tests/editor/output.js");
                webview.eval(format!(r#"{fixture}
                    {dock}
                    testRectangleEditor().then(async result => {{ await testOutputDock(); return result; }}).then(
                      result => window.__TAURI_INTERNALS__.invoke('finish_smoke', {{success:true, report:JSON.stringify(result)}}),
                      error => window.__TAURI_INTERNALS__.invoke('finish_smoke', {{success:false, report:String(error)}})
                    );"#)).expect("Could not start editor smoke test");
            }
        });
    #[cfg(not(feature = "editor-smoke"))]
    let builder = builder.invoke_handler(tauri::generate_handler![execute, close_output]);
    builder
        .manage(Host::default())
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
                .text("help", "Editor controls")
                .build()?;
            let menu = MenuBuilder::new(app);
            #[cfg(target_os = "macos")]
            let menu = {
                let application = SubmenuBuilder::new(app, "PamatCAD")
                    .about(None)
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
            menu.items(&[&file, &edit, &help]).build()
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if matches!(id, "new" | "help") {
                let _ = app.emit("editor-menu", id);
            }
        })
        .run(tauri::generate_context!())
        .expect("Could not launch PamatCAD");
}
