use std::time::Duration;

const LOCAL_LLM_TOOL_USE_SYSTEM_PROMPT: &str = "You are running with host-registered filesystem tools. Hard rules: (1) To read, verify, or inspect any file on disk you MUST call the read_file tool. (2) To create or overwrite any file you MUST call the write_file tool with the exact path and full file content. (3) Never claim you read or wrote a file using only natural language—if the task touches the filesystem, emit the required tool calls in this turn. (4) Do not paste entire intended file contents as plain assistant text instead of write_file; the host only persists changes from tool results. (5) Prefer read_file before write_file when the source file already exists. (6) When the task names a project or workspace directory, pass that directory as optional InWorkspaceRoot on read_file, write_file, and execute_cli, and keep InPath or relative paths anchored to that root. Short summaries after tool calls are fine; skipping tool calls for real file I/O is not.";

fn ReadEnvTrimmed(InKey: &str) -> Option<String> {
    std::env::var(InKey)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn ParseBoolWithDefault(InValue: Option<String>, InDefault: bool) -> bool {
    let value = match InValue {
        Some(v) => v.trim().to_lowercase(),
        None => return InDefault,
    };
    if value == "1" || value == "true" || value == "yes" || value == "on" {
        return true;
    }
    if value == "0" || value == "false" || value == "no" || value == "off" {
        return false;
    }
    InDefault
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalLlmToolConfig {
    enabled: bool,
    base_url: Option<String>,
    disabled_diag: String,
}

fn ResolveLocalLlmToolConfig(
    InEnableTools: Option<String>,
    InToolServerBaseUrl: Option<String>,
) -> LocalLlmToolConfig {
    let base_url = InToolServerBaseUrl
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let enable_value = InEnableTools.map(|value| value.trim().to_lowercase());
    let explicit_enable = matches!(enable_value.as_deref(), Some("1" | "true" | "yes" | "on"));
    let explicit_disable = matches!(enable_value.as_deref(), Some("0" | "false" | "no" | "off"));
    let enabled = ParseBoolWithDefault(enable_value, base_url.is_some());
    if !enabled {
        return LocalLlmToolConfig {
            enabled: false,
            base_url,
            disabled_diag: if explicit_disable {
                "ToolCalling disabled by DAACS_LOCAL_LLM_ENABLE_TOOLS=false".to_string()
            } else {
                String::new()
            },
        };
    }
    if base_url.is_none() {
        return LocalLlmToolConfig {
            enabled: false,
            base_url: None,
            disabled_diag: if explicit_enable {
                "ToolCalling disabled: DAACS_LOCAL_LLM_TOOL_SERVER_URL is not set".to_string()
            } else {
                String::new()
            },
        };
    }
    LocalLlmToolConfig {
        enabled: true,
        base_url,
        disabled_diag: String::new(),
    }
}

fn ParseMessageContent(InParsed: &serde_json::Value, InRaw: &str) -> String {
    InParsed
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            InParsed
                .get("response")
                .and_then(|c| c.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| InRaw.to_string())
}

fn ParseToolCalls(InParsed: &serde_json::Value) -> Vec<(String, serde_json::Value)> {
    let mut out = Vec::<(String, serde_json::Value)>::new();
    let calls = InParsed
        .get("message")
        .and_then(|m| m.get("tool_calls"))
        .and_then(|v| v.as_array());
    let Some(toolCalls) = calls else {
        return out;
    };
    for call in toolCalls {
        let function = call.get("function");
        let name = function
            .and_then(|f| f.get("name"))
            .and_then(|n| n.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let Some(toolName) = name else {
            continue;
        };
        let argsValue = function.and_then(|f| f.get("arguments")).cloned();
        let toolArgs = match argsValue {
            Some(serde_json::Value::Object(_)) => argsValue.unwrap_or(serde_json::json!({})),
            Some(serde_json::Value::String(s)) => {
                serde_json::from_str::<serde_json::Value>(&s).unwrap_or(serde_json::json!({}))
            }
            _ => serde_json::json!({}),
        };
        out.push((toolName, toolArgs));
    }
    out
}

async fn FetchToolSchemasAsync(
    InClient: &reqwest::Client,
    InToolServerBaseUrl: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let endpoint = format!("{}/tools", InToolServerBaseUrl.trim_end_matches('/'));
    let response = InClient
        .get(endpoint)
        .send()
        .await
        .map_err(|e| format!("Tool schema request failed: {}", e))?;
    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|e| format!("Tool schema read failed: {}", e))?;
    if !status.is_success() {
        return Err(format!("Tool schema HTTP {}: {}", status.as_u16(), raw));
    }
    let parsed = serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|e| format!("Tool schema parse failed: {}", e))?;
    let out = parsed
        .get("tools")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(out)
}

async fn CallToolServerAsync(
    InClient: &reqwest::Client,
    InToolServerBaseUrl: &str,
    InToolName: &str,
    InArguments: serde_json::Value,
) -> serde_json::Value {
    let endpoint = format!("{}/tool-call", InToolServerBaseUrl.trim_end_matches('/'));
    let payload = serde_json::json!({
        "InToolName": InToolName,
        "InArguments": InArguments
    });
    let response = InClient.post(endpoint).json(&payload).send().await;
    let Ok(resp) = response else {
        return serde_json::json!({
            "ok": false,
            "error": "tool_call_request_failed"
        });
    };
    let status = resp.status();
    let raw = resp.text().await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        return serde_json::json!({
            "ok": false,
            "status": status.as_u16(),
            "error": raw
        });
    }
    serde_json::from_str::<serde_json::Value>(&raw).unwrap_or_else(|_| {
        serde_json::json!({
            "ok": true,
            "raw": raw
        })
    })
}

