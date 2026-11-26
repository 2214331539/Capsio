//! Model discovery, connection verification and chat share the same protocol adapter.
pub mod stream;
pub mod verification;
use reqwest::{Client, RequestBuilder, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Ollama,
    Openai,
    Anthropic,
    Gemini,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    endpoint: String,
    api_key: Option<String>,
    provider: Provider,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Message {
    role: Role,
    content: Value,
}
#[derive(Clone, Deserialize)]
pub struct AIRequest {
    #[serde(flatten)]
    connection: Connection,
    model: String,
    messages: Vec<Message>,
    max_tokens: Option<u32>,
    temperature: Option<f64>,
}
#[derive(Deserialize)]
pub struct ModelTest {
    #[serde(flatten)]
    connection: Connection,
    model: String,
}
#[derive(Serialize, Debug, PartialEq)]
pub struct Model {
    id: String,
    name: String,
    /// False for an official model the account's plan does not include; it is still listed.
    available: bool,
}

fn local(url: &Url) -> bool {
    url.host_str()
        .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1"))
}
fn base(connection: &Connection) -> Result<Url, String> {
    if connection.endpoint.len() > 4096
        || connection
            .api_key
            .as_ref()
            .is_some_and(|key| key.len() > 4096)
    {
        return Err("模型服务地址或密钥过长。".into());
    }
    let mut url = Url::parse(connection.endpoint.trim()).map_err(|_| "模型服务地址格式无效。")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("模型服务必须使用 HTTP(S)，地址不能包含密码、查询参数或片段。".into());
    }
    if url.scheme() == "http"
        && !local(&url)
        && connection
            .api_key
            .as_ref()
            .is_some_and(|key| !key.is_empty())
    {
        return Err("带 API Key 的远程模型服务必须使用 HTTPS。".into());
    }
    let path = url.path().trim_end_matches('/');
    let path = match connection.provider {
        Provider::Ollama => {
            let path = path
                .strip_suffix("/chat")
                .or_else(|| path.strip_suffix("/tags"))
                .unwrap_or(path);
            let path = path.strip_suffix("/v1").unwrap_or(path);
            if path.ends_with("/api") {
                path.into()
            } else {
                format!("{path}/api")
            }
        }
        Provider::Openai => {
            let path = path
                .strip_suffix("/chat/completions")
                .or_else(|| path.strip_suffix("/responses"))
                .or_else(|| path.strip_suffix("/models"))
                .unwrap_or(path);
            if path.is_empty() {
                "/v1".into()
            } else {
                path.into()
            }
        }
        Provider::Anthropic => {
            let path = path
                .strip_suffix("/messages")
                .or_else(|| path.strip_suffix("/models"))
                .unwrap_or(path);
            if path.is_empty() {
                "/v1".into()
            } else {
                path.into()
            }
        }
        Provider::Gemini => {
            let path = path.strip_suffix("/models").unwrap_or(path);
            if path.is_empty() {
                "/v1beta".into()
            } else {
                path.into()
            }
        }
    };
    url.set_path(&path);
    Ok(url)
}
pub(crate) fn responses_base(
    endpoint: &str,
    provider: &str,
    api_key: Option<&str>,
) -> Result<Url, String> {
    if !matches!(provider, "openai" | "ollama") {
        return Err("该协议尚未接入 Agent。".into());
    }
    let mut root = base(&Connection {
        endpoint: endpoint.into(),
        api_key: api_key.map(str::to_string),
        provider: Provider::Openai,
    })?;
    if provider == "ollama" {
        let path = root.path().trim_end_matches('/');
        let path = path
            .strip_suffix("/chat")
            .or_else(|| path.strip_suffix("/tags"))
            .unwrap_or(path);
        let path = path.strip_suffix("/api").unwrap_or(path);
        let path = if path.ends_with("/v1") {
            path.to_string()
        } else {
            format!("{path}/v1")
        };
        root.set_path(&path);
    }
    Ok(root)
}
fn child(base: &Url, path: &str) -> Url {
    let mut url = base.clone();
    url.set_path(&format!("{}/{}", base.path().trim_end_matches('/'), path));
    url
}
fn client(url: &Url) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(90))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none());
    // Remote APIs use the proxy set in Settings → Network; a local Ollama must remain local.
    builder = if local(url) {
        builder.no_proxy()
    } else {
        crate::network::client(builder)
    };
    builder.build().map_err(|_| "网络客户端初始化失败。".into())
}
fn authorize(call: RequestBuilder, connection: &Connection) -> RequestBuilder {
    let call = if matches!(connection.provider, Provider::Anthropic) {
        call.header("anthropic-version", "2023-06-01")
    } else {
        call
    };
    match connection
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        Some(key) => match connection.provider {
            Provider::Anthropic => call.header("x-api-key", key),
            Provider::Gemini => call.header("x-goog-api-key", key),
            _ => call.bearer_auth(key),
        },
        None => call,
    }
}
const TIMED_OUT: &str = "模型请求超时，请检查服务或缩小上下文。";
const UNREACHABLE: &str = "无法连接模型服务，请检查地址、网络与服务状态。";
const LIMITED: &str = "请求受限（429），请检查服务额度或稍后重试。";
const SERVICE_ERROR: &str = "模型服务返回 HTTP";

/// Whether a model call failed for a reason that may pass: the network, a timeout, a rate
/// limit or an error of the service itself, rather than a key or an address that is wrong.
pub(crate) fn transient(error: &str) -> bool {
    [TIMED_OUT, UNREACHABLE, LIMITED].contains(&error)
        || error.ends_with("（rate_limited）")
        || error.starts_with(&format!("{SERVICE_ERROR} 5"))
}

