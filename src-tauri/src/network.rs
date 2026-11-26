//! The proxy the app's connections go through, as set in Settings → Network:
//!
//! - `system` (the default): the operating system's proxy. The app's own requests read it
//!   themselves. Engines that talk to ChatGPT are handed it, because where ChatGPT needs a
//!   proxy people usually turn on their proxy app's "system proxy", which sets no environment
//!   variables: the browser then signs in but the engine cannot reach ChatGPT.
//! - `none`: every connection goes out directly.
//! - `manual`: an `http://host:port` the user gives, for every connection: the app's requests,
//!   the AI engines, full-text translation and the built-in browser.
//!
//! Local addresses never go through a proxy.
use serde_json::Value;
use std::sync::RwLock;

#[derive(Clone, Debug, PartialEq)]
pub enum Proxy {
    System,
    Off,
    /// A checked `http(s)://host:port`.
    Manual(String),
}

static CURRENT: RwLock<Proxy> = RwLock::new(Proxy::System);
const LOCAL: &str = "localhost,127.0.0.1,::1";
const SET_BY_USER: [&str; 6] = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
];

/// The proxy the saved settings ask for; anything unreadable is the system's.
pub fn from_settings(data: &Value) -> Proxy {
    let network = &data["settings"]["network"];
    match network["proxy"].as_str() {
        Some("none") => Proxy::Off,
        Some("manual") => network["proxyUrl"]
            .as_str()
            .and_then(|raw| parse(raw).ok())
            .map_or(Proxy::System, Proxy::Manual),
        _ => Proxy::System,
    }
}

/// Takes the proxy from the workspace as it was loaded or saved.
pub fn update(data: Option<&Value>) {
    let next = data.map_or(Proxy::System, from_settings);
    if let Ok(mut current) = CURRENT.write() {
        *current = next;
    }
}

pub fn current() -> Proxy {
    CURRENT.read().map_or(Proxy::System, |proxy| proxy.clone())
}

/// A proxy address as the settings take it: `http://host:port`, without credentials or a path.
pub fn parse(raw: &str) -> Result<String, String> {
    reqwest::Url::parse(raw.trim())
        .ok()
        .filter(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
                && matches!(url.path(), "" | "/")
                && url.query().is_none()
                && url.fragment().is_none()
        })
        .and_then(|url| {
            let host = url.host_str()?.to_string();
            let port = url.port_or_known_default()?;
            Some(format!("{}://{host}:{port}", url.scheme()))
        })
        .ok_or_else(|| "代理地址要写成 http://地址:端口。".into())
}

/// An HTTP client builder with the proxy in force.
pub fn client(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    client_for(&current(), builder)
}

fn client_for(proxy: &Proxy, builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    match proxy {
        Proxy::System => builder,
        Proxy::Off => builder.no_proxy(),
        Proxy::Manual(url) => match reqwest::Proxy::all(url) {
            Ok(proxy) => builder.proxy(proxy.no_proxy(reqwest::NoProxy::from_string(LOCAL))),
            Err(_) => builder,
        },
    }
}

/// Variables for a child process: an engine or the translator. `needs_system`: a process that
/// cannot read the system proxy itself but must reach ChatGPT through it.
pub fn environment(needs_system: bool) -> Vec<(String, String)> {
    environment_for(&current(), needs_system)
}

fn environment_for(proxy: &Proxy, needs_system: bool) -> Vec<(String, String)> {
    match proxy {
        Proxy::Manual(url) => variables(url.clone()),
        Proxy::Off => ["NO_PROXY", "no_proxy"]
            .iter()
            .map(|name| (name.to_string(), "*".to_string()))
            .collect(),
        Proxy::System if needs_system && !set_by_user() => {
            system().map(variables).unwrap_or_default()
        }
        Proxy::System => Vec::new(),
    }
}

fn set_by_user() -> bool {
    SET_BY_USER
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
}

fn variables(proxy: String) -> Vec<(String, String)> {
    let mut set = Vec::new();
    for name in ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"] {
        set.push((name.to_string(), proxy.clone()));
        set.push((name.to_lowercase(), proxy.clone()));
    }
    // Sign-in callbacks and local services stay off the proxy.
    set.push(("NO_PROXY".into(), LOCAL.into()));
    set.push(("no_proxy".into(), LOCAL.into()));
    set
}

/// The built-in browser's proxy, when the user gave one; otherwise it follows the system.
pub fn browser() -> Option<tauri::Url> {
    match current() {
        Proxy::Manual(url) => tauri::Url::parse(&url).ok(),
        _ => None,
    }
}

