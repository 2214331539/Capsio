#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    // OpenSSH asks for a password through SSH_ASKPASS; for a cloud host connection
    // Capsio is that program and answers with the password it was handed.
    if std::env::var_os("CAPSIO_ASKPASS").is_some() {
        use std::io::Write;
        let secret = std::env::var("CAPSIO_ASKPASS_SECRET").unwrap_or_default();
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{secret}");
        let _ = out.flush();
        std::process::exit(0);
    }
    let args: Vec<_> = std::env::args_os().collect();
    if args
        .get(1)
        .is_some_and(|value| value == "--capsio-migrate-storage")
    {
        match capsio_lib::migrate_storage_offline() {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    if args.get(1).is_some_and(|value| value == "--capsio-runner") {
        let result = args
            .get(2)
            .ok_or_else(|| "运行请求文件缺失。".to_string())
            .and_then(|path| capsio_lib::run_managed_experiment(std::path::Path::new(path)));
        match result {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    capsio_lib::run();
}
