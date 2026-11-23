use capsio_core::storage_location::{Location, Locator};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, State};

pub struct DataLocation {
    pub locator: Option<Locator>,
    pub container: PathBuf,
}

#[cfg(not(target_os = "macos"))]
fn installation_root(exe: &Path) -> Result<PathBuf, String> {
    let parent = exe.parent().ok_or("安装目录不可用")?;
    // Both ordinary and UI-shell builds belong to this checkout's installation.
    for candidate in parent.ancestors().take(5) {
        if candidate.join("Capsio-MVP.cmd").is_file()
            && candidate.join("src-tauri/tauri.conf.json").is_file()
        {
            return Ok(candidate.to_path_buf());
        }
    }
    Ok(parent.to_path_buf())
}

// The earliest builds kept data in these per-identifier folders; prepare() moves it.
const EARLIEST: &str = "com.scientify.desktop";

/// Set when this start took over Scientify's data and none of it stayed inside the old
/// installation, so uninstalling Scientify takes nothing along.
static OLD_APP_REMOVABLE: AtomicBool = AtomicBool::new(false);

#[cfg(not(target_os = "macos"))]
pub fn production_locator() -> Result<Locator, String> {
    let installation = installation_root(&std::env::current_exe().map_err(|e| e.to_string())?)?;
    let roaming = std::env::var_os("APPDATA").ok_or("无法定位旧数据目录")?;
    let local = std::env::var_os("LOCALAPPDATA").ok_or("无法定位旧缓存目录")?;
    let locator = Locator::new(
        installation.clone(),
        PathBuf::from(roaming).join(EARLIEST),
        PathBuf::from(local).join(EARLIEST),
    );
    // Capsio was called Scientify: it ran from here (a checkout), or its installation sat
    // beside this one by default, or wherever its uninstall entry says.
    let mut previous = vec![installation.clone()];
    previous.extend(installation.parent().map(|parent| parent.join("Scientify")));
    previous.extend(scientify_installation());
    if let Some(directory) = locator.adopt_renamed(&previous)? {
        // Uninstalling Scientify is offered only when no old installation keeps data.
        let kept = previous[1..].iter().any(|old| {
            directory.starts_with(old) || old.join("ScientifyData").join("workspace").exists()
        });
        OLD_APP_REMOVABLE.store(!kept, Ordering::Relaxed);
    }
    Ok(locator)
}

/// Where Windows says Scientify was installed, from its uninstall entry.
#[cfg(windows)]
fn scientify_installation() -> Vec<PathBuf> {
    ["HKCU", "HKLM"]
        .iter()
        .filter_map(|hive| {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let output = std::process::Command::new("reg")
                .args([
                    "query",
                    &format!(
                        r"{hive}\Software\Microsoft\Windows\CurrentVersion\Uninstall\Scientify"
                    ),
                    "/v",
                    "UninstallString",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .ok()?;
            let text = String::from_utf8_lossy(&output.stdout).into_owned();
            let line = text.lines().find(|line| line.contains("UninstallString"))?;
            let value = line.split("REG_SZ").nth(1)?.trim().trim_matches('"');
            PathBuf::from(value).parent().map(PathBuf::from)
        })
        .collect()
}

#[cfg(not(windows))]
fn scientify_installation() -> Vec<PathBuf> {
    Vec::new()
}

// The signed .app bundle and /Applications are not writable data containers.
// Keep the same relocation settings, with a per-user control directory on macOS.
#[cfg(target_os = "macos")]
pub fn production_locator() -> Result<Locator, String> {
    let user = std::env::var_os("HOME").ok_or("无法定位用户数据目录")?;
    let library = PathBuf::from(user).join("Library");
    let installation = library.join("Application Support/Capsio");
    std::fs::create_dir_all(&installation).map_err(|e| e.to_string())?;
    let locator = Locator::new(
        installation,
        library.join(format!("Application Support/{EARLIEST}")),
        library.join(format!("Caches/{EARLIEST}")),
    );
    // Capsio was called Scientify, whose settings lived in the folder of that name.
    if locator
        .adopt_renamed(&[library.join("Application Support/Scientify")])?
        .is_some()
    {
        OLD_APP_REMOVABLE.store(true, Ordering::Relaxed);
    }
    Ok(locator)
}

/// Development builds share one `CapsioDevData` folder next to the
/// checkout, so every worktree and fresh clone opens the same projects
/// instead of starting from an empty workspace of its own.
#[cfg(debug_assertions)]
fn development_directory() -> PathBuf {
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri sits inside the checkout");
    checkout
        .parent()
        .unwrap_or(checkout)
        .join("CapsioDevData")
        .join("workspace")
}

pub fn prepare() -> Result<(PathBuf, DataLocation), String> {
    #[cfg(debug_assertions)]
    {
        let directory = std::env::var_os("CAPSIO_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(development_directory);
        Ok((
            directory.clone(),
            DataLocation {
                locator: None,
                container: directory.parent().ok_or("数据目录无效")?.to_path_buf(),
            },
        ))
    }
    #[cfg(not(debug_assertions))]
    {
        let locator = production_locator()?;
        let location = locator.prepare()?;
        Ok((
            location.directory.join("workspace"),
            DataLocation {
                locator: Some(locator),
                container: location.directory,
            },
        ))
    }
}

/// True once, on the start that took over Scientify's data, when the old application can go.
#[tauri::command]
pub fn renamed_app_removable() -> bool {
    OLD_APP_REMOVABLE.swap(false, Ordering::Relaxed)
}

#[tauri::command]
pub fn storage_location(state: State<'_, DataLocation>) -> Result<Location, String> {
    let location = match &state.locator {
        Some(locator) => locator.location()?,
        None => Location {
            directory: state.container.clone(),
            pending: None,
            cleanup: vec![],
        },
    };
    Ok(location.for_display())
}

/// Running work keeps its files open; a new data location waits until it ends.
fn protect_running<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    app.state::<crate::agent::AgentState>()
        .protect(None, None, None)?;
    app.state::<crate::experiments::ExperimentState>()
        .protect(None, None)?;
    if let Some(terminal) = app.try_state::<crate::experiments::terminal::TerminalState>() {
        terminal.protect(None, None)?;
    }
    if let Some(python) = app.try_state::<crate::experiments::python::PythonState>() {
        python.protect(None, None)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn storage_schedule<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, DataLocation>,
    directory: String,
) -> Result<Location, String> {
    let locator = state
        .locator
        .as_ref()
        .ok_or("开发版使用隔离数据目录，请在正式版更改存储位置。")?;
    // This schedules a future move; it never swaps live services or saved drafts.
    protect_running(&app)?;
    locator
        .schedule(&state.container, Path::new(&directory))
        .map(|location| location.for_display())
}

/// Uses a folder that already holds Capsio data from the next start on.
#[tauri::command]
pub async fn storage_adopt<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, DataLocation>,
    directory: String,
) -> Result<Location, String> {
    let locator = state
        .locator
        .as_ref()
        .ok_or("开发版使用隔离数据目录，请在正式版更改存储位置。")?;
    protect_running(&app)?;
    locator
        .adopt(Path::new(&directory))
        .map(|location| location.for_display())
}

#[tauri::command]
pub fn storage_cancel(state: State<'_, DataLocation>) -> Result<Location, String> {
    state
        .locator
        .as_ref()
        .ok_or("开发版使用隔离数据目录。")?
        .cancel()
        .map(|location| location.for_display())
}

pub fn migrate_offline() -> Result<(), String> {
    production_locator()?.prepare().map(|_| ())
}