/// The refusals of Capsio's official model gateway (server/src/billing), with our words for
/// each. A remote error body can echo credentials, so its text never reaches the UI or the
/// logs: only a code from this list is read from it, and these words are shown instead.
const GATEWAY_CODES: [(&str, &str); 6] = [
    ("rate_limited", "请求太频繁，请稍后再试。"),
    ("daily_limit", "今天的用量已到单日上限，明天 0 点恢复。"),
    ("quota_exhausted", "官方模型额度已用完。"),
    (
        "model_not_in_plan",
        "当前套餐不包含这个模型，请换一个模型。",
    ),
    ("model_token_invalid", "官方模型连接已失效，请重新连接。"),
    ("account_disabled", "账号已停用。"),
];

/// A gateway refusal read from a failed response: its code, the message to show (ending in
/// the code, for the app to recognise) and the seconds it asked to wait.
pub(crate) struct Refusal {
    pub code: &'static str,
    pub message: String,
    pub retry_after: Option<u64>,
}

pub(crate) async fn gateway_refusal(mut response: reqwest::Response) -> Option<Refusal> {
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok());
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() > 8 * 1024 {
            return None;
        }
    }
    let value: Value = serde_json::from_slice(&body).ok()?;
    let wanted = value["code"].as_str()?;
    let (code, text) = GATEWAY_CODES.iter().find(|(code, _)| *code == wanted)?;
    Some(Refusal {
        code,
        message: format!("{text}（{code}）"),
        retry_after,
    })
}

