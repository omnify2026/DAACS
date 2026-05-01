use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn env_var(in_key: &str) -> Option<String> {
    std::env::var(in_key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Debug, Clone)]
pub struct OmniCliWhich {
    pub preferred: String,
    pub codex: Option<PathBuf>,
    pub gemini: Option<PathBuf>,
    pub local_llm: Option<PathBuf>,
}

fn which_path(in_name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        for p in std::env::split_paths(&paths) {
            let candidate = p.join(in_name);
            if candidate.is_file() {
                return Some(candidate);
            }
            #[cfg(windows)]
            {
                let with_ext = p.join(format!("{}.cmd", in_name));
                if with_ext.is_file() {
                    return Some(with_ext);
                }
                let with_exe = p.join(format!("{}.exe", in_name));
                if with_exe.is_file() {
                    return Some(with_exe);
                }
            }
        }
        None
    })
}

fn resolve_gemini() -> Option<PathBuf> {
    if let Some(p) = env_var("DAACS_GEMINI_CLI_PATH") {
        let path = Path::new(&p);
        if path.exists() {
            return Some(path.to_path_buf());
        }
        return None;
    }
    for name in ["gemini", "gemini.cmd", "gemini.exe"] {
        if let Some(path) = which_path(name) {
            return Some(path);
        }
    }
    if let Some(appdata) = env_var("APPDATA") {
        let candidate = Path::new(&appdata).join("npm").join("gemini.cmd");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    if let Some(local) = env_var("LOCALAPPDATA") {
        let candidate = Path::new(&local).join("npm").join("gemini.cmd");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_codex() -> Option<PathBuf> {
    if let Some(p) = env_var("DAACS_CODEX_CLI_PATH") {
        let path = Path::new(&p);
        if path.exists() {
            return Some(path.to_path_buf());
        }
        return None;
    }
    for name in ["codex", "codex.cmd", "codex.exe"] {
        if let Some(path) = which_path(name) {
            return Some(path);
        }
    }
    if let Some(appdata) = env_var("APPDATA") {
        let candidate = Path::new(&appdata).join("npm").join("codex.cmd");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    if let Some(local) = env_var("LOCALAPPDATA") {
        let candidate = Path::new(&local).join("npm").join("codex.cmd");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_local_llm() -> Option<PathBuf> {
    if let Some(p) = env_var("DAACS_LOCAL_LLM_CLI_PATH") {
        let path = Path::new(&p);
        if path.exists() {
            return Some(path.to_path_buf());
        }
        return None;
    }
    for name in ["ollama", "ollama.exe"] {
        if let Some(path) = which_path(name) {
            return Some(path);
        }
    }
    None
}

fn preferred_provider() -> &'static str {
    match env_var("DAACS_CLI_PROVIDER").as_deref() {
        Some("codex") => "codex",
        Some("gemini") => "gemini",
        Some("local_llm") => "local_llm",
        _ => "gemini",
    }
}

fn sanitize_filename(in_name: &str) -> String {
    in_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect()
}

fn cli_workspace_dir(in_project_id: Option<String>) -> Result<PathBuf, String> {
    let base = std::env::temp_dir().join("daacs_workspace");
    let dir = match in_project_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(id) => base.join(sanitize_filename(id)),
        None => base.join("default"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

static CLI_INIT: OnceLock<Result<OmniCliWhich, String>> = OnceLock::new();

fn ensure_initialized() -> Result<OmniCliWhich, String> {
    CLI_INIT
        .get_or_init(|| {
            let preferred = preferred_provider().to_string();
            let codex = resolve_codex();
            let gemini = resolve_gemini();
            let local_llm = resolve_local_llm();
            Ok(OmniCliWhich {
                preferred,
                codex,
                gemini,
                local_llm,
            })
        })
        .clone()
}

static WORKSPACE_CACHE: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

pub fn initialize_local_cli() -> Result<(), String> {
    ensure_initialized().map(|_| ())
}

pub fn local_cli_which() -> Result<OmniCliWhich, String> {
    ensure_initialized()
}

pub fn cli_which_json() -> Result<serde_json::Value, String> {
    let which = ensure_initialized()?;
    Ok(serde_json::json!({
        "preferred": which.preferred,
        "codex": which.codex.and_then(|p| p.into_os_string().into_string().ok()),
        "gemini": which.gemini.and_then(|p| p.into_os_string().into_string().ok()),
        "local_llm": which.local_llm.and_then(|p| p.into_os_string().into_string().ok()),
    }))
}

fn workspace_cache_key(in_project_id: Option<&str>) -> String {
    match in_project_id.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(id) => sanitize_filename(id),
        None => "default".to_string(),
    }
}

pub fn cli_workspace_path(in_project_id: Option<String>) -> Result<PathBuf, String> {
    let key = workspace_cache_key(in_project_id.as_deref());
    let cache = WORKSPACE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(v) = cache.lock().ok().and_then(|g| g.get(&key).cloned()) {
        return Ok(v);
    }
    let dir = cli_workspace_dir(in_project_id)?;
    if let Ok(mut guard) = cache.lock() {
        guard.insert(key, dir.clone());
    }
    Ok(dir)
}

#[derive(Debug, Clone)]
pub struct OmniCliRunResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub provider: String,
}

fn parse_provider_override(in_provider_override: Option<&String>, in_default: &str) -> String {
    match in_provider_override
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        Some(s) if s.eq_ignore_ascii_case("gemini") => "gemini".to_string(),
        Some(s) if s.eq_ignore_ascii_case("codex") => "codex".to_string(),
        Some(s) if s.eq_ignore_ascii_case("local_llm") => "local_llm".to_string(),
        _ => in_default.to_string(),
    }
}

fn run_gemini_subprocess_sync(
    exe: &PathBuf,
    prompt: &str,
    cwd: &PathBuf,
    approval_mode: Option<&String>,
    gemini_model: &str,
) -> Result<OmniCliRunResult, String> {
    #[cfg(windows)]
    {
        use std::io::Write;
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/c")
            .arg(exe)
            .arg("--model")
            .arg(gemini_model)
            .arg("--include-directories")
            .arg(cwd);
        if let Some(mode) = approval_mode {
            cmd.args(["--approval-mode", mode]);
        } else {
            cmd.arg("-y");
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(cwd)
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .env_remove("http_proxy")
            .env_remove("https_proxy")
            .creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }

        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        return Ok(OmniCliRunResult {
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            exit_code: out.status.code().unwrap_or(-1),
            provider: "gemini".to_string(),
        });
    }

    #[cfg(not(windows))]
    {
        use std::io::Write;
        let mut cmd = Command::new(exe);
        cmd.arg("--model")
            .arg(gemini_model)
            .arg("--include-directories")
            .arg(cwd);
        if let Some(mode) = approval_mode {
            cmd.args(["--approval-mode", mode]);
        } else {
            cmd.arg("-y");
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(cwd)
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .env_remove("http_proxy")
            .env_remove("https_proxy")
            .spawn()
            .map_err(|e| e.to_string())?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }

        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        return Ok(OmniCliRunResult {
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            exit_code: out.status.code().unwrap_or(-1),
            provider: "gemini".to_string(),
        });
    }
}

fn run_gemini_sync(
    exe: PathBuf,
    prompt: String,
    cwd: PathBuf,
    approval_mode: Option<String>,
) -> Result<OmniCliRunResult, String> {
    let explicit_model = std::env::var("DAACS_GEMINI_MODEL").unwrap_or_default();

    let fallback_chain = if !explicit_model.trim().is_empty() {
        vec![explicit_model.trim().to_string()]
    } else {
        vec![
            "gemini-3.1-pro-preview".to_string(),
            "gemini-2.5-pro".to_string(),
            "gemini-2.5-flash".to_string(),
            "gemini-3-flash-preview".to_string(),
            "gemini-2.5-flash-lite".to_string(),
        ]
    };

    let mut last_res: Option<OmniCliRunResult> = None;

    for model in fallback_chain {
        let res = run_gemini_subprocess_sync(&exe, &prompt, &cwd, approval_mode.as_ref(), &model)?;

        let should_retry = if res.exit_code != 0 {
            let combined = format!("{}\n{}", res.stdout, res.stderr).to_lowercase();
            combined.contains("503")
                || combined.contains("429")
                || combined.contains("exhausted")
                || combined.contains("capacity")
                || combined.contains("quota")
                || combined.contains("usage limit")
        } else {
            false
        };

        last_res = Some(res);
        if !should_retry {
            break;
        }
    }

    Ok(last_res.unwrap())
}

fn run_codex_sync(exe: PathBuf, prompt: String, cwd: PathBuf) -> Result<OmniCliRunResult, String> {
    let model = env_var("DAACS_CODEX_MODEL").unwrap_or_else(|| "gpt-4o".to_string());

    #[cfg(windows)]
    {
        use std::io::Write;
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("cmd.exe");
        let cwd_str = cwd.to_string_lossy().to_string();
        cmd.arg("/c")
            .arg(&exe)
            .args([
                "exec",
                "--ephemeral",
                "-m",
                model.as_str(),
                "-C",
                cwd_str.as_str(),
                "-",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(&cwd)
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .env_remove("http_proxy")
            .env_remove("https_proxy")
            .creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        return Ok(OmniCliRunResult {
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            exit_code: out.status.code().unwrap_or(-1),
            provider: "codex".to_string(),
        });
    }

    #[cfg(not(windows))]
    {
        let cwd_str = cwd.to_string_lossy().to_string();
        let mut child = Command::new(exe)
            .args([
                "exec",
                "--ephemeral",
                "-m",
                model.as_str(),
                "-C",
                cwd_str.as_str(),
                "-",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(cwd)
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .env_remove("http_proxy")
            .env_remove("https_proxy")
            .spawn()
            .map_err(|e| e.to_string())?;

        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            stdin
                .write_all(prompt.as_bytes())
                .map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }

        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        return Ok(OmniCliRunResult {
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            exit_code: out.status.code().unwrap_or(-1),
            provider: "codex".to_string(),
        });
    }
}

pub fn run_local_cli_command(
    in_instruction: String,
    in_cwd: Option<PathBuf>,
    in_system_prompt: Option<String>,
    in_provider_override: Option<String>,
    in_approval_mode: Option<String>,
) -> Result<OmniCliRunResult, String> {
    let cwd =
        in_cwd.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let instruction = in_instruction.trim().to_string();
    if instruction.is_empty() {
        return Err("Instruction is empty".to_string());
    }

    let full_prompt = match in_system_prompt
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        Some(sp) => format!("{}\n\n---\n\n{}", sp, instruction),
        None => instruction.to_string(),
    };

    let which = ensure_initialized()?;
    let prefer = parse_provider_override(in_provider_override.as_ref(), &which.preferred);

    if prefer == "local_llm" {
        return crate::httpApi::RunLocalLlmSync(full_prompt);
    }

    let (provider, exe) = if prefer == "codex" {
        if let Some(p) = which.codex {
            ("codex".to_string(), p)
        } else if let Some(p) = which.gemini {
            ("gemini".to_string(), p)
        } else if let Some(p) = which.local_llm {
            ("local_llm".to_string(), p)
        } else {
            return Err("No available CLI provider found. Install codex/gemini/ollama CLI or set DAACS_CODEX_CLI_PATH / DAACS_GEMINI_CLI_PATH / DAACS_LOCAL_LLM_CLI_PATH.".to_string());
        }
    } else {
        if let Some(p) = which.gemini {
            ("gemini".to_string(), p)
        } else if let Some(p) = which.codex {
            ("codex".to_string(), p)
        } else if let Some(p) = which.local_llm {
            ("local_llm".to_string(), p)
        } else {
            return Err("No available CLI provider found. Install gemini/codex/ollama CLI or set DAACS_GEMINI_CLI_PATH / DAACS_CODEX_CLI_PATH / DAACS_LOCAL_LLM_CLI_PATH.".to_string());
        }
    };

    if provider == "gemini" {
        run_gemini_sync(exe, full_prompt, cwd, in_approval_mode)
    } else {
        run_codex_sync(exe, full_prompt, cwd)
    }
}
