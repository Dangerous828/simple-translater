import argparse
import json
import os
from huggingface_hub import hf_hub_download


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--filename", required=True)
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    try:
        target = hf_hub_download(
            repo_id=args.repo,
            filename=args.filename,
            local_dir=args.out_dir,
            local_dir_use_symlinks=False,
            resume_download=True,
        )
        print(json.dumps({"ok": True, "path": target}))
        return 0
    except Exception as e:
        print(json.dumps({"ok": False, "message": str(e)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

