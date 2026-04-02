use debug_print::debug_println;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::model::ensure_model_downloaded;
use crate::APP_HANDLE;

use once_cell::sync::OnceCell;
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

fn detect_cuda_version_from_nvidia_smi(output: &str) -> Option<String> {
    for line in output.lines() {
        if let Some(idx) = line.find("CUDA Version") {
            let s = &line[idx..];
            if let Some(colon) = s.find(':') {
                let v = s[(colon + 1)..].trim();
                if !v.is_empty() {
                    return Some(v.split_whitespace().next().unwrap_or("").to_string());
                }
            }
        }
    }
    None
}

async fn try_detect_cuda_version() -> Option<String> {
    let out = tokio::process::Command::new("nvidia-smi")
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    detect_cuda_version_from_nvidia_smi(&text)
}

#[allow(dead_code)]
fn cuda_extra_index_url(version: &str) -> Option<&'static str> {
    if version.starts_with("12.1") {
        return Some("https://abetlen.github.io/llama-cpp-python/whl/cu121");
    }
    if version.starts_with("12.2") {
        return Some("https://abetlen.github.io/llama-cpp-python/whl/cu122");
    }
    if version.starts_with("12.3") {
        return Some("https://abetlen.github.io/llama-cpp-python/whl/cu123");
    }
    if version.starts_with("12.4") {
        return Some("https://abetlen.github.io/llama-cpp-python/whl/cu124");
    }
    None
}

async fn llama_system_info(app: &tauri::AppHandle) -> Result<String, String> {
    let vpy = venv_python(app)?;
    let mut cmd = tokio::process::Command::new(&vpy);
    cmd.arg("-c").arg(
        "from llama_cpp import llama_cpp as lc; import sys; sys.stdout.write(lc.llama_print_system_info())",
    );
    run_cmd(cmd).await
}

// Use GGUF on HuggingFace for smaller runtime (llama.cpp).
const DEFAULT_HF_REPO: &str = "tencent/HY-MT1.5-1.8B-GGUF";
const DEFAULT_GGUF_FILENAME: &str = "HY-MT1.5-1.8B-Q4_K_M.gguf";

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct StandardTranslateResponse {
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct StandardStatusResponse {
    pub python_ready: bool,
    pub model_ready: bool,
    pub model_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct StandardRuntimeInfoResponse {
    pub daemon_running: bool,
    pub threads: u32,
    pub gpu_layers: i32,
    pub batch: u32,
    pub ctx: u32,
    pub backend: String,
    pub cuda_available: bool,
    pub detected_cuda_version: String,
}

#[derive(Debug)]
struct PyDaemon {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    model_path: String,
    threads: u32,
    gpu_layers: i32,
    batch: u32,
    ctx: u32,
    backend: String,
    cuda_available: bool,
    detected_cuda_version: String,
}

static PY_DAEMON: OnceCell<Mutex<Option<PyDaemon>>> = OnceCell::new();

fn default_threads() -> usize {
    let n = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    // Leave some headroom for UI/runtime.
    n.saturating_sub(1).clamp(2, 12)
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app_data_dir: {}", e))
}

fn resources_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .resource_dir()
        .map_err(|e| format!("failed to resolve resource_dir: {}", e))
}

fn python_runtime_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let rd = resources_dir(app)?;
    // In `tauri dev`, resources often live under `<target>/debug/resources/*`.
    // In bundles, they are typically under the resolved resource dir root.
    let p1 = rd.join("py");
    if p1.exists() {
        return Ok(p1);
    }
    Ok(rd.join("resources").join("py"))
}

fn python_app_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let rd = resources_dir(app)?;
    let p1 = rd.join("py_app");
    if p1.exists() {
        return Ok(p1);
    }
    Ok(rd.join("resources").join("py_app"))
}

fn python_bin(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let rt = python_runtime_dir(app)?;
    #[cfg(target_os = "macos")]
    {
        let p1 = rt.join("macos").join("bin").join("python3");
        if p1.exists() {
            return Ok(p1);
        }
        let p2 = rt.join("macos").join("python").join("bin").join("python3");
        Ok(p2)
    }
    #[cfg(target_os = "linux")]
    {
        let p1 = rt.join("linux").join("bin").join("python3");
        if p1.exists() {
            return Ok(p1);
        }
        let p2 = rt.join("linux").join("python").join("bin").join("python3");
        Ok(p2)
    }
    #[cfg(windows)]
    {
        let p1 = rt.join("windows").join("python.exe");
        if p1.exists() {
            return Ok(p1);
        }
        let p2 = rt.join("windows").join("python").join("python.exe");
        Ok(p2)
    }
}

fn venv_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app_data_dir(app)?.join("py-venv"))
}

