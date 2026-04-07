import argparse
import json
import os
import sys
import time

# Rust reads this after the process exits (stdout may be mixed with hub logs).
RESULT_NAME = ".hf_download_result.json"


def _write_result(out_dir: str, payload: dict) -> None:
    path = os.path.join(out_dir, RESULT_NAME)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _close_hf_http_session() -> None:
    """After a dropped connection (e.g. WinError 10054), a shared httpx client may stay closed."""
    try:
        from huggingface_hub.utils._http import close_session

        close_session()
    except Exception:
        pass


def _hf_download(repo_id: str, filename: str, out_dir: str) -> str:
    from huggingface_hub import hf_hub_download

    kwargs = {
        "repo_id": repo_id,
        "filename": filename,
        "local_dir": out_dir,
        "etag_timeout": 60.0,
    }
    endpoint = os.environ.get("HF_ENDPOINT")
    if endpoint:
        kwargs["endpoint"] = endpoint
    return hf_hub_download(**kwargs)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--filename", required=True)
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    # tqdm/progress → stderr; keep bars off to reduce noise when stderr is inherited.
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

    max_attempts = int(os.environ.get("HF_DOWNLOAD_RETRIES", "8"))
    base_delay = float(os.environ.get("HF_DOWNLOAD_RETRY_DELAY", "2"))

    last_err: BaseException | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            target = _hf_download(args.repo, args.filename, args.out_dir)
            if not os.path.isfile(target):
                raise RuntimeError(f"hub reported path is not a file: {target}")
            payload = {"ok": True, "path": target}
            _write_result(args.out_dir, payload)
            print(json.dumps(payload), flush=True)
            return 0
        except BaseException as e:
            last_err = e
            _close_hf_http_session()
            sys.stderr.write(f"[download_model] attempt {attempt}/{max_attempts} failed: {e!s}\n")
            sys.stderr.flush()
            if attempt < max_attempts:
                delay = min(base_delay * (2 ** (attempt - 1)), 120.0)
                time.sleep(delay)

    msg = str(last_err) if last_err else "unknown error"
    extra = ""
    low = msg.lower()
    if "10054" in msg or "reset" in low or "closed" in low or "connection" in low:
        extra = (
            " 网络不稳定或无法直连 Hugging Face 时，可将系统环境变量 HF_ENDPOINT 设为镜像地址"
            "（例如 https://hf-mirror.com）后重试。"
        )
    payload = {"ok": False, "message": msg + extra}
    _write_result(args.out_dir, payload)
    print(json.dumps(payload, ensure_ascii=False), flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
