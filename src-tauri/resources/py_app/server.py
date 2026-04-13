import json
import os
import re
import sys
from typing import Dict


def guess_langs_from_prompt(prompt: str) -> Dict[str, str]:
    m = re.search(r"Translate the given text from (.+?) to (.+?)\.", prompt)
    if not m:
        return {"source": "", "target": ""}
    return {"source": m.group(1).strip(), "target": m.group(2).strip()}


def extract_text_from_prompt(prompt: str) -> str:
    """Take user/source text after the first blank line following role instructions.

    Plain translate sends: role, blank line, then <text> only.
    Other modes may prefix the tail with 'Only reply the result...'; strip that so the model
    does not treat English instructions as translatable source.
    """
    if "\n\n" not in prompt:
        return prompt.strip()
    rest = prompt.split("\n\n", 1)[1].strip()
    prefix = "Only reply the result and nothing else."
    if rest.startswith(prefix):
        # \"... ${commandPrompt}:\\n\\n${content}\" — content starts after first \":\\n\" block
        for sep in (":\n\n", ":\n"):
            i = rest.find(sep, len(prefix))
            if i != -1:
                tail = rest[i + len(sep) :].strip()
                if tail:
                    return tail
    return rest

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
    model_path = os.environ.get("STD_MODEL_PATH", "").strip()
    if not model_path:
        sys.stderr.write("missing STD_MODEL_PATH\n")
        return 2

    from llama_cpp import Llama  # type: ignore

    # Speed knobs.
    # Defaults are conservative and cross-platform; the host app can override via env.
    n_threads = int(os.environ.get("STD_THREADS", str(os.cpu_count() or 4)))
    n_ctx = int(os.environ.get("STD_CTX", "2048"))
    n_gpu_layers = int(os.environ.get("STD_GPU_LAYERS", "0"))

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

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            prompt = str(req.get("prompt") or "")
            text = extract_text_from_prompt(prompt)
            langs = guess_langs_from_prompt(prompt)
            final_prompt = (
                "You are a professional translation engine.\n"
                f"Translate the given text from {langs.get('source','')} to {langs.get('target','')}.\n"
                "Output ONLY the translated text.\n\n"
                f"{text}"
            )
            max_tokens = int(req.get("max_tokens") or 0) or calc_max_tokens(text)
            out = llm(final_prompt, max_tokens=max_tokens, temperature=0.0, top_p=1.0, stop=[])
            ans = (out.get("choices", [{}])[0].get("text") or "").strip()
            sys.stdout.write(json.dumps({"ok": True, "text": ans}, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception as e:
            sys.stdout.write(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