#[cfg(windows)]
fn system() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = std::process::Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    from_registry(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(target_os = "macos")]
fn system() -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .output()
        .ok()?;
    from_scutil(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn system() -> Option<String> {
    None
}

/// `reg query` of Internet Settings: ProxyServer when ProxyEnable is on. The server is
/// either `host:port` or per scheme, `http=host:port;https=host:port;socks=…`.
#[cfg_attr(not(windows), allow(dead_code))]
fn from_registry(text: &str) -> Option<String> {
    let value = |name: &str| {
        text.lines().find_map(|line| {
            let mut parts = line.split_whitespace();
            (parts.next() == Some(name))
                .then(|| parts.nth(1).map(str::to_string))
                .flatten()
        })
    };
    if !value("ProxyEnable").is_some_and(|enabled| enabled == "0x1") {
        return None;
    }
    let server = value("ProxyServer")?;
    let address = if server.contains('=') {
        let scheme = |name: &str| {
            server.split(';').find_map(|part| {
                part.trim()
                    .strip_prefix(name)
                    .and_then(|rest| rest.strip_prefix('='))
                    .map(str::to_string)
            })
        };
        scheme("https").or_else(|| scheme("http"))?
    } else {
        server
    };
    normalized(&address)
}

/// `scutil --proxy`: the HTTPS proxy, else the HTTP one, when enabled.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn from_scutil(text: &str) -> Option<String> {
    let value = |name: &str| {
        text.lines().find_map(|line| {
            let (key, value) = line.split_once(" : ")?;
            (key.trim() == name).then(|| value.trim().to_string())
        })
    };
    ["HTTPS", "HTTP"].iter().find_map(|scheme| {
        if value(&format!("{scheme}Enable")).as_deref() != Some("1") {
            return None;
        }
        let host = value(&format!("{scheme}Proxy"))?;
        let port = value(&format!("{scheme}Port"))?;
        normalized(&format!("{host}:{port}"))
    })
}

fn normalized(address: &str) -> Option<String> {
    let address = address.trim();
    if address.is_empty() || address.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let url = if address.contains("://") {
        address.to_string()
    } else {
        format!("http://{address}")
    };
    reqwest::Url::parse(&url).ok().map(|_| url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn get<'a>(set: &'a [(String, String)], name: &str) -> Option<&'a str> {
        set.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn settings_pick_the_proxy_and_anything_unreadable_follows_the_system() {
        let with = |network: Value| json!({"settings":{"network":network}});
        assert_eq!(from_settings(&json!({"settings":{}})), Proxy::System);
        assert_eq!(from_settings(&with(json!({"proxy":"none"}))), Proxy::Off);
        assert_eq!(
            from_settings(&with(
                json!({"proxy":"manual","proxyUrl":" http://127.0.0.1:7890/ "})
            )),
            Proxy::Manual("http://127.0.0.1:7890".into())
        );
        assert_eq!(
            from_settings(&with(json!({"proxy":"manual","proxyUrl":"nonsense"}))),
            Proxy::System
        );
    }

    #[test]
    fn a_proxy_address_has_no_credentials_or_path() {
        assert_eq!(parse("http://proxy.lan").unwrap(), "http://proxy.lan:80");
        assert_eq!(
            parse("https://10.0.0.2:8443").unwrap(),
            "https://10.0.0.2:8443"
        );
        for bad in [
            "127.0.0.1:7890",
            "socks5://127.0.0.1:1080",
            "http://user:secret@127.0.0.1:7890",
            "http://127.0.0.1:7890/path",
            "http://127.0.0.1:7890?x=1",
            "",
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn processes_get_the_manual_proxy_or_go_direct() {
        let manual = environment_for(&Proxy::Manual("http://127.0.0.1:7890".into()), false);
        for name in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "ALL_PROXY"] {
            assert_eq!(get(&manual, name), Some("http://127.0.0.1:7890"), "{name}");
        }
        assert!(get(&manual, "NO_PROXY").is_some_and(|value| value.contains("127.0.0.1")));
        assert_eq!(
            get(&environment_for(&Proxy::Off, true), "NO_PROXY"),
            Some("*")
        );
        // Following the system, only an engine that cannot read it is handed anything.
        assert!(environment_for(&Proxy::System, false).is_empty());
    }

    #[test]
    fn clients_build_with_every_kind_of_proxy() {
        for proxy in [
            Proxy::System,
            Proxy::Off,
            Proxy::Manual("http://127.0.0.1:7890".into()),
        ] {
            assert!(client_for(&proxy, reqwest::Client::builder())
                .build()
                .is_ok());
        }
    }

    #[test]
    fn a_windows_system_proxy_is_read_only_when_turned_on() {
        let on = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n";
        assert_eq!(from_registry(on).as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(from_registry(&on.replace("0x1", "0x0")), None);
        let per_scheme = on.replace(
            "127.0.0.1:7890",
            "http=127.0.0.1:1080;https=127.0.0.1:1081;socks=127.0.0.1:1082",
        );
        assert_eq!(
            from_registry(&per_scheme).as_deref(),
            Some("http://127.0.0.1:1081")
        );
        assert_eq!(
            from_registry("    ProxyEnable    REG_DWORD    0x1\r\n"),
            None
        );
    }

    #[test]
    fn a_mac_system_proxy_prefers_https() {
        let text = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 8080\n  HTTPProxy : 10.0.0.2\n  HTTPSEnable : 1\n  HTTPSPort : 7890\n  HTTPSProxy : 127.0.0.1\n}\n";
        assert_eq!(from_scutil(text).as_deref(), Some("http://127.0.0.1:7890"));
        let http_only = text.replace("HTTPSEnable : 1", "HTTPSEnable : 0");
        assert_eq!(
            from_scutil(&http_only).as_deref(),
            Some("http://10.0.0.2:8080")
        );
        assert_eq!(from_scutil("<dictionary> {\n}\n"), None);
    }
}
