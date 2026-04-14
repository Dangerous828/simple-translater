# simple-translator (Tauri-only)

<p align="center">
    <br> English | <a href="README-CN.md">中文</a>
</p>

Minimal desktop translator built with **Tauri + React**.

Default provider is **Standard mode (local Python)** with auto model download. **Ollama** is optional.

## What’s included

-   **Translator**
-   **History**
-   **Global hotkeys**
-   **Providers**:
    -   **Standard (recommended)**: embedded Python + local inference, auto-download model on first use
    -   **Ollama (optional)**: switch in Settings if you prefer an Ollama-managed runtime

Everything else (browser extensions/userscripts/OCR/updater/thumb/action manager, etc.) has been removed.

## Prerequisites

-   **Rust toolchain** (for Tauri)
-   **Standard mode** (default):
    -   The app bundles a portable Python runtime and installs Python deps on first run.
    -   The default model is downloaded from HuggingFace: `huihui-ai/Huihui-HY-MT1.5-1.8B-abliterated`.
-   **Ollama mode** (optional):
    -   Ollama running locally
    -   Default URL: `http://127.0.0.1:11434`
    -   Recommended: use `127.0.0.1` instead of `localhost`

## Development

```bash
pnpm install
pnpm setup-python-runtime
pnpm dev-tauri
```

## Build

```bash
pnpm build-tauri
```

## Windows (NSIS installer)

### Build prerequisites (Windows build machine only)

-   Node.js (LTS) + pnpm
-   Rust toolchain (MSVC)
-   Visual Studio Build Tools (C++ workload + Windows SDK)

### Build steps

```bash
pnpm install
pnpm setup-python-runtime
pnpm setup-nsis          # 将预置的 NSIS/WiX 工具复制到 Tauri 缓存，避免构建时下载
pnpm build-tauri
```

### Output

-   NSIS installer is usually generated under:
    -   `src-tauri/target/release/bundle/nsis/`

### Troubleshooting (Windows build)

-   **NSIS/WiX 下载失败（SSL 错误）**：
    -   项目已预置 NSIS 和 WiX 工具在 `src-tauri/bundler-tools/`，运行 `pnpm setup-nsis` 即可。
    -   该命令会将工具复制到 `%LOCALAPPDATA%/tauri/`，Tauri 构建时会直接使用，不再下载。
-   **Python runtime 下载失败（SSL 错误）**：
    -   设置环境变量后重试：`set CURL_INSECURE=1` 然后 `pnpm setup-python-runtime`

### Troubleshooting (end-users)

-   WebView2 Runtime missing:
    -   This project uses `embedBootstrapper` for WebView2, but on restricted machines it may still fail.
    -   Install WebView2 Runtime manually: `https://developer.microsoft.com/microsoft-edge/webview2/`
-   VC++ Runtime missing:
    -   Some machines may require the Microsoft Visual C++ Redistributable.
    -   Install “Microsoft Visual C++ Redistributable (x64)”.

## Notes

-   Standard mode significantly increases app size (embedded Python + ML deps + model cache).
-   If you previously configured a proxy, local Ollama requests may fail with 502. This build bypasses proxy for `localhost/127.0.0.1`.

## License

[LICENSE](./LICENSE)
