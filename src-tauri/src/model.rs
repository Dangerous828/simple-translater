use debug_print::debug_println;
use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri::Manager;

/// Match `standard_status` heuristic: partial GGUF must not count as ready.
const MIN_GGUF_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Clone, Serialize)]
struct ModelDownloadProgressPayload {
    received: u64,
    total: Option<u64>,
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app_data_dir: {}", e))
}

/// App 设置优先，其次系统环境变量 `HF_ENDPOINT`，最后官方域名。
fn resolve_hf_base(user_override: Option<&str>) -> String {
    if let Some(s) = user_override {
        let t = s.trim().trim_end_matches('/').to_string();
        if !t.is_empty() {
            return t;
        }
    }
    std::env::var("HF_ENDPOINT")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://huggingface.co".to_string())
}

fn hf_resolve_file_url(base: &str, repo: &str, revision: &str, filename: &str) -> String {
    format!("{}/{}/resolve/{}/{}", base, repo, revision, filename)
}

async fn gguf_file_ready(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .map(|m| m.is_file() && m.len() >= MIN_GGUF_BYTES)
        .unwrap_or(false)
}

/// Stream download from Hugging Face `resolve` URL (follows LFS redirects). No Python subprocess.
async fn download_url_to_file(
    app: &tauri::AppHandle,
    url: &str,
    dest: &Path,
    hf_base_for_hint: &str,
) -> Result<u64, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(60))
        .user_agent(concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"), " (standard-mode)"))
        .redirect(reqwest::redirect::Policy::limited(48))
        .build()
        .map_err(|e| format!("http client: {}", e))?;

    let mut req = client.get(url);
    if let Ok(token) = std::env::var("HUGGING_FACE_HUB_TOKEN") {
        let t = token.trim();
        if !t.is_empty() {
            req = req.header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {}", t),
            );
        }
    }

    let res = req.send().await.map_err(|e| format!("request failed: {}", e))?;
    let status = res.status();
    if !status.is_success() {
        let hint = if status == 401 || status == 403 {
            "（若仓库需登录，请设置环境变量 HUGGING_FACE_HUB_TOKEN）"
        } else if hf_base_for_hint.contains("huggingface.co") {
            "（可在设置中填写 Hugging Face 镜像地址，例如 https://hf-mirror.com）"
        } else {
            ""
        };
        let body_prefix = res
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect::<String>();
        return Err(format!(
            "HTTP {} {}{}\n{}",
            status.as_u16(),
            status.canonical_reason().unwrap_or(""),
            hint,
            body_prefix
        ));
    }

    let total_hint = res.content_length();
    let mut stream = res.bytes_stream();
    let mut part_os = dest.as_os_str().to_os_string();
    part_os.push(".part");
    let part_path = PathBuf::from(part_os);
    if let Some(parent) = part_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("create_dir: {}", e))?;
    }
    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| format!("create part file: {}", e))?;

    let mut received: u64 = 0;
    let mut last_emit = Instant::now();
    let mut since_emit: u64 = 0;
    const EMIT_INTERVAL: Duration = Duration::from_millis(300);
    const EMIT_MIN_BYTES: u64 = 512 * 1024;

    let emit = |received: u64, total: Option<u64>| {
        let _ = app.emit(
            "standard-model-download-progress",
            ModelDownloadProgressPayload { received, total },
        );
    };

    emit(0, total_hint);

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download stream: {}", e))?;
        let n = chunk.len() as u64;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| format!("write file: {}", e))?;
        received = received.saturating_add(n);
        since_emit = since_emit.saturating_add(n);
        if last_emit.elapsed() >= EMIT_INTERVAL || since_emit >= EMIT_MIN_BYTES {
            emit(received, total_hint);
            last_emit = Instant::now();
            since_emit = 0;
        }
    }

    emit(received, Some(received));
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|e| format!("flush: {}", e))?;
    drop(file);

    tokio::fs::rename(&part_path, dest)
        .await
        .map_err(|e| format!("rename part -> final: {}", e))?;

    Ok(received)
}

pub async fn ensure_model_downloaded(
    app: &tauri::AppHandle,
    repo: &str,
    hf_endpoint_override: Option<&str>,
) -> Result<(), String> {
    let models_root = app_data_dir(app)?.join("models");
    tokio::fs::create_dir_all(&models_root)
        .await
        .map_err(|e| format!("failed to create models dir: {}", e))?;

    let repo_dir = models_root.join(repo.replace('/', "__"));
    let marker = repo_dir.join(".downloaded");
    if marker.exists() {
        debug_println!("[standard] model marker exists: {}", marker.display());
        return Ok(());
    }

    tokio::fs::create_dir_all(&repo_dir)
        .await
        .map_err(|e| format!("failed to create repo dir: {}", e))?;

    let filename = "HY-MT1.5-1.8B-Q4_K_M.gguf";
    let revision = "main";
    let hf_base = resolve_hf_base(hf_endpoint_override);
    let url = hf_resolve_file_url(&hf_base, repo, revision, filename);
    let dest = repo_dir.join(filename);

    debug_println!(
        "[standard] downloading model (native) repo={} file={} base={} url={} ...",
        repo,
        filename,
        hf_base,
        url
    );

    let bytes = match download_url_to_file(app, &url, &dest, &hf_base).await {
        Ok(b) => b,
        Err(e) => {
            let mut part_os = dest.as_os_str().to_os_string();
            part_os.push(".part");
            let _ = tokio::fs::remove_file(PathBuf::from(part_os)).await;
            return Err(e);
        }
    };

    if !gguf_file_ready(&dest).await {
        let _ = tokio::fs::remove_file(&dest).await;
        return Err(format!(
            "downloaded file missing or smaller than {} MiB (got {} bytes)",
            MIN_GGUF_BYTES / (1024 * 1024),
            bytes
        ));
    }

    debug_println!(
        "[standard] model download finished OK ({} bytes) -> {}",
        bytes,
        dest.display()
    );

    tokio::fs::write(&marker, "ok")
        .await
        .map_err(|e| format!("failed to write marker: {}", e))?;

    Ok(())
}
