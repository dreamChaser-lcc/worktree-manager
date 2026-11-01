#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::time::Duration;

use tauri::Manager;
use tauri::WebviewUrl;
use tauri::WebviewWindowBuilder;
use tauri_plugin_shell::ShellExt;

/// 探测端口可绑定；preferred 被占用时返回系统分配的随机端口（与 Electron 版策略一致）
fn find_free_port(preferred: u16) -> u16 {
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", preferred)) {
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        return port;
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind random port");
    let port = listener.local_addr().expect("local addr").port();
    drop(listener);
    port
}

/// 等待内嵌服务端口可连接（Koa listen 后即可接受连接）
fn wait_server_ready(port: u16, attempt_limit: u32) -> bool {
    for _ in 0..attempt_limit {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

fn main() {
    let preferred_port = find_free_port(5210);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app_handle, _args, _cwd| {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(move |app| {
            // 便携数据目录：资源目录下 data（NSIS 默认 per-user 安装可写；与 Electron 版语义一致）
            let portable_data_directory = app
                .path()
                .resource_dir()?
                .join("data");
            let server_sidecar = app
                .shell()
                .sidecar("server")?
                .env("WORKTREE_MANAGER_PORT", preferred_port.to_string())
                .env("WORKTREE_MANAGER_HOST", "127.0.0.1")
                .env("WORKTREE_MANAGER_APP_DATA", portable_data_directory);
            let (_sidecar_receiver, _sidecar_child) = server_sidecar.spawn()?;

            if !wait_server_ready(preferred_port, 50) {
                return Err("内嵌服务健康检查超时".into());
            }

            let main_window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(format!("http://127.0.0.1:{}", preferred_port).parse()?),
            )
            .title("Worktree 管理器")
            .inner_size(1280.0, 800.0)
            .build()?;

            let _ = main_window.set_focus();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
