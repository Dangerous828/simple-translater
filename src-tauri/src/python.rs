use debug_print::debug_println;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::model::ensure_model_downloaded;
use crate::APP_HANDLE;

use once_cell::sync::OnceCell;
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

fn hf_endpoint_arg(hf_endpoint: &Option<String>) -> Option<&str> {
    hf_endpoint.as_ref().and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    })
}

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

/// Run embedded or venv Python without writing `.pyc` next to the bundled stdlib under
/// `resources/py`. Otherwise `tauri dev`’s watcher sees `__pycache__` changes and rebuilds in a loop,
/// interrupting venv setup / model download.
fn python_cmd(program: &std::path::Path) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(program);
    c.env("PYTHONDONTWRITEBYTECODE", "1");
    // Force UTF-8 mode on Windows to avoid codec issues with piped stdin/stdout.
    c.env("PYTHONUTF8", "1");
    c
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

/// Prebuilt CUDA wheels (jllllll index). Newer driver reports (e.g. 12.6) fall back to the newest
/// CUDA tag published here (`cu122`), since pip cannot use a non-existent index.
#[cfg(any(windows, target_os = "linux"))]
fn cuda_extra_index_url(version: &str) -> Option<&'static str> {
    if version.starts_with("11.6") {
        return Some("https://jllllll.github.io/llama-cpp-python-cuBLAS-wheels/AVX2/cu116");
    }
    if version.starts_with("11.7") {
        return Some("https://jllllll.github.io/llama-cpp-python-cuBLAS-wheels/AVX2/cu117");
    }
    if version.starts_with("11.8") {
        return Some("https://jllllll.github.io/llama-cpp-python-cuBLAS-wheels/AVX2/cu118");
    }
    if version.starts_with("12.0") {
        return Some("https://jllllll.github.io/llama-cpp-python-cuBLAS-wheels/AVX2/cu120");
    }
    if version.starts_with("12.1") {
        return Some("https://jllllll.github.io/llama-cpp-python-cuBLAS-wheels/AVX2/cu121");
    }
    if version.starts_with("12.2") || version.starts_with("12.3") || version.starts_with("12.4")
        || version.starts_with("12.5") || version.starts_with("12.6") || version.starts_with("12.7")
        || version.starts_with("12.8")
    {
        return Some("https://jllllll.github.io/llama-cpp-python-cuBLAS-wheels/AVX2/cu122");
    }
    None
}

async fn llama_system_info(app: &tauri::AppHandle) -> Result<String, String> {
    let vpy = venv_python(app)?;
    let mut cmd = python_cmd(&vpy);
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
    stderr_buf: std::sync::Arc<tokio::sync::Mutex<String>>,
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

/// Resolve `src-tauri/resources/<name>` (e.g. `py`, `py_app`) for bundled files.
/// Order: Tauri `resource_dir()/name`, then `resource_dir()/resources/name` (some layouts),
/// then in **debug builds only** `CARGO_MANIFEST_DIR/resources/name` so `tauri dev` works
/// when the CLI has not copied large bundles into `target/debug/resources`.
fn bundled_resources_subdir(app: &tauri::AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let rd = resources_dir(app)?;
    let a = rd.join(name);
    if a.exists() {
        return Ok(a);
    }
    let b = rd.join("resources").join(name);
    if b.exists() {
        return Ok(b);
    }
    #[cfg(debug_assertions)]
    {
        let c = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(name);
        if c.exists() {
            debug_println!(
                "[standard] dev resource fallback for {:?}: {}",
                name,
                c.display()
            );
            return Ok(c);
        }
    }
    Err(format!(
        "bundle directory {:?} not found under {} (debug fallback: src-tauri/resources/{})",
        name,
        rd.display(),
        name
    ))
}

fn python_runtime_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    bundled_resources_subdir(app, "py")
}

fn python_app_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    bundled_resources_subdir(app, "py_app")
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
        let candidates = [
            rt.join("windows").join("python.exe"),
            rt.join("windows").join("python").join("python.exe"),
            rt.join("windows").join("install").join("python.exe"),
        ];
        for p in &candidates {
            if p.exists() {
                return Ok(p.clone());
            }
        }
        Err(format!(
            "embedded python not found under {}.\n\
             Tried:\n  - {}\n  - {}\n  - {}\n\
             From the repository root run: pnpm setup-python-runtime\n\
             Then restart dev (pnpm dev-tauri). Ensure src-tauri/resources/py/windows contains python.exe.",
            rt.display(),
            candidates[0].display(),
            candidates[1].display(),
            candidates[2].display(),
        ))
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

