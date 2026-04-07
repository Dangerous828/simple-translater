#!/bin/sh
# Run lint-staged when `node` is available; otherwise warn and succeed so GUI Git
# (VS Code / Cursor) can commit even when hooks inherit a minimal PATH.

ROOT=$(git rev-parse --show-toplevel) || exit 0
cd "$ROOT" || exit 0

if [ "$SKIP_SIMPLE_GIT_HOOKS" = "1" ]; then
    exit 0
fi

if [ -f "$SIMPLE_GIT_HOOKS_RC" ]; then
    # shellcheck source=/dev/null
    . "$SIMPLE_GIT_HOOKS_RC"
fi

# Common locations missing when hooks run outside an interactive shell (macOS / Linux).
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

# Git for Windows / MSYS: Node installer default paths.
case "$(uname -s 2>/dev/null)" in
MINGW* | MSYS* | CYGWIN*)
    export PATH="$PATH:/c/Program Files/nodejs:/c/Program Files (x86)/nodejs"
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
    echo "[WARN] pre-commit: node not in PATH; skipping lint-staged." >&2
    echo "  Fix: add Node to PATH for GUI apps, or run: pnpm exec lint-staged" >&2
    echo "  Or commit from a terminal, or: SKIP_SIMPLE_GIT_HOOKS=1 git commit ..." >&2
    exit 0
fi

if [ ! -f ./node_modules/lint-staged/bin/lint-staged.js ]; then
    echo "[WARN] pre-commit: node_modules/lint-staged missing; run pnpm install" >&2
    exit 0
fi

exec node ./node_modules/lint-staged/bin/lint-staged.js