pub async fn RunLocalLlmAsync(
    InPrompt: &str,
    InLocalLlmBaseUrl: Option<String>,
) -> Result<(String, String, i32), String> {
    let model = ReadEnvTrimmed("DAACS_LOCAL_LLM_MODEL")
        .ok_or_else(|| "DAACS_LOCAL_LLM_MODEL is not set".to_string())?;
    let tool_config = ResolveLocalLlmToolConfig(
        ReadEnvTrimmed("DAACS_LOCAL_LLM_ENABLE_TOOLS"),
        ReadEnvTrimmed("DAACS_LOCAL_LLM_TOOL_SERVER_URL"),
    );
    let baseUrl = InLocalLlmBaseUrl
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| ReadEnvTrimmed("DAACS_LOCAL_LLM_BASE_URL"))
        .unwrap_or_else(|| "http://127.0.0.1:11434".to_string());
    if model.trim().is_empty() {
        return Err("DAACS_LOCAL_LLM_MODEL is empty".to_string());
    }
    if baseUrl.trim().is_empty() {
        return Err("DAACS_LOCAL_LLM_BASE_URL is empty".to_string());
    }

    let endpoint = format!("{}/api/chat", baseUrl.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("LocalLLM HTTP client init failed: {}", e))?;
    let mut toolDiag = String::new();
    let tools = if tool_config.enabled {
        let tool_server_base_url = tool_config
            .base_url
            .as_deref()
            .ok_or_else(|| "DAACS_LOCAL_LLM_TOOL_SERVER_URL is not set".to_string())?;
        match FetchToolSchemasAsync(&client, tool_server_base_url).await {
            Ok(v) => v,
            Err(e) => {
                toolDiag = format!("ToolCalling disabled: {}", e);
                Vec::new()
            }
        }
    } else {
        toolDiag = tool_config.disabled_diag.clone();
        Vec::new()
    };
    let mut messages = if tools.is_empty() {
        vec![serde_json::json!({
            "role": "user",
            "content": InPrompt
        })]
    } else {
        vec![
            serde_json::json!({
                "role": "system",
                "content": LOCAL_LLM_TOOL_USE_SYSTEM_PROMPT
            }),
            serde_json::json!({
                "role": "user",
                "content": InPrompt
            }),
        ]
    };
    let mut safetyLoopCount = 0;
    let mut toolCallCount = 0i32;
    loop {
        safetyLoopCount += 1;
        if safetyLoopCount > 8 {
            return Ok((
                String::new(),
                "LocalLLM tool-call loop exceeded limit".to_string(),
                1,
            ));
        }
        let body = if tools.is_empty() {
            serde_json::json!({
                "model": model,
                "messages": messages,
                "stream": false
            })
        } else {
            serde_json::json!({
                "model": model,
                "messages": messages,
                "tools": tools,
                "stream": false
            })
        };
        let response = client
            .post(&endpoint)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("LocalLLM request failed: {}", e))?;
        let status = response.status();
        let raw = response
            .text()
            .await
            .map_err(|e| format!("LocalLLM response read failed: {}", e))?;
        if !status.is_success() {
            return Ok((
                String::new(),
                format!("LocalLLM HTTP {}: {}", status.as_u16(), raw),
                status.as_u16() as i32,
            ));
        }
        let parsed = match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(v) => v,
            Err(_) => return Ok((raw, String::new(), 0)),
        };
        let toolCalls = ParseToolCalls(&parsed);
        if toolCalls.is_empty() {
            let content = ParseMessageContent(&parsed, &raw);
            let mut stderr = String::new();
            if !toolDiag.is_empty() {
                stderr.push_str(&toolDiag);
            }
            if toolCallCount > 0 {
                if !stderr.is_empty() {
                    stderr.push('\n');
                }
                stderr.push_str(&format!("ToolCalling executed {} calls", toolCallCount));
            }
            return Ok((content, stderr, 0));
        }
        let assistantMessage = parsed.get("message").cloned().unwrap_or_else(|| {
            serde_json::json!({
                "role": "assistant",
                "content": ""
            })
        });
        messages.push(assistantMessage);
        for (toolName, toolArgs) in toolCalls {
            toolCallCount += 1;
            let tool_server_base_url = tool_config
                .base_url
                .as_deref()
                .ok_or_else(|| "DAACS_LOCAL_LLM_TOOL_SERVER_URL is not set".to_string())?;
            let toolResult =
                CallToolServerAsync(&client, tool_server_base_url, &toolName, toolArgs).await;
            messages.push(serde_json::json!({
                "role": "tool",
                "name": toolName,
                "content": toolResult.to_string()
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_llm_tools_default_off_without_explicit_tool_server() {
        let config = ResolveLocalLlmToolConfig(None, None);
        assert!(!config.enabled);
        assert_eq!(config.base_url, None);
        assert!(config.disabled_diag.is_empty());
    }

    #[test]
    fn local_llm_tools_enable_when_tool_server_is_explicit() {
        let config = ResolveLocalLlmToolConfig(None, Some(" http://127.0.0.1:17654 ".to_string()));
        assert!(config.enabled);
        assert_eq!(config.base_url.as_deref(), Some("http://127.0.0.1:17654"));
    }

    #[test]
    fn local_llm_tools_explicit_true_requires_explicit_tool_server() {
        let config = ResolveLocalLlmToolConfig(Some("true".to_string()), None);
        assert!(!config.enabled);
        assert_eq!(
            config.disabled_diag,
            "ToolCalling disabled: DAACS_LOCAL_LLM_TOOL_SERVER_URL is not set"
        );
    }

    #[test]
    fn local_llm_tools_explicit_false_overrides_tool_server() {
        let config = ResolveLocalLlmToolConfig(
            Some("false".to_string()),
            Some("http://127.0.0.1:17654".to_string()),
        );
        assert!(!config.enabled);
        assert_eq!(
            config.disabled_diag,
            "ToolCalling disabled by DAACS_LOCAL_LLM_ENABLE_TOOLS=false"
        );
    }
}
