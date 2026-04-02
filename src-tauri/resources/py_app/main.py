import argparse
import json
import os
import re
from typing import Dict


def guess_langs_from_prompt(prompt: str) -> Dict[str, str]:
    # Our TS layer builds prompts like:
    # "Translate the given text from <A> to <B>."
    m = re.search(r"Translate the given text from (.+?) to (.+?)\.", prompt)
    if not m:
        return {"source": "", "target": ""}
    return {"source": m.group(1).strip(), "target": m.group(2).strip()}


def extract_text_from_prompt(prompt: str) -> str:
    # translate.ts wraps content like:
    # "Only reply the result and nothing else. ...:\n\n<text>"
    if "\n\n" in prompt:
        return prompt.split("\n\n", 1)[1].strip()
    return prompt.strip()


def run_inference(repo_dir: str, prompt: str) -> str:
    # Smaller runtime: llama.cpp via llama-cpp-python + GGUF.
    from llama_cpp import Llama  # type: ignore

    text = extract_text_from_prompt(prompt)
    langs = guess_langs_from_prompt(prompt)

    final_prompt = (
        "You are a professional translation engine.\n"
        f"Translate the given text from {langs.get('source','')} to {langs.get('target','')}.\n"
        "Output ONLY the translated text.\n\n"
        f"{text}"
    )

    llm = Llama(
        model_path=repo_dir,
        n_ctx=4096,
        n_threads=os.cpu_count() or 4,
        logits_all=False,
        verbose=False,
    )
    out = llm(
        final_prompt,
        max_tokens=512,
        temperature=0.0,
        top_p=1.0,
        stop=[],
    )
    return (out.get("choices", [{}])[0].get("text") or "").strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--filename", required=True)
    ap.add_argument("--models-dir", required=True)
    ap.add_argument("--prompt", required=True)
    args = ap.parse_args()

    repo_dir = os.path.join(args.models_dir, args.repo.replace("/", "__"))
    model_path = os.path.join(repo_dir, args.filename)
    if not os.path.isfile(model_path):
        print(json.dumps({"text": f"模型未下载：{model_path}"}))
        return 0

    try:
        text = run_inference(model_path, args.prompt)
        print(json.dumps({"text": text}))
        return 0
    except Exception as e:
        # Return as a normal response so UI shows it; Rust layer will treat non-zero as error anyway.
        print(json.dumps({"text": f"Python 推理失败：{e}"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