fn venv_python(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let venv = venv_dir(app)?;
    #[cfg(target_os = "macos")]
    {
        Ok(venv.join("bin").join("python"))
    }
    #[cfg(target_os = "linux")]
    {
        Ok(venv.join("bin").join("python"))
    }
    #[cfg(windows)]
    {
        Ok(venv.join("Scripts").join("python.exe"))
    }
}

async fn run_cmd(mut cmd: tokio::process::Command) -> Result<String, String> {
    let out = cmd.output().await.map_err(|e| format!("spawn failed: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        return Err(format!(
            "command failed (code={:?})\nstdout:\n{}\nstderr:\n{}",
            out.status.code(),
            stdout,
            stderr
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

async fn ensure_daemon(app: &tauri::AppHandle) -> Result<(), String> {
    let mutex = PY_DAEMON.get_or_init(|| Mutex::new(None));

    let models_dir = app_data_dir(app)?.join("models");
    let repo_dir = models_dir.join(DEFAULT_HF_REPO.replace('/', "__"));
    let model_path = repo_dir.join(DEFAULT_GGUF_FILENAME);
    let model_path_str = model_path.display().to_string();

    let mut guard = mutex.lock().await;
    if let Some(d) = guard.as_ref() {
        if d.model_path == model_path_str {
            return Ok(());
        }
    }

    // Kill old daemon if present
    if let Some(mut old) = guard.take() {
        let _ = old.child.kill().await;
    }

    let vpy = venv_python(app)?;
    let app_dir = python_app_dir(app)?;
    let server_py = app_dir.join("server.py");
    if !server_py.exists() {
        return Err(format!("missing python server entry: {}", server_py.display()));
    }
    if !model_path.exists() {
        return Err(format!("model file missing: {}", model_path.display()));
    }

    // Cross-platform performance defaults.
    // - Apple Silicon: prefer Metal offload (if llama-cpp-python wheel supports it).
    // - Intel / Windows / Linux: default to CPU, tuned threads/batch.
    let threads = default_threads() as u32;
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let gpu_layers: i32 = 999;
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    let gpu_layers: i32 = 0;
    let batch: u32 = if gpu_layers > 0 { 512 } else { 256 };
    let ctx: u32 = 2048;

    debug_println!(
        "[standard] starting python daemon (threads={} gpu_layers={} batch={} ctx={})",
        threads,
        gpu_layers,
        batch,
        ctx
    );
    let backend = llama_system_info(app).await.unwrap_or_default();
    let cuda_available = backend.to_ascii_lowercase().contains("cuda");
    let detected_cuda_version = try_detect_cuda_version().await.unwrap_or_default();

    let mut cmd = tokio::process::Command::new(&vpy);
    cmd.arg(&server_py)
        .env("STD_MODEL_PATH", &model_path_str)
        .env("STD_THREADS", threads.to_string())
        .env("STD_GPU_LAYERS", gpu_layers.to_string())
        .env("STD_BATCH", batch.to_string())
        .env("STD_CTX", ctx.to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit());

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn python daemon: {}", e))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open daemon stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to open daemon stdout".to_string())?;

    *guard = Some(PyDaemon {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        model_path: model_path_str,
        threads,
        gpu_layers,
        batch,
        ctx,
        backend,
        cuda_available,
        detected_cuda_version,
    });

    Ok(())
}

async fn daemon_translate(app: &tauri::AppHandle, prompt: &str) -> Result<String, String> {
    ensure_daemon(app).await?;
    let mutex = PY_DAEMON.get_or_init(|| Mutex::new(None));
    let mut guard = mutex.lock().await;
    let d = guard
        .as_mut()
        .ok_or_else(|| "python daemon not initialized".to_string())?;

    // Keep response bounded: use adaptive max_tokens based on prompt length.
    let max_tokens = (prompt.len() / 2).clamp(64, 256);
    let req = serde_json::json!({ "prompt": prompt, "max_tokens": max_tokens });
    let mut line = req.to_string();
    line.push('\n');
    d.stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("failed to write daemon stdin: {}", e))?;
    d.stdin
        .flush()
        .await
        .map_err(|e| format!("failed to flush daemon stdin: {}", e))?;

    let mut out_line = String::new();
    let n = d
        .stdout
        .read_line(&mut out_line)
        .await
        .map_err(|e| format!("failed to read daemon stdout: {}", e))?;
    if n == 0 {
        return Err("python daemon exited unexpectedly".to_string());
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&out_line).map_err(|e| format!("invalid daemon output: {} raw={}", e, out_line))?;
    if parsed.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        return Ok(parsed
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string());
    }
    Err(parsed
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("daemon error")
        .to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn ensure_python_runtime() -> Result<(), String> {
    let app = APP_HANDLE
        .get()
        .ok_or_else(|| "APP_HANDLE not initialized".to_string())?
        .clone();
    let py = python_bin(&app)?;
    if !py.exists() {
        return Err(format!(
            "embedded python not found at {} (you need to bundle it under src-tauri/resources/py/...)",
            py.display()
        ));
    }

    let venv_py = venv_python(&app)?;
    if venv_py.exists() {
        debug_println!("[standard] venv ok: {}", venv_py.display());
        return Ok(());
    }

    let venv = venv_dir(&app)?;
    debug_println!("[standard] creating venv at {}", venv.display());
    tokio::fs::create_dir_all(&venv)
        .await
        .map_err(|e| format!("failed to create venv dir: {}", e))?;

    // Create venv: python -m venv <dir>
    let mut cmd = tokio::process::Command::new(py);
    cmd.arg("-m").arg("venv").arg(&venv);
    run_cmd(cmd).await?;

    // Upgrade pip and install requirements (online for now; we will document offline wheels later)
    let vpy = venv_python(&app)?;
    debug_println!("[standard] installing python deps via pip");

    let req_file = python_app_dir(&app)?.join("requirements.txt");
    if !req_file.exists() {
        return Err(format!("missing requirements at {}", req_file.display()));
    }

    let mut pip_cmd = tokio::process::Command::new(&vpy);
    pip_cmd
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--upgrade")
        .arg("pip");
    let _ = run_cmd(pip_cmd).await?;

    let mut install_cmd = tokio::process::Command::new(&vpy);
    install_cmd
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("-r")
        .arg(&req_file);
    let _ = run_cmd(install_cmd).await?;

    // Optional CUDA wheel (Windows/Linux): if NVIDIA is present, try to install a CUDA-enabled wheel.
    #[cfg(any(windows, target_os = "linux"))]
    {
        if let Some(cuda_ver) = try_detect_cuda_version().await {
            if let Some(extra) = cuda_extra_index_url(&cuda_ver) {
                debug_println!(
                    "[standard] detected CUDA {} -> trying llama-cpp-python CUDA wheel (extra-index-url={})",
                    cuda_ver,
                    extra
                );
                let mut cuda_cmd = tokio::process::Command::new(&vpy);
                cuda_cmd
                    .arg("-m")
                    .arg("pip")
                    .arg("install")
                    .arg("--upgrade")
                    .arg("--force-reinstall")
                    .arg("llama-cpp-python")
                    .arg("--extra-index-url")
                    .arg(extra);
                let _ = run_cmd(cuda_cmd).await;
            } else {
                debug_println!(
                    "[standard] detected CUDA {}, but no mapped llama-cpp-python wheel index",
                    cuda_ver
                );
            }
        }
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn ensure_model() -> Result<(), String> {
    let app = APP_HANDLE
        .get()
        .ok_or_else(|| "APP_HANDLE not initialized".to_string())?
        .clone();
    ensure_python_runtime().await?;
    ensure_model_downloaded(&app, DEFAULT_HF_REPO).await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn standard_translate(prompt: String) -> Result<StandardTranslateResponse, String> {
    let app = APP_HANDLE
        .get()
        .ok_or_else(|| "APP_HANDLE not initialized".to_string())?
        .clone();
    ensure_model().await?;
    debug_println!("[standard] translate prompt_len={}", prompt.len());
    let text = daemon_translate(&app, &prompt).await?;
    Ok(StandardTranslateResponse { text })
}

#[tauri::command]
#[specta::specta]
pub async fn standard_status() -> Result<StandardStatusResponse, String> {
    let app = APP_HANDLE
        .get()
        .ok_or_else(|| "APP_HANDLE not initialized".to_string())?
        .clone();

    let python_ready = venv_python(&app)?.exists();
    let repo_dir = app_data_dir(&app)?
        .join("models")
        .join(DEFAULT_HF_REPO.replace('/', "__"));
    let model_path = repo_dir.join(DEFAULT_GGUF_FILENAME);
    let model_ready = model_path.exists() || repo_dir.join(".downloaded").exists();

    Ok(StandardStatusResponse {
        python_ready,
        model_ready,
        model_path: model_path.display().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn standard_runtime_info() -> Result<StandardRuntimeInfoResponse, String> {
    let mutex = PY_DAEMON.get_or_init(|| Mutex::new(None));
    let guard = mutex.lock().await;

    if let Some(d) = guard.as_ref() {
        let running = d.child.id().is_some();
        return Ok(StandardRuntimeInfoResponse {
            daemon_running: running,
            threads: d.threads,
            gpu_layers: d.gpu_layers,
            batch: d.batch,
            ctx: d.ctx,
            backend: d.backend.clone(),
            cuda_available: d.cuda_available,
            detected_cuda_version: d.detected_cuda_version.clone(),
        });
    }

    Ok(StandardRuntimeInfoResponse {
        daemon_running: false,
        threads: 0,
        gpu_layers: 0,
        batch: 0,
        ctx: 0,
        backend: "".to_string(),
        cuda_available: false,
        detected_cuda_version: "".to_string(),
    })
}

