#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Bootstrap build environment for this repo (macOS / Windows).

Mode B: auto-install when possible using brew/winget, otherwise print instructions.

What it sets up for *developer/build machines*:
- Git
- Node.js + corepack + pnpm
- Rust toolchain (rustup + cargo)
- macOS: Xcode Command Line Tools
- Windows: Visual Studio Build Tools (MSVC) + WebView2 guidance

It does NOT modify project files. It may invoke system installers and can require admin privileges,
especially on Windows.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Optional


@dataclass
class CmdResult:
    code: int
    out: str
    err: str


def run(cmd: list[str], check: bool = False) -> CmdResult:
    p = subprocess.run(cmd, capture_output=True, text=True, shell=False)
    if check and p.returncode != 0:
        raise RuntimeError(f"Command failed: {cmd}\n{p.stdout}\n{p.stderr}")
    return CmdResult(p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip())


def which(exe: str) -> Optional[str]:
    return shutil.which(exe)


def is_windows() -> bool:
    return platform.system().lower() == "windows"


def is_macos() -> bool:
    return platform.system().lower() == "darwin"


def header(title: str) -> None:
    print("\n" + "=" * 72)
    print(title)
    print("=" * 72)


def ok(msg: str) -> None:
    print(f"[OK] {msg}")


def warn(msg: str) -> None:
    print(f"[WARN] {msg}")


def info(msg: str) -> None:
    print(f"[INFO] {msg}")


def fail(msg: str) -> None:
    print(f"[FAIL] {msg}")


def suggest(cmd: str) -> None:
    print(f"  -> {cmd}")


def try_install_brew() -> None:
    # Homebrew official install is interactive and downloads scripts; we only print instructions.
    warn("Homebrew not found. Auto-install is intentionally not performed.")
    suggest("Install Homebrew: https://brew.sh/")


def ensure_git() -> None:
    header("Git")
    if which("git"):
        ok(f"git: {run(['git', '--version']).out}")
        return
    fail("git not found")
    if is_macos():
        suggest("Install Xcode Command Line Tools (includes git): xcode-select --install")
    elif is_windows():
        suggest("Install Git for Windows: https://git-scm.com/download/win")


def ensure_node_pnpm() -> None:
    header("Node / pnpm")
    node = which("node")
    if not node:
        fail("node not found")
        if is_macos():
            if which("brew"):
                suggest("Auto-install via brew: brew install node@20 && brew link --force --overwrite node@20")
                info("Attempting to install Node via brew...")
                r = run(["brew", "install", "node@20"])
                if r.code != 0:
                    warn(r.err or r.out or "brew install failed")
            else:
                try_install_brew()
            suggest("Or install Node LTS from: https://nodejs.org/")
        elif is_windows():
            if which("winget"):
                suggest("Auto-install via winget: winget install OpenJS.NodeJS.LTS")
                info("Attempting to install Node via winget...")
                r = run(["winget", "install", "OpenJS.NodeJS.LTS"])
                if r.code != 0:
                    warn(r.err or r.out or "winget install failed (try running as admin)")
            else:
                suggest("Install Node LTS from: https://nodejs.org/ (LTS)")
        return

    ok(f"node: {run(['node', '-v']).out}")

    if which("corepack"):
        r = run(["corepack", "enable"])
        if r.code == 0:
            ok("corepack enabled")
        else:
            warn(f"corepack enable failed: {r.err or r.out}")

        desired = os.environ.get("PNPM_VERSION", "").strip()
        if desired:
            r2 = run(["corepack", "prepare", f"pnpm@{desired}", "--activate"])
            if r2.code == 0:
                ok(f"pnpm activated: {desired}")
            else:
                warn(f"corepack prepare pnpm@{desired} failed: {r2.err or r2.out}")
        else:
            info("PNPM_VERSION not set; you can set it to match repo's pinned pnpm.")
            suggest("Example: PNPM_VERSION=9.1.3 python bootstrap_build_env.py")
    else:
        warn("corepack not found; pnpm activation may be harder")

    if which("pnpm"):
        ok(f"pnpm: {run(['pnpm', '-v']).out}")
    else:
        warn("pnpm not found")
        suggest("Try: corepack enable && corepack prepare pnpm@latest --activate")
        suggest("Or: npm i -g pnpm")


def ensure_rust() -> None:
    header("Rust")
    cargo = which("cargo")
    rustup = which("rustup")
    if cargo and rustup:
        ok(f"rustup: {run(['rustup', '--version']).out}")
        ok(f"cargo: {run(['cargo', '--version']).out}")
        return

    warn("Rust toolchain not fully available")
    if is_windows():
        suggest("Install rustup (MSVC): https://rustup.rs/")
    else:
        suggest("Install rustup: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh")
        suggest("Then restart shell, ensure ~/.cargo/bin is in PATH")


def ensure_macos_clt() -> None:
    if not is_macos():
        return
    header("macOS: Xcode Command Line Tools")
    r = run(["xcode-select", "-p"])
    if r.code == 0 and r.out:
        ok(f"CLT path: {r.out}")
        return
    warn("Xcode Command Line Tools not found")
    suggest("xcode-select --install (GUI prompt will appear)")


def ensure_windows_build_tools() -> None:
    if not is_windows():
        return
    header("Windows: MSVC Build Tools / WebView2")
    if which("winget"):
        info("winget detected")
        suggest("Auto-install Visual Studio Build Tools 2022:")
        suggest("  winget install --id Microsoft.VisualStudio.2022.BuildTools -e")
        info("Attempting to install VS Build Tools via winget...")
        r = run(["winget", "install", "--id", "Microsoft.VisualStudio.2022.BuildTools", "-e"])
        if r.code != 0:
            warn(r.err or r.out or "winget install failed (try running as admin)")

        warn("After install, open 'Visual Studio Installer' and ensure workloads:")
        suggest("- Desktop development with C++")
        suggest("- Windows 10/11 SDK")
    else:
        warn("winget not detected")
        suggest("Install Visual Studio Build Tools 2022: https://visualstudio.microsoft.com/downloads/")

    suggest("Ensure WebView2 Runtime installed: https://developer.microsoft.com/microsoft-edge/webview2/")


def project_next_steps() -> None:
    header("Project next steps (repo root)")
    if which("pnpm"):
        suggest("pnpm install")
        suggest("pnpm setup-python-runtime")
        suggest("pnpm dev-tauri")
        suggest("pnpm build-tauri")
    else:
        suggest("After pnpm is available: pnpm install && pnpm dev-tauri")


def main() -> int:
    header(f"Bootstrap build env (mode=B) - {platform.system()} {platform.machine()}")
    info("This configures a *developer/build machine* for Tauri bundling.")
    info("Some steps may require admin privileges (Windows) or GUI prompts (macOS).")

    ensure_git()
    ensure_node_pnpm()
    ensure_rust()
    ensure_macos_clt()
    ensure_windows_build_tools()
    project_next_steps()

    print("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

