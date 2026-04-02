use debug_print::debug_println;
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct HfDownloadResponse {
    ok: bool,
    // optional diagnostic
    message: Option<String>,
    path: Option<String>,
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
    cmd.arg(&main_py)
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
    if !out.status.success() {
        return Err(format!(
            "model download failed (code={:?})\nstdout:\n{}\nstderr:\n{}",
            out.status.code(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let parsed: HfDownloadResponse =
        serde_json::from_str(&stdout).map_err(|e| format!("failed to parse download output: {}\nraw:\n{}", e, stdout))?;
    if !parsed.ok {
        return Err(parsed
            .message
            .unwrap_or_else(|| "model download failed".to_string()));
    }
    if let Some(_p) = parsed.path.as_deref() {
        debug_println!("[standard] model file saved at {}", _p);
    }

    tokio::fs::write(&marker, "ok")
        .await
        .map_err(|e| format!("failed to write marker: {}", e))?;

    Ok(())
}

