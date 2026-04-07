use debug_print::debug_println;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct HfDownloadResponse {
    ok: bool,
    // optional diagnostic
    message: Option<String>,
    path: Option<String>,
}

/// Written by `download_model.py` so Rust does not rely on a pristine stdout (hub may log).
const HF_DOWNLOAD_RESULT_JSON: &str = ".hf_download_result.json";
/// Match `standard_status` heuristic: partial GGUF must not count as ready.
const MIN_GGUF_BYTES: u64 = 100 * 1024 * 1024;

async fn read_hf_download_response(repo_dir: &Path, stdout: &[u8]) -> Result<HfDownloadResponse, String> {
    let file = repo_dir.join(HF_DOWNLOAD_RESULT_JSON);
    if let Ok(text) = tokio::fs::read_to_string(&file).await {
        if let Ok(v) = serde_json::from_str::<HfDownloadResponse>(&text) {
            return Ok(v);
        }
    }
    parse_hf_response_from_stdout(stdout)
}

fn parse_hf_response_from_stdout(stdout: &[u8]) -> Result<HfDownloadResponse, String> {
    let s = String::from_utf8_lossy(stdout).to_string();
    let trimmed = s.trim();
    if let Ok(v) = serde_json::from_str::<HfDownloadResponse>(trimmed) {
        return Ok(v);
    }
    for line in s.lines().rev() {
        let line = line.trim();
        if line.starts_with('{') && line.ends_with('}') {
            if let Ok(v) = serde_json::from_str::<HfDownloadResponse>(line) {
                return Ok(v);
            }
        }
    }
    Err(format!(
        "failed to parse download output (expected JSON); raw stdout:\n{}",
        s
    ))
}

async fn gguf_ready(repo_dir: &Path, filename: &str, parsed: &HfDownloadResponse) -> bool {
    let candidates = [
        parsed.path.as_ref().map(PathBuf::from),
        Some(repo_dir.join(filename)),
    ];
    for p in candidates.into_iter().flatten() {
        if let Ok(meta) = tokio::fs::metadata(&p).await {
            if meta.is_file() && meta.len() >= MIN_GGUF_BYTES {
                return true;
            }
        }
    }
    false
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app_data_dir: {}", e))
}

fn resource_file(app: &tauri::AppHandle, rel: &str) -> Result<std::path::PathBuf, String> {
    let rd = app
        .path()
        .resource_dir()
        .map_err(|e| format!("failed to resolve resource_dir: {}", e))?;
    let p1 = rd.join(rel);
    if p1.exists() {
        return Ok(p1);
    }
    let p2 = rd.join("resources").join(rel);
    if p2.exists() {
        return Ok(p2);
    }
    #[cfg(debug_assertions)]
    {
        let p3 = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(rel);
        if p3.exists() {
            return Ok(p3);
        }
    }
    Ok(p2)
}

pub async fn ensure_model_downloaded(app: &tauri::AppHandle, repo: &str) -> Result<(), String> {
    let models_root = app_data_dir(app)?.join("models");
    tokio::fs::create_dir_all(&models_root)
        .await
        .map_err(|e| format!("failed to create models dir: {}", e))?;

    // Marker dir for repo
    let repo_dir = models_root.join(repo.replace('/', "__"));
    let marker = repo_dir.join(".downloaded");
    if marker.exists() {
        debug_println!("[standard] model marker exists: {}", marker.display());
        return Ok(());
    }

    tokio::fs::create_dir_all(&repo_dir)
        .await
        .map_err(|e| format!("failed to create repo dir: {}", e))?;

    // Download via the python venv (huggingface_hub snapshot_download).
    // We keep the logic in Python to avoid re-implementing HF auth/resume.
    let venv_py = {
        let venv = app_data_dir(app)?.join("py-venv");
        #[cfg(target_os = "macos")]
        {
            venv.join("bin").join("python")
        }
        #[cfg(target_os = "linux")]
        {
            venv.join("bin").join("python")
        }
        #[cfg(windows)]
        {
            venv.join("Scripts").join("python.exe")
        }
    };
    if !venv_py.exists() {
        return Err(format!("python venv missing: {}", venv_py.display()));
    }

    let main_py = resource_file(app, "py_app/download_model.py")?;

    if !main_py.exists() {
        return Err(format!("missing download script: {}", main_py.display()));
    }

    // We download a single GGUF file to keep footprint small.
    // Current default: HY-MT1.5-1.8B-Q4_K_M.gguf
    let filename = "HY-MT1.5-1.8B-Q4_K_M.gguf";
    debug_println!(
        "[standard] downloading model repo={} file={} ...",
        repo,
        filename
    );
    let mut cmd = tokio::process::Command::new(&venv_py);
    cmd.env("PYTHONDONTWRITEBYTECODE", "1");
    // Progress bars and hub logs write to stderr; piping stderr fills the OS buffer (~64KiB) and
    // blocks the child — download appears to hang forever with no terminal output.
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .arg(&main_py)
        .arg("--repo")
        .arg(repo)
        .arg("--out-dir")
        .arg(&repo_dir)
        .arg("--filename")
        .arg(filename);

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("spawn failed: {}", e))?;

    let parsed = read_hf_download_response(&repo_dir, &out.stdout).await;

    if !out.status.success() {
        let from_py = match &parsed {
            Ok(p) if !p.ok => p.message.clone(),
            _ => None,
        };
        return Err(from_py.unwrap_or_else(|| {
            format!(
                "model download failed (code={:?})\nstdout:\n{}\n(if stderr was inherited, see terminal above)",
                out.status.code(),
                String::from_utf8_lossy(&out.stdout)
            )
        }));
    }

    let parsed = parsed.map_err(|e| {
        format!(
            "{} (exit code was success but result could not be read; check {})",
            e,
            repo_dir.join(HF_DOWNLOAD_RESULT_JSON).display()
        )
    })?;
    if !parsed.ok {
        return Err(parsed
            .message
            .unwrap_or_else(|| "model download failed".to_string()));
    }
    if !gguf_ready(&repo_dir, filename, &parsed).await {
        return Err(format!(
            "download reported success but GGUF is missing or smaller than {} MiB (partial download?). \
             expected near {} or path from hub: {:?}",
            MIN_GGUF_BYTES / (1024 * 1024),
            repo_dir.join(filename).display(),
            parsed.path
        ));
    }
    if let Some(_p) = parsed.path.as_deref() {
        debug_println!("[standard] model file saved at {}", _p);
    }
    debug_println!("[standard] model download finished OK");

    tokio::fs::write(&marker, "ok")
        .await
        .map_err(|e| format!("failed to write marker: {}", e))?;

    Ok(())
}