async fn response(call: RequestBuilder, limit: usize) -> Result<Value, String> {
    let mut response = call.send().await.map_err(|e| {
        if e.is_timeout() {
            TIMED_OUT
        } else {
            UNREACHABLE
        }
    })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        if let Some(refusal) = gateway_refusal(response).await {
            return Err(refusal.message);
        }
        // Remote error bodies/URLs can echo credentials. Never send them to the UI or logs.
        return Err(match status {
            401 | 403 => "服务拒绝访问（401/403），请检查 API 密钥、服务区域及模型权限。".into(),
            404 | 405 => {
                "接口不可用（404/405），请检查服务地址及接口协议；服务需要支持模型列表和聊天接口。"
                    .into()
            }
            429 => LIMITED.into(),
            status => format!("{SERVICE_ERROR} {status}，请检查服务状态。"),
        });
    }
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("服务响应超过大小限制。".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取服务响应失败或超时，请稍后重试。")?
    {
        if bytes.len() + chunk.len() > limit {
            return Err("服务响应超过大小限制。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "模型服务返回了无法解析的 JSON。".into())
}

/// Model ids are sent in requests and process arguments; keep them short and printable.
pub(crate) fn valid_model(model: &str) -> bool {
    !model.trim().is_empty() && model.len() <= 256 && !model.chars().any(char::is_control)
}
/// The connection for one-shot text features such as selection translation. A
/// ChatGPT sign-in only drives the Agent, so these use another saved connection,
/// the official model first.
pub(crate) fn text_connection(data: &Value) -> Result<Value, String> {
    let model = &data["settings"]["model"];
    if model["provider"] != "chatgpt" {
        return Ok(model.clone());
    }
    data["settings"]["modelProfiles"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["provider"] != "chatgpt" && p["model"].as_str().is_some_and(valid_model))
        .min_by_key(|p| p["serviceId"] != "capsio")
        .map(|p| {
            let mut value = p.clone();
            if let Some(fields) = value.as_object_mut() {
                fields.remove("id");
                fields.remove("name");
            }
            value
        })
        .ok_or_else(|| {
            "ChatGPT 账号只用于 AI 助手。翻译和推荐要用 Capsio 官方模型：请先登录账号，或在模型设置里再添加一个模型。"
                .into()
        })
}

/// The official model work falls back on, and professional plans translate on: quick, cheap
/// and open to every plan.
pub(crate) const TRANSLATION_MODEL: &str = "deepseek-flash";

/// The connection the app's own model work runs on. `account` is the official service's
/// address once the user has signed in. With `official_first` (translation on a professional
/// plan) the work takes the official DeepSeek, whatever the conversation model is; otherwise
/// it keeps the text connection and falls back to the official model, on the user's own
/// points, when there is none (a ChatGPT sign-in alone).
pub(crate) fn work_connection(
    data: &Value,
    account: Option<&str>,
    official_first: bool,
) -> Result<Value, String> {
    let official = |endpoint: &str| json!({"provider":"openai","serviceId":"capsio","endpoint":endpoint,"model":TRANSLATION_MODEL});
    match account {
        Some(endpoint) if official_first => Ok(official(endpoint)),
        Some(endpoint) => Ok(text_connection(data).unwrap_or_else(|_| official(endpoint))),
        None => text_connection(data),
    }
}

/// Whether a plan translates on the official DeepSeek by default: the professional ones do;
/// everyone else translates on their own model or subscription.
pub(crate) fn translates_officially(plan: Option<&str>) -> bool {
    matches!(plan, Some("pro" | "team"))
}

/// [`work_connection`] for translation, with the plan as last heard.
pub(crate) fn translation_connection(
    state: &crate::AppState,
    data: &Value,
) -> Result<Value, String> {
    let account = signed_in(state);
    let official = account.is_some()
        && translates_officially(crate::collaboration::known_plan(state).as_deref());
    work_connection(data, account.as_deref(), official)
}

/// The official service's address, when the user is signed in to it.
pub(crate) fn signed_in(state: &crate::AppState) -> Option<String> {
    crate::collaboration::device(state)
        .ok()
        .filter(|device| device.authenticated)
        .map(|device| device.endpoint)
}
fn text_model(value: &Value, provider: Provider) -> bool {
    if matches!(provider, Provider::Gemini) {
        return value["supportedGenerationMethods"]
            .as_array()
            .is_some_and(|methods| methods.iter().any(|m| m == "generateContent"));
    }
    for path in [
        "/architecture/output_modalities",
        "/output_modalities",
        "/inference_metadata/response_modality",
    ] {
        if let Some(modalities) = value.pointer(path).and_then(Value::as_array) {
            return modalities
                .iter()
                .any(|m| m.as_str().is_some_and(|s| s.eq_ignore_ascii_case("text")));
        }
    }
    // No reliable capability metadata: let the selected model's chat probe decide.
    true
}

#[tauri::command]
pub async fn research_list_models(request: Connection) -> Result<Vec<Model>, String> {
    let root = base(&request)?;
    let http = client(&root)?;
    let dashscope = matches!(request.provider, Provider::Openai)
        && root.path().ends_with("/compatible-mode/v1");
    let mut url = child(
        &root,
        if matches!(request.provider, Provider::Ollama) {
            "tags"
        } else {
            "models"
        },
    );
    if dashscope {
        url.set_path(&format!(
            "{}/api/v1/models",
            root.path().trim_end_matches("/compatible-mode/v1")
        ));
    }
    let started = Instant::now();
    let mut models = BTreeMap::new();
    let mut cursor = String::new();
    for page in 1..=20 {
        let remaining = Duration::from_secs(60)
            .checked_sub(started.elapsed())
            .ok_or("获取模型列表超时，请重试。")?;
        let mut call = http.get(url.clone()).timeout(remaining);
        if dashscope {
            call = call.query(&[
                ("page_no", page.to_string()),
                ("page_size", "100".into()),
                ("capabilities", "TG".into()),
            ]);
        } else {
            call = match request.provider {
                Provider::Gemini => {
                    let call = call.query(&[("pageSize", "1000")]);
                    if cursor.is_empty() {
                        call
                    } else {
                        call.query(&[("pageToken", &cursor)])
                    }
                }
                Provider::Anthropic => {
                    let call = call.query(&[("limit", "1000")]);
                    if cursor.is_empty() {
                        call
                    } else {
                        call.query(&[("after_id", &cursor)])
                    }
                }
                Provider::Openai if !cursor.is_empty() => call.query(&[("after", &cursor)]),
                _ => call,
            };
        }
        let value = response(authorize(call, &request), 4 * 1024 * 1024).await?;
        let entries = if dashscope {
            value.pointer("/output/models")
        } else {
            Some(
                &value[match request.provider {
                    Provider::Ollama | Provider::Gemini => "models",
                    _ => "data",
                }],
            )
        }
        .and_then(Value::as_array)
        .ok_or("服务未返回有效的模型列表，请检查接口协议。")?;
        for entry in entries {
            if !text_model(entry, request.provider) {
                continue;
            }
            let id = match request.provider {
                Provider::Ollama => entry["model"].as_str().or_else(|| entry["name"].as_str()),
                Provider::Gemini => entry["name"]
                    .as_str()
                    .and_then(|s| s.strip_prefix("models/")),
                _ if dashscope => entry["model"].as_str(),
                _ => entry["id"].as_str(),
            };
            if let Some(id) = id.filter(|s| valid_model(s)) {
                let name = entry["displayName"]
                    .as_str()
                    .or_else(|| entry["display_name"].as_str())
                    .or_else(|| entry["name"].as_str())
                    .unwrap_or(id);
                let available = entry["available"].as_bool().unwrap_or(true);
                models.insert(
                    id.to_string(),
                    (name.chars().take(200).collect::<String>(), available),
                );
            }
        }
        if models.len() > 5000 {
            return Err("模型列表过大，请使用范围更小的服务接口。".into());
        }
        let next = if dashscope {
            if value["output"]["total"].as_u64().unwrap_or(0) > page * 100 {
                if entries.is_empty() {
                    return Err("服务返回了不完整的模型列表，请重试。".into());
                }
                page.to_string()
            } else {
                String::new()
            }
        } else if matches!(request.provider, Provider::Gemini) {
            value["nextPageToken"].as_str().unwrap_or("").into()
        } else if value["has_more"].as_bool().unwrap_or(false) {
            value["last_id"]
                .as_str()
                .or_else(|| entries.last().and_then(|e| e["id"].as_str()))
                .filter(|id| !id.is_empty())
                .ok_or("服务返回了不完整的模型列表，请重试。")?
                .into()
        } else {
            String::new()
        };
        if next.is_empty() {
            if models.is_empty() {
                return Err("服务未返回可选的聊天模型。".into());
            }
            return Ok(models
                .into_iter()
                .map(|(id, (name, available))| Model {
                    id,
                    name,
                    available,
                })
                .collect());
        }
        if next == cursor || next.len() > 4096 {
            return Err("服务返回了无效的模型分页信息。".into());
        }
        cursor = next;
    }
    Err("模型列表分页过多，请使用范围更小的服务接口。".into())
}

fn content_text(content: &Value) -> Option<&str> {
    content.as_str().or_else(|| {
        content.as_array()?.iter().find_map(|part| {
            (part["type"] == "text")
                .then(|| part["text"].as_str())
                .flatten()
        })
    })
}

fn content_has_image(content: &Value) -> bool {
    content
        .as_array()
        .is_some_and(|parts| parts.iter().any(|part| part["type"] == "image"))
}

fn data_url(part: &Value) -> Option<String> {
    let mime = part["mimeType"]
        .as_str()
        .filter(|value| !value.is_empty())?;
    let data = part["data"].as_str().filter(|value| !value.is_empty())?;
    Some(format!("data:{mime};base64,{data}"))
}

fn openai_content(content: &Value) -> Value {
    let Some(parts) = content.as_array() else {
        return content.clone();
    };
    Value::Array(
        parts
            .iter()
            .filter_map(|part| match part["type"].as_str() {
                Some("text") => Some(json!({"type":"text","text":part["text"]})),
                Some("image") => data_url(part).map(|url| {
                    json!({
                        "type":"image_url",
                        "image_url":{"url":url}
                    })
                }),
                _ => None,
            })
            .collect(),
    )
}

fn openai_messages(messages: &[Message]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| json!({"role":message.role,"content":openai_content(&message.content)}))
        .collect()
}

fn anthropic_content(content: &Value) -> Value {
    let Some(parts) = content.as_array() else {
        return content.clone();
    };
    Value::Array(
        parts
            .iter()
            .filter_map(|part| match part["type"].as_str() {
                Some("text") => Some(json!({"type":"text","text":part["text"]})),
                Some("image") => {
                    let mime = part["mimeType"].as_str()?;
                    let data = part["data"].as_str()?;
                    Some(json!({"type":"image","source":{"type":"base64","media_type":mime,"data":data}}))
                }
                _ => None,
            })
            .collect(),
    )
}

fn anthropic_message(message: &Message) -> Value {
    json!({"role":message.role,"content":anthropic_content(&message.content)})
}

fn gemini_parts(content: &Value) -> Vec<Value> {
    let Some(parts) = content.as_array() else {
        return vec![json!({"text":content.as_str().unwrap_or_default()})];
    };
    parts
        .iter()
        .filter_map(|part| match part["type"].as_str() {
            Some("text") => Some(json!({"text":part["text"]})),
            Some("image") => {
                Some(json!({"inlineData":{"mimeType":part["mimeType"],"data":part["data"]}}))
            }
            _ => None,
        })
        .collect()
}

fn ollama_messages(messages: &[Message]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            if let Some(parts) = message.content.as_array() {
                let text = parts
                    .iter()
                    .filter_map(|part| {
                        (part["type"] == "text")
                            .then(|| part["text"].as_str())
                            .flatten()
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let images = parts
                    .iter()
                    .filter_map(|part| {
                        (part["type"] == "image")
                            .then(|| part["data"].as_str())
                            .flatten()
                    })
                    .collect::<Vec<_>>();
                json!({"role":message.role,"content":text,"images":images})
            } else {
                json!({"role":message.role,"content":message.content.as_str().unwrap_or_default()})
            }
        })
        .collect()
}

fn completion_call(
    request: &AIRequest,
    probe: bool,
    streaming: bool,
) -> Result<RequestBuilder, String> {
    if !valid_model(&request.model) {
        return Err("请配置有效的模型名称。".into());
    }
    let request_size = request
        .messages
        .iter()
        .map(|m| m.content.to_string().len())
        .sum::<usize>();
    let has_image = request
        .messages
        .iter()
        .any(|message| content_has_image(&message.content));
    if request.messages.is_empty()
        || request.messages.len() > 50
        || request_size
            > if has_image {
                12 * 1024 * 1024
            } else {
                256 * 1024
            }
    {
        return Err("对话超过 50 条或 256 KiB 上下文限制，请新建对话或减少上下文。".into());
    }
    let connection = &request.connection;
    let root = base(connection)?;
    let tokens = if probe {
        32
    } else {
        request.max_tokens.unwrap_or(4096)
    };
    if !(1..=32768).contains(&tokens)
        || request
            .temperature
            .is_some_and(|v| !v.is_finite() || !(0.0..=2.0).contains(&v))
    {
        return Err("模型生成参数无效。".into());
    }
    let system = request
        .messages
        .iter()
        .filter(|m| matches!(m.role, Role::System))
        .filter_map(|m| content_text(&m.content))
        .collect::<Vec<_>>()
        .join("\n\n");
    let (url, body) = match connection.provider {
        Provider::Ollama => (
            child(&root, "chat"),
            json!({"model":request.model,"messages":ollama_messages(&request.messages),"stream":false,"options":{"num_predict":tokens}}),
        ),
        Provider::Openai => {
            let mut body = json!({"model":request.model,"messages":openai_messages(&request.messages),"stream":false});
            let token_key = if root.host_str() == Some("api.openai.com") {
                "max_completion_tokens"
            } else {
                "max_tokens"
            };
            body[token_key] = json!(tokens);
            (child(&root, "chat/completions"), body)
        }
        Provider::Anthropic => {
            let messages = request
                .messages
                .iter()
                .filter(|m| !matches!(m.role, Role::System))
                .map(anthropic_message)
                .collect::<Vec<_>>();
            let mut body = json!({"model":request.model,"messages":messages,"max_tokens":tokens,"stream":false});
            if !system.is_empty() {
                body["system"] = json!(system);
            }
            (child(&root, "messages"), body)
        }
        Provider::Gemini => {
            let mut url = child(&root, "models");
            // Model IDs are path segments, never interpolated query strings or traversal paths.
            url.path_segments_mut()
                .map_err(|_| "模型服务地址格式无效。")?
                .push(&format!("{}:generateContent", request.model));
            let contents = request.messages.iter().filter(|m| !matches!(m.role, Role::System)).map(|m| json!({
                "role":if matches!(m.role, Role::Assistant) {"model"} else {"user"}, "parts":gemini_parts(&m.content)
            })).collect::<Vec<_>>();
            let mut body =
                json!({"contents":contents,"generationConfig":{"maxOutputTokens":tokens}});
            if !system.is_empty() {
                body["systemInstruction"] = json!({"parts":[{"text":system}]});
            }
            (url, body)
        }
    };
    let mut body = body;
    if !probe {
        if let Some(temperature) = request.temperature {
            match connection.provider {
                Provider::Ollama => body["options"]["temperature"] = json!(temperature),
                Provider::Gemini => body["generationConfig"]["temperature"] = json!(temperature),
                _ => body["temperature"] = json!(temperature),
            }
        }
    }
    let mut url = url;
    if streaming {
        if matches!(connection.provider, Provider::Gemini) {
            url.set_path(
                &url.path()
                    .replace(":generateContent", ":streamGenerateContent"),
            );
            url.query_pairs_mut().append_pair("alt", "sse");
        } else {
            body["stream"] = json!(true);
        }
    }
    let call = authorize(client(&root)?.post(url).json(&body), connection);
    Ok(if streaming {
        call.timeout(Duration::from_secs(600))
    } else {
        call
    })
}
async fn completion(request: &AIRequest, probe: bool) -> Result<Value, String> {
    response(completion_call(request, probe, false)?, 1024 * 1024).await
}
fn output(value: &Value, provider: Provider) -> String {
    match provider {
        Provider::Ollama => value["message"]["content"].as_str().unwrap_or("").into(),
        Provider::Openai => value["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .into(),
        Provider::Anthropic => value["content"]
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter(|p| p["type"] == "text")
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
        Provider::Gemini => value["candidates"][0]["content"]["parts"]
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter(|p| p["thought"] != true)
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
    }
}
#[tauri::command]
pub async fn research_test_model(request: ModelTest) -> Result<(), String> {
    let request = AIRequest {
        max_tokens: None,
        temperature: None,
        connection: request.connection,
        model: request.model,
        messages: vec![Message {
            role: Role::User,
            content: "Reply OK.".into(),
        }],
    };
    let value = completion(&request, true).await?;
    // A reasoning model may spend the small probe budget before producing final text.
    let valid = !output(&value, request.connection.provider)
        .trim()
        .is_empty()
        || match request.connection.provider {
            Provider::Ollama => value["message"]["role"] == "assistant" && value["done"] == true,
            Provider::Openai => {
                value["choices"][0]["message"]["role"] == "assistant"
                    && value["choices"][0]["finish_reason"] == "length"
            }
            Provider::Anthropic => {
                value["type"] == "message" && value["stop_reason"] == "max_tokens"
            }
            Provider::Gemini => value["candidates"][0]["finishReason"] == "MAX_TOKENS",
        };
    if valid {
        Ok(())
    } else {
        Err("模型没有返回有效的聊天响应，请选择其他模型。".into())
    }
}
#[tauri::command]
pub async fn research_ask_ai(request: AIRequest) -> Result<String, String> {
    let value = completion(&request, false).await?;
    let text = output(&value, request.connection.provider);
    if text.trim().is_empty() {
        Err("模型没有返回文本回答，请检查模型是否支持对话。".into())
    } else {
        Ok(text)
    }
}

/// The model background features call (full-text translation, recommendations): the one for
/// one-shot text features, with its key.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TextModel {
    pub provider: String,
    pub endpoint: String,
    pub model: String,
    pub api_key: String,
    /// The official model, whose key is a token from the collaboration server.
    pub official: bool,
}

/// Resolves [`TextModel`] from the saved settings (see [`work_connection`]). `stale` is an
/// official-model token the server refused; a fresh one is asked for instead.
pub(crate) fn background_model<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    stale: Option<&str>,
    translating: bool,
) -> Result<TextModel, String> {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    let data = state.storage.load()?.ok_or("工作区尚未载入。")?;
    let settings = if translating {
        // Background threads may wait on the server; the plan decides the model.
        tauri::async_runtime::block_on(crate::collaboration::plan(&state));
        translation_connection(&state, &data)?
    } else {
        work_connection(&data, signed_in(&state).as_deref(), false)?
    };
    let provider = settings["provider"]
        .as_str()
        .unwrap_or("ollama")
        .to_string();
    let mut endpoint = settings["endpoint"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let model = settings["model"]
        .as_str()
        .filter(|name| valid_model(name))
        .ok_or("没有选择模型。")?
        .to_string();
    let official = settings["serviceId"] == "capsio";
    let api_key = if official {
        endpoint = crate::collaboration::device(&state)?.endpoint;
        tauri::async_runtime::block_on(crate::collaboration::model_token(
            &state,
            stale.is_some(),
            stale,
        ))?
    } else {
        crate::credentials::load_for_model(state.storage.directory(), &provider, &endpoint)?
            .unwrap_or_default()
    };
    Ok(TextModel {
        provider,
        endpoint,
        model,
        api_key,
        official,
    })
}

/// A background model's answer, and the tokens the request used when the service says
/// (thinking included, which the answer's length does not show).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Answer {
    pub text: String,
    pub tokens: Option<i64>,
}

/// One instruction and one request to a background model. `max_tokens` must leave room for a
/// model that thinks before it answers.
pub(crate) async fn ask(
    model: &TextModel,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<Answer, String> {
    let provider: Provider =
        serde_json::from_value(json!(model.provider)).map_err(|_| "模型服务类型无效。")?;
    let request = AIRequest {
        connection: Connection {
            endpoint: model.endpoint.clone(),
            api_key: Some(model.api_key.clone()).filter(|key| !key.is_empty()),
            provider,
        },
        model: model.model.clone(),
        messages: vec![
            Message {
                role: Role::System,
                content: json!(system),
            },
            Message {
                role: Role::User,
                content: json!(user),
            },
        ],
        max_tokens: Some(max_tokens),
        temperature: Some(0.2),
    };
    // Work the app does by itself: the official gateway gives it an allowance of its own,
    // so it never takes a slot from a conversation. Other services ignore the header.
    let call = completion_call(&request, false, false)?.header("x-capsio-background", "1");
    let value = response(call, 1024 * 1024).await?;
    let text = output(&value, provider);
    if text.trim().is_empty() {
        return Err("模型没有返回文本回答，请检查模型是否支持对话。".into());
    }
    Ok(Answer {
        text,
        tokens: used_tokens(&value),
    })
}

/// The tokens a completion used, as each protocol reports them.
fn used_tokens(value: &Value) -> Option<i64> {
    let usage = &value["usage"];
    let sum = |a: &Value, b: &Value| Some(a.as_i64()? + b.as_i64()?);
    usage["total_tokens"]
        .as_i64()
        .or_else(|| sum(&usage["input_tokens"], &usage["output_tokens"]))
        .or_else(|| sum(&value["prompt_eval_count"], &value["eval_count"]))
        .or_else(|| value["usageMetadata"]["totalTokenCount"].as_i64())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn connection(endpoint: &str, provider: Provider) -> Connection {
        Connection {
            endpoint: endpoint.into(),
            provider,
            api_key: Some("test-only-key".into()),
        }
    }
    pub(crate) fn server(
        responses: Vec<(&str, &str)>,
    ) -> (String, thread::JoinHandle<Vec<String>>) {
        server_mime(
            responses
                .into_iter()
                .map(|(status, body)| (status, "application/json", body))
                .collect(),
        )
    }
    pub(crate) fn server_mime(
        responses: Vec<(&str, &str, &str)>,
    ) -> (String, thread::JoinHandle<Vec<String>>) {
        let replies = responses.into_iter().map(|(status, mime, body)| format!("HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())).collect::<Vec<_>>();
        server_factory(replies.len(), move |index, _| replies[index].clone())
    }
    pub(crate) fn server_factory(
        count: usize,
        reply: impl Fn(usize, &str) -> String + Send + 'static,
    ) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let mut requests = vec![];
            for index in 0..count {
                let deadline = Instant::now() + Duration::from_secs(10);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(5))
                        }
                        other => panic!("test server did not receive a request: {other:?}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = vec![];
                loop {
                    let mut buf = [0; 4096];
                    let count = stream.read(&mut buf).unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buf[..count]);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let len: usize = header
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .unwrap_or("0")
                            .trim()
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
                let request = String::from_utf8(bytes).unwrap();
                let reply = reply(index, &request);
                requests.push(request);
                stream.write_all(reply.as_bytes()).unwrap();
            }
            requests
        });
        (address, handle)
    }
    #[test]
    fn a_rate_limited_chat_waits_and_retries_and_other_refusals_show_only_our_words() {
        let reply = |status: &str, headers: &str, body: &str| {
            format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
        };
        let limited = reply(
            "429 Too Many Requests",
            "Retry-After: 1\r\n",
            r#"{"error":"请求太频繁，请稍后再试。","code":"rate_limited","retryAfter":1}"#,
        );
        let ok = reply("200 OK", "", r#"{"ok":true}"#);
        let call = |base: &str| {
            reqwest::Client::new()
                .post(format!("{base}/v1/chat/completions"))
                .json(&json!({"model":"m"}))
        };
        let (base, handle) = server_factory(2, move |index, _| {
            if index == 0 {
                limited.clone()
            } else {
                ok.clone()
            }
        });
        let started = Instant::now();
        let response = tauri::async_runtime::block_on(stream::send(call(&base))).unwrap();
        assert!(response.status().is_success());
        assert!(started.elapsed() >= Duration::from_secs(1));
        assert_eq!(handle.join().unwrap().len(), 2);

        // No quota is not a moment's wait: our words and the code, at once.
        let quota = reply(
            "402 Payment Required",
            "",
            r#"{"error":"x","code":"quota_exhausted"}"#,
        );
        let (base, handle) = server_factory(1, move |_, _| quota.clone());
        let error = tauri::async_runtime::block_on(stream::send(call(&base))).unwrap_err();
        assert_eq!(error.message, "官方模型额度已用完。（quota_exhausted）");
        assert_eq!(handle.join().unwrap().len(), 1);

        // Another service's own words never reach the UI: they could echo a key.
        let theirs = reply(
            "429 Too Many Requests",
            "",
            r#"{"error":{"message":"key sk-test-only over limit"}}"#,
        );
        let (base, handle) = server_factory(1, move |_, _| theirs.clone());
        let error = tauri::async_runtime::block_on(stream::send(call(&base))).unwrap_err();
        assert!(!error.message.contains("sk-"));
        assert_eq!(handle.join().unwrap().len(), 1);
        assert!(transient("请求太频繁，请稍后再试。（rate_limited）"));
    }

    #[test]
    fn text_features_leave_a_chatgpt_sign_in_to_the_agent() {
        let own = json!({"provider":"openai","endpoint":"https://a.example/v1","model":"m"});
        let mut data = json!({"settings":{"model":own.clone()}});
        assert_eq!(text_connection(&data).unwrap(), own);
        data["settings"]["model"] = json!({"provider":"chatgpt","endpoint":"","model":"gpt"});
        assert!(text_connection(&data).is_err());
        data["settings"]["modelProfiles"] = json!([
            {"id":"c","name":"ChatGPT","provider":"chatgpt","endpoint":"","model":"gpt"},
            {"id":"o","name":"Own","provider":"openai","endpoint":"https://a.example/v1","model":"m"},
            {"id":"s","name":"Official","provider":"openai","serviceId":"capsio","endpoint":"https://s.example","model":"s"},
        ]);
        let chosen = text_connection(&data).unwrap();
        assert_eq!(chosen["model"], "s");
        assert!(chosen.get("id").is_none());
    }

    #[test]
    fn professional_plans_translate_on_the_official_deepseek() {
        assert!(translates_officially(Some("pro")));
        assert!(translates_officially(Some("team")));
        assert!(!translates_officially(Some("free")));
        assert!(!translates_officially(None));
    }

    #[test]
    fn official_first_work_runs_on_the_official_deepseek_once_signed_in() {
        let own = json!({"provider":"openai","endpoint":"https://a.example/v1","model":"m"});
        let mut data = json!({"settings":{"model":own.clone()}});
        let account = Some("https://capsio.example");
        let translating = work_connection(&data, account, true).unwrap();
        assert_eq!(translating["serviceId"], "capsio");
        assert_eq!(translating["endpoint"], "https://capsio.example");
        assert_eq!(translating["model"], TRANSLATION_MODEL);
        // Other work keeps the user's model, and before signing in so does translation.
        assert_eq!(work_connection(&data, account, false).unwrap(), own);
        assert_eq!(work_connection(&data, None, true).unwrap(), own);
        // A ChatGPT sign-in alone: the official model does the work instead of failing.
        data["settings"]["model"] = json!({"provider":"chatgpt","endpoint":"","model":"gpt"});
        assert_eq!(
            work_connection(&data, account, false).unwrap()["serviceId"],
            "capsio"
        );
        assert!(work_connection(&data, None, false).is_err());
    }

    #[test]
    fn bases_keep_custom_prefixes_and_reject_credentials_in_urls() {
        for (url, provider, expected) in [
            ("http://localhost:11434", Provider::Ollama, "/api"),
            ("https://example.com", Provider::Openai, "/v1"),
            (
                "https://example.com/gateway/v1/chat/completions",
                Provider::Openai,
                "/gateway/v1",
            ),
            (
                "https://example.com/api/paas/v4",
                Provider::Openai,
                "/api/paas/v4",
            ),
            ("https://example.com/api/v1", Provider::Anthropic, "/api/v1"),
            ("https://example.com", Provider::Gemini, "/v1beta"),
        ] {
            assert_eq!(base(&connection(url, provider)).unwrap().path(), expected);
        }
        for bad in [
            "file:///tmp/model",
            "https://secret@example.com",
            "https://example.com?key=secret",
            "http://example.com",
            "https://example.com#x",
        ] {
            assert!(base(&connection(bad, Provider::Openai)).is_err());
        }
    }
    #[test]
    fn model_catalogs_use_the_correct_protocol_and_filter_metadata() {
        for (provider, suffix, catalog, path, auth) in [
            (
                Provider::Ollama,
                "",
                r#"{"models":[{"name":"chat-a"},{"model":"chat-a"}]}"#,
                "/api/tags",
                "authorization: bearer test-only-key",
            ),
            (
                Provider::Openai,
                "/gateway/v4",
                r#"{"data":[{"id":"chat-a"},{"id":"image","architecture":{"output_modalities":["image"]}}]}"#,
                "/gateway/v4/models",
                "authorization: bearer test-only-key",
            ),
            (
                Provider::Anthropic,
                "",
                r#"{"data":[{"id":"chat-a","display_name":"Chat A"}],"has_more":false}"#,
                "/v1/models?limit=1000",
                "x-api-key: test-only-key",
            ),
            (
                Provider::Gemini,
                "",
                r#"{"models":[{"name":"models/chat-a","displayName":"Chat A","supportedGenerationMethods":["generateContent"]},{"name":"models/embedding","supportedGenerationMethods":["embedContent"]}]}"#,
                "/v1beta/models?pageSize=1000",
                "x-goog-api-key: test-only-key",
            ),
            (
                Provider::Openai,
                "/compatible-mode/v1",
                r#"{"output":{"total":1,"models":[{"model":"chat-a","name":"Chat A"}]}}"#,
                "/api/v1/models?page_no=1&page_size=100&capabilities=TG",
                "authorization: bearer test-only-key",
            ),
        ] {
            let (url, server) = server(vec![("200 OK", catalog)]);
            let models = tauri::async_runtime::block_on(research_list_models(connection(
                &(url + suffix),
                provider,
            )))
            .unwrap();
            let sent = server.join().unwrap();
            assert_eq!(models.len(), 1);
            assert_eq!(models[0].id, "chat-a");
            assert!(
                sent[0].starts_with(&format!("GET {path} HTTP/1.1")),
                "{}",
                sent[0]
            );
            assert!(sent[0].to_lowercase().contains(auth));
            assert!(!sent[0].lines().next().unwrap().contains("test-only-key"));
        }
    }
    #[test]
    fn paginated_catalogs_keep_all_models_and_reject_broken_pages() {
        for (provider, first, second, cursor) in [
            (
                Provider::Anthropic,
                r#"{"data":[{"id":"a"}],"has_more":true,"last_id":"a"}"#,
                r#"{"data":[{"id":"b"}],"has_more":false}"#,
                "after_id=a",
            ),
            (
                Provider::Gemini,
                r#"{"models":[{"name":"models/a","supportedGenerationMethods":["generateContent"]}],"nextPageToken":"next"}"#,
                r#"{"models":[{"name":"models/b","supportedGenerationMethods":["generateContent"]}]}"#,
                "pageToken=next",
            ),
        ] {
            let (url, server) = server(vec![("200 OK", first), ("200 OK", second)]);
            let models =
                tauri::async_runtime::block_on(research_list_models(connection(&url, provider)))
                    .unwrap();
            assert_eq!(models.len(), 2);
            assert!(server.join().unwrap()[1].contains(cursor));
        }
        let (url, server) = server(vec![("200 OK", r#"{"data":[],"has_more":true}"#)]);
        assert!(
            tauri::async_runtime::block_on(research_list_models(connection(
                &url,
                Provider::Anthropic
            )))
            .is_err()
        );
        server.join().unwrap();
    }
    #[test]
    fn probes_and_chat_share_adapters_without_sending_research_to_the_probe() {
        for (provider, answer, path, auth) in [
            (
                Provider::Ollama,
                r#"{"message":{"content":"answer"}}"#,
                "/api/chat",
                "authorization: bearer test-only-key",
            ),
            (
                Provider::Openai,
                r#"{"choices":[{"message":{"content":"answer"}}]}"#,
                "/v1/chat/completions",
                "authorization: bearer test-only-key",
            ),
            (
                Provider::Anthropic,
                r#"{"content":[{"type":"text","text":"answer"}]}"#,
                "/v1/messages",
                "x-api-key: test-only-key",
            ),
            (
                Provider::Gemini,
                r#"{"candidates":[{"content":{"parts":[{"thought":true,"text":"private"},{"text":"answer"}]}}]}"#,
                "/v1beta/models/chat-a:generateContent",
                "x-goog-api-key: test-only-key",
            ),
        ] {
            let (url, server) = server(vec![("200 OK", answer), ("200 OK", answer)]);
            tauri::async_runtime::block_on(research_test_model(ModelTest {
                connection: connection(&url, provider),
                model: "chat-a".into(),
            }))
            .unwrap();
            let request = AIRequest {
                max_tokens: None,
                temperature: None,
                connection: connection(&url, provider),
                model: "chat-a".into(),
                messages: vec![
                    Message {
                        role: Role::System,
                        content: "system-instruction".into(),
                    },
                    Message {
                        role: Role::User,
                        content: "research material".into(),
                    },
                ],
            };
            let result = tauri::async_runtime::block_on(completion(&request, false)).unwrap();
            assert_eq!(output(&result, provider), "answer");
            let sent = server.join().unwrap();
            assert!(sent[0].starts_with(&format!("POST {path} HTTP/1.1")));
            assert!(sent[0].to_lowercase().contains(auth));
            assert!(sent[0].contains("Reply OK."));
            assert!(!sent[0].contains("research material"));
            assert!(sent[1].contains("research material"));
            let body: Value =
                serde_json::from_str(sent[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
            if matches!(provider, Provider::Anthropic) {
                assert_eq!(body["system"], "system-instruction");
                assert_eq!(body["messages"].as_array().unwrap().len(), 1);
            }
            if matches!(provider, Provider::Gemini) {
                assert_eq!(
                    body["systemInstruction"]["parts"][0]["text"],
                    "system-instruction"
                );
            }
        }
    }
    #[test]
    fn public_catalog_or_http_success_does_not_prove_chat_access() {
        for (status, body, expected) in [
            ("401 Unauthorized", r#"{"error":"test-only-key"}"#, "401"),
            ("200 OK", r#"{"data":[{"id":"a"}]}"#, "有效的聊天响应"),
        ] {
            let (url, server) = server(vec![(status, body)]);
            let error = tauri::async_runtime::block_on(research_test_model(ModelTest {
                connection: connection(&url, Provider::Openai),
                model: "a".into(),
            }))
            .unwrap_err();
            server.join().unwrap();
            assert!(error.contains(expected));
            assert!(!error.contains("test-only-key"));
        }
    }
    #[test]
    fn ipc_flattening_preserves_provider_and_credentials() {
        let request: AIRequest = serde_json::from_value(json!({"endpoint":"https://example.com/v1","provider":"anthropic","apiKey":"test-only-key","model":"a","messages":[{"role":"user","content":"hello"}]})).unwrap();
        assert!(matches!(request.connection.provider, Provider::Anthropic));
        assert_eq!(request.connection.api_key.as_deref(), Some("test-only-key"));
    }

    #[test]
    fn passing_failures_are_told_from_wrong_settings() {
        for error in [
            TIMED_OUT,
            UNREACHABLE,
            LIMITED,
            "模型服务返回 HTTP 503，请检查服务状态。",
        ] {
            assert!(transient(error), "{error}");
        }
        for error in [
            "服务拒绝访问（401/403），请检查 API 密钥、服务区域及模型权限。",
            "模型服务返回 HTTP 400，请检查服务状态。",
            "模型没有返回文本回答，请检查模型是否支持对话。",
        ] {
            assert!(!transient(error), "{error}");
        }
    }

    #[test]
    fn token_usage_is_read_in_every_protocol() {
        assert_eq!(
            used_tokens(
                &json!({"usage":{"prompt_tokens":10,"completion_tokens":90,"total_tokens":100}})
            ),
            Some(100)
        );
        assert_eq!(
            used_tokens(&json!({"usage":{"input_tokens":10,"output_tokens":5}})),
            Some(15)
        );
        assert_eq!(
            used_tokens(&json!({"prompt_eval_count":7,"eval_count":3})),
            Some(10)
        );
        assert_eq!(
            used_tokens(&json!({"usageMetadata":{"totalTokenCount":42}})),
            Some(42)
        );
        assert_eq!(used_tokens(&json!({"choices":[]})), None);
    }
}
