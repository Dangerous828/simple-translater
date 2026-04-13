import json
import os
import re
import sys
from typing import Dict

# Windows: ensure stdout/stderr handle surrogates in paths and error messages gracefully.
# Also force UTF-8 for stdin/stdout/stderr to avoid codec issues with piped I/O.
if sys.platform == "win32":
    for stream_name in ("stdin", "stdout", "stderr"):
        stream = getattr(sys, stream_name)
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="surrogateescape")
            except Exception:
                pass


def guess_langs_from_prompt(prompt: str) -> Dict[str, str]:
    m = re.search(r"Translate the given text from (.+?) to (.+?)\.", prompt)
    if not m:
        return {"source": "", "target": ""}
    return {"source": m.group(1).strip(), "target": m.group(2).strip()}


def extract_text_from_prompt(prompt: str) -> str:
    """Extract the source text from the prompt.

    The prompt format is:
      {instruction}\\n{source_text}
    or legacy:
      ...\\n\\n{source_text}
    """
    if "\n\n" in prompt:
        return prompt.split("\n\n", 1)[1].strip()
    if "\n" in prompt:
        return prompt.split("\n", 1)[1].strip()
    return prompt.strip()

def calc_max_tokens(text: str) -> int:
    # Rough heuristic: translation output length is usually bounded by input length.
    # Avoid always generating 512 tokens for short texts (very slow).
    # Clamp to [64, 256].
    n = len(text)
    guess = int(n * 1.3) + 32
    if guess < 64:
        return 64
    if guess > 256:
        return 256
    return guess


def main() -> int:
    # Args are passed via env for simplicity.
    model_path_raw = os.environ.get("STD_MODEL_PATH", "").strip()
    if not model_path_raw:
        sys.stderr.write("missing STD_MODEL_PATH\n")
        return 2

    # On Windows, env vars may contain surrogate characters from non-UTF8 paths.
    # Normalize via os.fsencode/fsdecode to get a filesystem-safe string.
    try:
        model_path = os.fsdecode(os.fsencode(model_path_raw))
    except Exception:
        model_path = model_path_raw

    # Strip Windows \\?\ extended-length prefix if present — llama.cpp may not handle it.
    if model_path.startswith("\\\\?\\"):
        model_path = model_path[4:]

    # Verify the file actually exists before trying to load it.
    if not os.path.isfile(model_path):
        sys.stderr.write(
            "model file not found: "
            + model_path.encode("utf-8", errors="replace").decode("utf-8")
            + "\n"
        )
        sys.stderr.flush()
        return 2

    from llama_cpp import Llama  # type: ignore

    # Speed knobs.
    # Defaults are conservative and cross-platform; the host app can override via env.
    n_threads = int(os.environ.get("STD_THREADS", str(os.cpu_count() or 4)))
    n_ctx = int(os.environ.get("STD_CTX", "2048"))
    n_gpu_layers = int(os.environ.get("STD_GPU_LAYERS", "0"))

    try:
        llm = Llama(
            model_path=model_path,
            n_ctx=n_ctx,
            n_threads=n_threads,
            n_gpu_layers=n_gpu_layers,
            n_batch=int(os.environ.get("STD_BATCH", "512")),
            use_mmap=True,
            use_mlock=False,
            verbose=False,
        )
    except Exception as e:
        # Use ascii() for model_path to avoid surrogate encoding errors on Windows
        safe_path = model_path.encode("utf-8", errors="replace").decode("utf-8")
        sys.stderr.write(
            f"Failed to load model: {e}\n"
            f"  model_path={safe_path}\n"
            f"  llama_cpp version: "
        )
        try:
            import llama_cpp
            sys.stderr.write(f"{llama_cpp.__version__}\n")
        except Exception:
            sys.stderr.write("unknown\n")
        sys.stderr.write(
            "This usually means llama-cpp-python is too old for this GGUF model.\n"
            "Try: pip install --upgrade llama-cpp-python\n"
        )
        sys.stderr.flush()
        return 3

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            prompt = str(req.get("prompt") or "")
            # The prompt from the Rust/TS layer is already fully constructed
            # (role + command + content). Pass it directly to the model.
            text = extract_text_from_prompt(prompt)
            max_tokens = int(req.get("max_tokens") or 0) or calc_max_tokens(text)
            out = llm(prompt, max_tokens=max_tokens, temperature=0.0, top_p=1.0, stop=[])
            ans = (out.get("choices", [{}])[0].get("text") or "").strip()
            sys.stdout.write(json.dumps({"ok": True, "text": ans}, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception as e:
            sys.stdout.write(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

