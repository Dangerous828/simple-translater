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

#[derive(Clone, Serialize)]
struct ModelDownloadLogPayload {
    message: String,
}

/// Emit a human-readable log line to the frontend so the Settings UI can show it.
fn emit_download_log(app: &tauri::AppHandle, msg: &str) {
    debug_println!("[model] {}", msg);
    let _ = app.emit(
        "standard-model-download-log",
        ModelDownloadLogPayload {
            message: msg.to_string(),
        },
    );
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1_073_741_824 {
        format!("{:.2} GB", bytes as f64 / 1_073_741_824.0)
    } else if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
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
    emit_download_log(app, &format!("正在连接 {} …", url));

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(60))
        .user_agent(concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"), " (standard-mode)"))
        .redirect(reqwest::redirect::Policy::limited(48))
        .build()
        .map_err(|e| {
            let msg = format!("http client 创建失败: {}", e);
            emit_download_log(app, &msg);
            msg
        })?;

    let mut req = client.get(url);
    if let Ok(token) = std::env::var("HUGGING_FACE_HUB_TOKEN") {
        let t = token.trim();
        if !t.is_empty() {
            emit_download_log(app, "检测到 HUGGING_FACE_HUB_TOKEN，已附加认证头");
            req = req.header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {}", t),
            );
        }
    }

    emit_download_log(app, "正在发送请求（等待服务器响应）…");
    let connect_start = Instant::now();
    let res = req.send().await.map_err(|e| {
        let elapsed = connect_start.elapsed();
        let msg = if e.is_timeout() {
            format!(
                "连接超时（已等待 {:.1}s）。huggingface.co 可能无法访问，请在设置中填入镜像地址（如 https://hf-mirror.com）",
                elapsed.as_secs_f64()
            )
        } else if e.is_connect() {
            format!(
                "连接失败（{:.1}s）: {}。请检查网络或使用镜像地址",
                elapsed.as_secs_f64(),
                e
            )
        } else {
            format!("请求失败（{:.1}s）: {}", elapsed.as_secs_f64(), e)
        };
        emit_download_log(app, &msg);
        msg
    })?;

    let connect_elapsed = connect_start.elapsed();
    emit_download_log(
        app,
        &format!(
            "服务器已响应（{:.1}s），HTTP {}",
            connect_elapsed.as_secs_f64(),
            res.status().as_u16()
        ),
    );

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
        let msg = format!(
            "HTTP {} {}{}  {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or(""),
            hint,
            body_prefix
        );
        emit_download_log(app, &msg);
        return Err(msg);
    }

    let total_hint = res.content_length();
    if let Some(total) = total_hint {
        emit_download_log(app, &format!("文件大小: {}，开始下载…", format_bytes(total)));
    } else {
        emit_download_log(app, "文件大小未知，开始下载…");
    }

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
    let download_start = Instant::now();
    let mut last_log = Instant::now();
    const EMIT_INTERVAL: Duration = Duration::from_millis(300);
    const EMIT_MIN_BYTES: u64 = 512 * 1024;
    const LOG_INTERVAL: Duration = Duration::from_secs(3);

    let emit = |received: u64, total: Option<u64>| {
        let _ = app.emit(
            "standard-model-download-progress",
            ModelDownloadProgressPayload { received, total },
        );
    };

    emit(0, total_hint);

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            let msg = format!("下载流中断: {}", e);
            emit_download_log(app, &msg);
            msg
        })?;
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
        // Periodic human-readable log every few seconds
        if last_log.elapsed() >= LOG_INTERVAL {
            let elapsed_secs = download_start.elapsed().as_secs_f64();
            let speed = if elapsed_secs > 0.0 {
                received as f64 / elapsed_secs
            } else {
                0.0
            };
            let pct_str = if let Some(total) = total_hint {
                if total > 0 {
                    format!(" ({:.1}%)", received as f64 / total as f64 * 100.0)
                } else {
                    String::new()
                }
            } else {
                String::new()
            };
            let total_str = total_hint
                .map(|t| format!(" / {}", format_bytes(t)))
                .unwrap_or_default();
            emit_download_log(
                app,
                &format!(
                    "已下载 {}{}{} — {}/s",
                    format_bytes(received),
                    total_str,
                    pct_str,
                    format_bytes(speed as u64),
                ),
            );
            last_log = Instant::now();
        }
    }

    emit(received, Some(received));
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|e| format!("flush: {}", e))?;
    drop(file);

    let total_elapsed = download_start.elapsed();
    emit_download_log(
        app,
        &format!(
            "下载完成: {} — 耗时 {:.1}s",
            format_bytes(received),
            total_elapsed.as_secs_f64(),
        ),
    );

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
        emit_download_log(app, "模型已下载（标记文件存在），跳过下载");
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

    emit_download_log(
        app,
        &format!("准备下载模型: {} → {}", url, dest.display()),
    );

    // Check if a partial/complete file already exists
    if dest.exists() {
        if let Ok(meta) = tokio::fs::metadata(&dest).await {
            let size = meta.len();
            if size >= MIN_GGUF_BYTES {
                emit_download_log(
                    app,
                    &format!("模型文件已存在且大小正常 ({})，写入标记", format_bytes(size)),
                );
                tokio::fs::write(&marker, "ok")
                    .await
                    .map_err(|e| format!("failed to write marker: {}", e))?;
                return Ok(());
            }
            emit_download_log(
                app,
                &format!(
                    "模型文件已存在但不完整 ({} < {} MiB)，将重新下载",
                    format_bytes(size),
                    MIN_GGUF_BYTES / (1024 * 1024)
                ),
            );
        }
    }

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
            emit_download_log(app, &format!("下载失败: {}", e));
            return Err(e);
        }
    };

    if !gguf_file_ready(&dest).await {
        let _ = tokio::fs::remove_file(&dest).await;
        let msg = format!(
            "下载的文件不完整或小于 {} MiB（实际 {} bytes）",
            MIN_GGUF_BYTES / (1024 * 1024),
            bytes
        );
        emit_download_log(app, &msg);
        return Err(msg);
    }

    emit_download_log(app, &format!("模型下载成功: {}", format_bytes(bytes)));

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
