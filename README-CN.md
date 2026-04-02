# simple-translator（仅桌面端 Tauri）

<p align="center">
    <br> <a href="README.md">English</a> | 中文
</p>

一个极简的桌面翻译器：**Tauri + React**。

默认使用 **标准模式（本地 Python）**：自动安装依赖、自动下载模型并本地推理。**Ollama** 为可选模式，可在设置中切换。

## 包含功能

-   **翻译**
-   **历史记录**
-   **全局快捷键**
-   **供应商**：
    -   **标准模式（推荐）**：内置 Python + 本地推理，首次使用自动下载模型
    -   **Ollama（可选）**：如你偏好 Ollama 管理运行时，可在设置中切换

已移除浏览器插件 / userscript / OCR / 更新器 / Thumb / 动作管理等所有非核心功能。

## 环境要求

-   **Rust 工具链**（Tauri 需要）
-   **标准模式（默认）**
    -   应用内置可携带 Python 运行时，首次运行会自动创建 venv 并安装依赖
    -   默认模型来自 HuggingFace：`huihui-ai/Huihui-HY-MT1.5-1.8B-abliterated`（首次使用自动下载）
-   **Ollama 模式（可选）**
    -   **本地 Ollama** 正在运行
    -   默认 URL：`http://127.0.0.1:11434`
    -   建议使用 `127.0.0.1`，比 `localhost` 更稳定

## 开发运行

```bash
pnpm install
pnpm setup-python-runtime
pnpm dev-tauri
```

## 构建

```bash
pnpm build-tauri
```

## Windows（NSIS 安装器）

### 构建环境（仅 Windows 打包机需要）

-   Node.js（LTS）+ pnpm
-   Rust 工具链（MSVC）
-   Visual Studio Build Tools（需要 C++ 工作负载 + Windows SDK）

### 打包步骤

```bash
pnpm install
pnpm setup-python-runtime
pnpm build-tauri
```

### 产物位置

-   NSIS 安装器通常在：
    -   `src-tauri/target/release/bundle/nsis/`

### 用户侧常见问题

-   缺 WebView2 Runtime：
    -   本项目已配置 `embedBootstrapper`，但在受限环境下可能仍失败。
    -   手动安装 WebView2 Runtime：`https://developer.microsoft.com/microsoft-edge/webview2/`
-   缺 VC++ 运行库：
    -   少数机器需要安装 Microsoft Visual C++ Redistributable（x64）。

## 说明

-   标准模式会显著增加体积（内置 Python + ML 依赖 + 模型缓存）。
-   如果你之前配置过代理，本地 Ollama 请求可能出现 502。本版本会对 `localhost/127.0.0.1` 强制绕过代理。

## License

[LICENSE](./LICENSE)