/// Long-running installs: stream stdout/stderr to the parent process (visible in the terminal
/// where `tauri dev` / the app was started). The UI invoke has no live log otherwise.
async fn run_cmd_inherit_stdio(mut cmd: tokio::process::Command) -> Result<(), String> {
    use std::process::Stdio;
    cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    let status = cmd
        .status()
        .await
        .map_err(|e| format!("spawn failed: {}", e))?;
    if !status.success() {
        return Err(format!(
            "command failed (code={:?}) — see terminal output above",
            status.code()
        ));
    }
    Ok(())
}

/// True if the venv already has packages required for Standard mode (download + inference).
/// Also checks that llama-cpp-python is recent enough to handle modern GGUF files.
async fn venv_standard_deps_ok(vpy: &std::path::Path) -> bool {
    let mut cmd = python_cmd(vpy);
    cmd.arg("-c").arg(
        "import llama_cpp; v = llama_cpp.__version__; parts = v.split('.'); \
         ok = int(parts[0]) > 0 or int(parts[1]) >= 3; \
         exit(0 if ok else 1)"
    );
    match cmd.output().await {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

/// Embedded / stripped CPython venvs often ship without `pip`; `ensurepip` may fix it,
/// otherwise we run `bootstrap_pip.py` (downloads get-pip.py; needs network).
async fn ensure_venv_has_pip(app: &tauri::AppHandle, vpy: &std::path::Path) -> Result<(), String> {
    let mut probe = python_cmd(vpy);
    probe.args(["-m", "pip", "--version"]);
    let out = probe
        .output()
        .await
        .map_err(|e| format!("failed to run venv python: {}", e))?;
    if out.status.success() {
        return Ok(());
    }

    debug_println!("[standard] venv has no pip; trying ensurepip");
    let mut ens = python_cmd(vpy);
    ens.args(["-m", "ensurepip", "--upgrade", "--default-pip"]);
    let ens_out = ens
        .output()
        .await
        .map_err(|e| format!("ensurepip spawn failed: {}", e))?;
    if !ens_out.status.success() {
        debug_println!(
            "[standard] ensurepip exit={:?} stderr={}",
            ens_out.status.code(),
            String::from_utf8_lossy(&ens_out.stderr).trim()
        );
    }

    let mut probe2 = python_cmd(vpy);
    probe2.args(["-m", "pip", "--version"]);
    let out2 = probe2
        .output()
        .await
        .map_err(|e| format!("pip probe after ensurepip: {}", e))?;
    if out2.status.success() {
        return Ok(());
    }

    let script = python_app_dir(app)?.join("bootstrap_pip.py");
    if !script.exists() {
        return Err(
            "venv has no pip and ensurepip did not help; missing resources/py_app/bootstrap_pip.py"
                .to_string(),
        );
    }

    debug_println!("[standard] running bootstrap_pip.py (downloads get-pip.py; requires network)");
    let mut boot = python_cmd(vpy);
    boot.arg(&script);
    run_cmd_inherit_stdio(boot).await?;

    let mut probe3 = python_cmd(vpy);
    probe3.args(["-m", "pip", "--version"]);
    let out3 = probe3
        .output()
        .await
        .map_err(|e| format!("pip probe after bootstrap: {}", e))?;
    if !out3.status.success() {
        return Err(
            "pip is still unavailable. Delete the app data Python venv folder (see Settings / logs path) and retry on a network that can reach bootstrap.pypa.io."
                .to_string(),
        );
    }
    Ok(())
}

/// Install `llama-cpp-python` from prebuilt wheels only (PyPI sdist needs CMake + llama.cpp build).
/// `package_req` is a pip requirement (e.g. `llama-cpp-python==0.2.26`). Pin the version so pip does
/// not prefer a newer PyPI sdist over third-party wheels.
#[cfg(any(windows, target_os = "linux"))]
async fn install_llama_cpp_via_wheels(
    vpy: &std::path::Path,
    package_req: &str,
    extra_index_url: &str,
) -> Result<(), String> {
    debug_println!(
        "[standard] installing {} (prefer binary wheels, extra-index-url={})",
        package_req,
        extra_index_url
    );
    let mut cmd = python_cmd(vpy);
    cmd.arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--upgrade")
        .arg("--prefer-binary")
        .arg(package_req)
        .arg("--extra-index-url")
        .arg(extra_index_url);
    run_cmd_inherit_stdio(cmd).await
}

/// macOS: abetlen’s GitHub Pages wheel index is gone; jllllll publishes Metal wheels as release assets.
async fn install_llama_cpp_macos_from_release_wheel(vpy: &std::path::Path, wheel_url: &str) -> Result<(), String> {
    debug_println!(
        "[standard] installing llama-cpp-python from prebuilt wheel ({})",
        wheel_url
    );
    let mut cmd = python_cmd(vpy);
    cmd.arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--upgrade")
        .arg("--prefer-binary")
        .arg(wheel_url);
    run_cmd_inherit_stdio(cmd).await
}

async fn install_venv_pip_dependencies(app: &tauri::AppHandle, vpy: &std::path::Path) -> Result<(), String> {
    ensure_venv_has_pip(app, vpy).await?;

    let req_file = python_app_dir(app)?.join("requirements.txt");
    if !req_file.exists() {
        return Err(format!("missing requirements at {}", req_file.display()));
    }

    debug_println!("[standard] pip install / upgrade (requirements.txt) — logging to terminal");

    let mut pip_cmd = python_cmd(vpy);
    pip_cmd
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--upgrade")
        .arg("pip");
    run_cmd_inherit_stdio(pip_cmd).await?;

    let mut install_cmd = python_cmd(vpy);
    install_cmd
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--prefer-binary")
        .arg("-r")
        .arg(&req_file);
    run_cmd_inherit_stdio(install_cmd).await?;

    #[cfg(any(windows, target_os = "linux"))]
    {
        let mut llama_ok = false;
        if let Some(cuda_ver) = try_detect_cuda_version().await {
            if let Some(extra) = cuda_extra_index_url(&cuda_ver) {
                debug_println!(
                    "[standard] detected CUDA {} -> trying llama-cpp-python CUDA wheel (extra-index-url={})",
                    cuda_ver,
                    extra
                );
                let mut cuda_cmd = python_cmd(vpy);
                cuda_cmd
                    .arg("-m")
                    .arg("pip")
                    .arg("install")
                    .arg("--upgrade")
                    .arg("--prefer-binary")
                    .arg("--force-reinstall")
                    .arg("llama-cpp-python")
                    .arg("--extra-index-url")
                    .arg(extra);
                match run_cmd_inherit_stdio(cuda_cmd).await {
                    Ok(()) => llama_ok = true,
                    Err(e) => {
                        debug_println!(
                            "[standard] CUDA llama-cpp-python install failed (will try PyPI): {}",
                            e
                        );
                    }
                }
            } else {
                debug_println!(
                    "[standard] detected CUDA {}, but no mapped llama-cpp-python wheel index",
                    cuda_ver
                );
            }
        }
        if !llama_ok {
            // Install from abetlen's prebuilt CPU wheel index — PyPI only has sdist which needs CMake.
            debug_println!("[standard] installing llama-cpp-python from prebuilt CPU wheel index");
            let mut pypi_cmd = python_cmd(vpy);
            pypi_cmd
                .arg("-m")
                .arg("pip")
                .arg("install")
                .arg("--upgrade")
                .arg("--prefer-binary")
                .arg("llama-cpp-python")
                .arg("--extra-index-url")
                .arg("https://abetlen.github.io/llama-cpp-python/whl/cpu");
            run_cmd_inherit_stdio(pypi_cmd).await?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        // abetlen publishes Metal-enabled wheels for macOS on the same index.
        debug_println!("[standard] installing llama-cpp-python from prebuilt wheel index (macOS)");
        let mut pypi_cmd = python_cmd(vpy);
        pypi_cmd
            .arg("-m")
            .arg("pip")
            .arg("install")
            .arg("--upgrade")
            .arg("--prefer-binary")
            .arg("llama-cpp-python")
            .arg("--extra-index-url")
            .arg("https://abetlen.github.io/llama-cpp-python/whl/metal");
        run_cmd_inherit_stdio(pypi_cmd).await?;
    }

    Ok(())
}

async fn ensure_daemon(app: &tauri::AppHandle) -> Result<(), String> {
    let mutex = PY_DAEMON.get_or_init(|| Mutex::new(None));

    let models_dir = app_data_dir(app)?.join("models");
    let repo_dir = models_dir.join(DEFAULT_HF_REPO.replace('/', "__"));
    let model_path = repo_dir.join(DEFAULT_GGUF_FILENAME);
    // On Windows, canonicalize may produce \\?\ extended-length paths.
    // Use display() but strip the prefix so Python / llama.cpp get a normal path.
    let model_path_str = {
        let s = model_path.display().to_string();
        if s.starts_with("\\\\?\\") {
            s[4..].to_string()
        } else {
            s
        }
    };

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

    let mut cmd = python_cmd(&vpy);
    cmd.arg(&server_py)
        .env("STD_MODEL_PATH", &model_path_str)
        .env("STD_THREADS", threads.to_string())
        .env("STD_GPU_LAYERS", gpu_layers.to_string())
        .env("STD_BATCH", batch.to_string())
        .env("STD_CTX", ctx.to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn python daemon: {}", e))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open daemon stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to open daemon stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to open daemon stderr".to_string())?;

    // Spawn a background task to collect stderr so we can surface errors to the user.
    let stderr_buf: std::sync::Arc<tokio::sync::Mutex<String>> =
        std::sync::Arc::new(tokio::sync::Mutex::new(String::new()));
    {
        let buf = stderr_buf.clone();
        let mut reader = BufReader::new(stderr);
        tokio::spawn(async move {
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => {
                        eprint!("[py-daemon] {}", line);
                        let mut b = buf.lock().await;
                        // Keep last 2KB of stderr for error reporting
                        if b.len() > 2048 {
                            let drain = b.len() - 1024;
                            b.drain(..drain);
                        }
                        b.push_str(&line);
                    }
                    Err(_) => break,
                }
            }
        });
    }

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
        stderr_buf: stderr_buf,
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
        // Daemon exited — collect stderr for a useful error message
        // Give stderr reader a moment to flush
        tokio::time::sleep(Duration::from_millis(200)).await;
        let stderr_content = d.stderr_buf.lock().await.clone();
        let detail = if stderr_content.trim().is_empty() {
            String::new()
        } else {
            format!("\n\nPython stderr:\n{}", stderr_content.trim())
        };
        // Clear the dead daemon so next call will try to restart
        *guard = None;
        return Err(format!("python daemon exited unexpectedly{}", detail));
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

    let venv = venv_dir(&app)?;
    let vpy = venv_python(&app)?;

    if !vpy.exists() {
        debug_println!("[standard] creating venv at {}", venv.display());
        tokio::fs::create_dir_all(&venv)
            .await
            .map_err(|e| format!("failed to create venv dir: {}", e))?;

        let mut cmd = python_cmd(&py);
        cmd.arg("-m").arg("venv").arg(&venv);
        run_cmd_inherit_stdio(cmd).await?;
    } else {
        debug_println!("[standard] venv exists: {}", vpy.display());
    }

    let vpy = venv_python(&app)?;
    if venv_standard_deps_ok(&vpy).await {
        debug_println!("[standard] venv dependencies ok (llama_cpp)");
        return Ok(());
    }

    debug_println!("[standard] venv missing or incomplete deps; running pip install -r");
    install_venv_pip_dependencies(&app, &vpy).await?;

    if !venv_standard_deps_ok(&vpy).await {
        return Err(
            "pip install finished but Standard mode deps are still not importable (llama_cpp). \
             Check network, disk space, and pip errors above."
                .to_string(),
        );
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn ensure_model(hf_endpoint: Option<String>) -> Result<(), String> {
    let app = APP_HANDLE
        .get()
        .ok_or_else(|| "APP_HANDLE not initialized".to_string())?
        .clone();
    ensure_python_runtime().await?;
    ensure_model_downloaded(&app, DEFAULT_HF_REPO, hf_endpoint_arg(&hf_endpoint)).await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn standard_translate(
    prompt: String,
    hf_endpoint: Option<String>,
) -> Result<StandardTranslateResponse, String> {
    let app = APP_HANDLE
        .get()
        .ok_or_else(|| "APP_HANDLE not initialized".to_string())?
        .clone();
    ensure_python_runtime().await?;
    ensure_model_downloaded(&app, DEFAULT_HF_REPO, hf_endpoint_arg(&hf_endpoint)).await?;
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
    let marker = repo_dir.join(".downloaded");
    // Do not treat a tiny/partial file as ready (dev rebuilds used to interrupt HF download).
    const MIN_GGUF_BYTES: u64 = 100 * 1024 * 1024;
    let model_ready = if marker.exists() {
        true
    } else if model_path.exists() {
        tokio::fs::metadata(&model_path)
            .await
            .map(|m| m.len() >= MIN_GGUF_BYTES)
            .unwrap_or(false)
    } else {
        false
    };

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

