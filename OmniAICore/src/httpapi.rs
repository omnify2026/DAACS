#![allow(non_snake_case)]

use crate::cli::OmniCliRunResult;

const LOCAL_LLM_TOOL_USE_SYSTEM_PROMPT: &str = "You are running with host-registered filesystem tools. Hard rules: (1) To read, verify, or inspect any file on disk you MUST call the read_file tool. (2) To create or overwrite any file you MUST call the write_file tool with the exact path and full file content. (3) Never claim you read or wrote a file using only natural language—if the task touches the filesystem, emit the required tool calls in this turn. (4) Do not paste entire intended file contents as plain assistant text instead of write_file; the host only persists changes from tool results. (5) Prefer read_file before write_file when the source file already exists. (6) When the task names a project or workspace directory, pass that directory as optional InWorkspaceRoot on read_file, write_file, and execute_cli, and keep InPath or relative paths anchored to that root. Short summaries after tool calls are fine; skipping tool calls for real file I/O is not.";

fn ReadEnvTrimmed(InKey: &str) -> Option<String> {
    std::env::var(InKey)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn ReadEnvBool(InKey: &str, InDefault: bool) -> bool {
    let value = match ReadEnvTrimmed(InKey) {
        Some(v) => v.to_lowercase(),
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

fn FetchToolSchemas(
    InClient: &reqwest::blocking::Client,
    InToolServerBaseUrl: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let endpoint = format!("{}/tools", InToolServerBaseUrl.trim_end_matches('/'));
    let response = InClient
        .get(endpoint)
        .send()
        .map_err(|e| format!("Tool schema request failed: {}", e))?;
    let status = response.status();
    let raw = response
        .text()
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

fn CallToolServer(
    InClient: &reqwest::blocking::Client,
    InToolServerBaseUrl: &str,
    InToolName: &str,
    InArguments: serde_json::Value,
) -> serde_json::Value {
    let endpoint = format!("{}/tool-call", InToolServerBaseUrl.trim_end_matches('/'));
    let payload = serde_json::json!({
        "InToolName": InToolName,
        "InArguments": InArguments
    });
    let response = InClient.post(endpoint).json(&payload).send();
    let Ok(resp) = response else {
        return serde_json::json!({
            "ok": false,
            "error": "tool_call_request_failed"
        });
    };
    let status = resp.status();
    let raw = resp.text().unwrap_or_else(|_| String::new());
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

pub fn RunLocalLlmSync(InPrompt: String) -> Result<OmniCliRunResult, String> {
    let model = ReadEnvTrimmed("DAACS_LOCAL_LLM_MODEL")
        .ok_or_else(|| "DAACS_LOCAL_LLM_MODEL is not set".to_string())?;
    let baseUrl = ReadEnvTrimmed("DAACS_LOCAL_LLM_BASE_URL")
        .unwrap_or_else(|| "http://127.0.0.1:11434".to_string());
    let enableTools = ReadEnvBool("DAACS_LOCAL_LLM_ENABLE_TOOLS", true);
    let toolServerBaseUrl = ReadEnvTrimmed("DAACS_LOCAL_LLM_TOOL_SERVER_URL")
        .unwrap_or_else(|| "http://127.0.0.1:8000".to_string());
    if model.trim().is_empty() {
        return Err("DAACS_LOCAL_LLM_MODEL is empty".to_string());
    }
    if baseUrl.trim().is_empty() {
        return Err("DAACS_LOCAL_LLM_BASE_URL is empty".to_string());
    }

    let endpoint = format!("{}/api/chat", baseUrl.trim_end_matches('/'));
    let client = reqwest::blocking::Client::new();
    let mut toolDiag = String::new();
    let tools = if enableTools {
        match FetchToolSchemas(&client, &toolServerBaseUrl) {
            Ok(v) => v,
            Err(e) => {
                toolDiag = format!("ToolCalling disabled: {}", e);
                Vec::new()
            }
        }
    } else {
        toolDiag = "ToolCalling disabled by DAACS_LOCAL_LLM_ENABLE_TOOLS=false".to_string();
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
            return Ok(OmniCliRunResult {
                stdout: String::new(),
                stderr: "LocalLLM tool-call loop exceeded limit".to_string(),
                exit_code: 1,
                provider: "local_llm".to_string(),
            });
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
            .map_err(|e| format!("LocalLLM request failed: {}", e))?;
        let status = response.status();
        let raw = response
            .text()
            .map_err(|e| format!("LocalLLM response read failed: {}", e))?;
        if !status.is_success() {
            return Ok(OmniCliRunResult {
                stdout: String::new(),
                stderr: format!("LocalLLM HTTP {}: {}", status.as_u16(), raw),
                exit_code: status.as_u16() as i32,
                provider: "local_llm".to_string(),
            });
        }
        let parsed = match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(v) => v,
            Err(_) => {
                return Ok(OmniCliRunResult {
                    stdout: raw,
                    stderr: String::new(),
                    exit_code: 0,
                    provider: "local_llm".to_string(),
                })
            }
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
            return Ok(OmniCliRunResult {
                stdout: content,
                stderr,
                exit_code: 0,
                provider: "local_llm".to_string(),
            });
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
            let toolResult = CallToolServer(&client, &toolServerBaseUrl, &toolName, toolArgs);
            messages.push(serde_json::json!({
                "role": "tool",
                "name": toolName,
                "content": toolResult.to_string()
            }));
        }
    }
}
