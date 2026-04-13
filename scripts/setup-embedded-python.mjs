import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(process.cwd())
const OUT_ROOT = path.join(ROOT, 'src-tauri', 'resources', 'py')
const LATEST_JSON =
    'https://raw.githubusercontent.com/astral-sh/python-build-standalone/latest-release/latest-release.json'
const GITHUB_TAG_API = (tag) =>
    `https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/${encodeURIComponent(tag)}`

function fail(msg) {
    console.error(msg)
    process.exit(1)
}

function run(cmd, args, opts = {}) {
    const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
    if (res.status !== 0) {
        fail(`command failed: ${cmd} ${args.join(' ')}`)
    }
}

function curlText(url, headers = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-translater-curl-'))
    const outPath = path.join(tmpDir, 'out.txt')

    const args = ['-fsSL', '--retry', '3', '--retry-delay', '1', '-o', outPath]
    for (const [k, v] of Object.entries(headers)) {
        args.push('-H', `${k}: ${v}`)
    }
    args.push(url)
    // Use -o to avoid spawnSync stdout buffer limits (ENOBUFS on Windows).
    const res = spawnSync('curl', args, { encoding: 'utf8' })
    if (res.error) {
        throw new Error(`curl spawn failed for ${url}\nerror: ${String(res.error)}`)
    }

    const stderr = (res.stderr || '').toString()
    const fileText = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : ''
    const fileTrim = fileText.trim()

    // On some Windows setups, curl may be terminated unexpectedly (status=null),
    // but still returns a complete JSON payload. If stdout looks like JSON and
    // stderr is empty, treat it as success to avoid flaky failures.
    if (res.status === null && fileTrim && !stderr.trim()) {
        const first = fileTrim[0]
        if (first === '{' || first === '[') {
            console.warn(`[python] curl returned status=null, but stdout looks like JSON; continue`)
            return fileText
        }
    }

    if (res.status !== 0) {
        const bodyHint = fileTrim ? fileTrim.slice(0, 400) + (fileTrim.length > 400 ? '…' : '') : ''
        const codeOrSignal = res.status === null ? `signal=${String(res.signal || 'unknown')}` : String(res.status)
        const msg = [
            `curl failed (${codeOrSignal}) for ${url}`,
            stderr.trim() ? `stderr: ${stderr.trim()}` : '',
            bodyHint ? `body(head): ${bodyHint}` : '',
        ]
            .filter(Boolean)
            .join('\n')
        throw new Error(msg)
    }
    return fileText
}

async function fetchTextWithFallback(url, headers = {}) {
    try {
        const r = await fetch(url, { headers })
        if (!r.ok) throw new Error(`http ${r.status}`)
        return await r.text()
    } catch (e) {
        console.warn(`[python] fetch failed, fallback to curl: ${url}`)
        return curlText(url, headers)
    }
}

async function fetchJsonWithFallback(url, headers = {}) {
    const text = await fetchTextWithFallback(url, headers)
    try {
        return JSON.parse(text)
    } catch {
        const head = text.slice(0, 400) + (text.length > 400 ? '…' : '')
        throw new Error(`invalid json from ${url}\nbody(head): ${head}`)
    }
}

/** Walk tree: if symlink → absolute path and ./basename exists, replace with relative link. */
function relativizeBrokenAbsoluteSymlinks(rootDir) {
    function walk(dir) {
        let entries
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const ent of entries) {
            const p = path.join(dir, ent.name)
            if (ent.isDirectory()) {
                walk(p)
                continue
            }
            if (!ent.isSymbolicLink()) {
                continue
            }
            let t
            try {
                t = fs.readlinkSync(p)
            } catch {
                continue
            }
            if (!path.isAbsolute(t)) {
                continue
            }
            const base = path.basename(t)
            const candidate = path.join(dir, base)
            if (!fs.existsSync(candidate)) {
                continue
            }
            try {
                fs.unlinkSync(p)
                fs.symlinkSync(base, p)
            } catch (e) {
                console.warn(`[python] could not relativize ${p}: ${e}`)
            }
        }
    }
    walk(rootDir)
}

function platformTriple() {
    const arch = process.arch
    if (process.platform === 'darwin') {
        if (arch === 'arm64') return { triple: 'aarch64-apple-darwin', dir: 'macos' }
        if (arch === 'x64') return { triple: 'x86_64-apple-darwin', dir: 'macos' }
        fail(`unsupported mac arch: ${arch}`)
    }
    if (process.platform === 'linux') {
        if (arch === 'x64') return { triple: 'x86_64-unknown-linux-gnu', dir: 'linux' }
        if (arch === 'arm64') return { triple: 'aarch64-unknown-linux-gnu', dir: 'linux' }
        fail(`unsupported linux arch: ${arch}`)
    }
    if (process.platform === 'win32') {
        if (arch === 'x64') return { triple: 'x86_64-pc-windows-msvc', dir: 'windows' }
        fail(`unsupported windows arch: ${arch}`)
    }
    fail(`unsupported platform: ${process.platform}`)
}

async function main() {
    const { triple, dir } = platformTriple()
    const pyMajorMinor = process.env.PYTHON_VERSION ?? '3.11'
    const wantFlavor = process.env.PYTHON_FLAVOR ?? 'install_only_stripped'

    console.log(`[python] target=${triple} out=${dir} version=${pyMajorMinor} flavor=${wantFlavor}`)

    const meta = await fetchJsonWithFallback(LATEST_JSON, {
        'User-Agent': 'simple-translater-setup',
        Accept: 'application/json',
    })

    const tag = meta?.tag
    if (typeof tag !== 'string' || !tag) {
        fail('unexpected latest-release.json format: missing tag')
    }

    const release = await fetchJsonWithFallback(GITHUB_TAG_API(tag), {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'simple-translater-setup',
    })

    const assets = release?.assets
    if (!Array.isArray(assets)) {
        fail('unexpected GitHub release format: missing assets[]')
    }

    const matches = assets
        .map((a) => ({ name: a?.name, url: a?.browser_download_url }))
        .filter((a) => typeof a?.name === 'string' && typeof a?.url === 'string')

    const preferred = matches.find((a) => {
        const n = a.name
        return (
            n.includes(`cpython-${pyMajorMinor}`) &&
            n.includes(tag) &&
            n.includes(triple) &&
            n.includes(wantFlavor) &&
            (n.endsWith('.tar.gz') || n.endsWith('.tar.zst'))
        )
    })
    const fallback = matches.find((a) => {
        const n = a.name
        return (
            n.includes(`cpython-${pyMajorMinor}`) &&
            n.includes(tag) &&
            n.includes(triple) &&
            n.includes('install_only') &&
            (n.endsWith('.tar.gz') || n.endsWith('.tar.zst'))
        )
    })
    const chosen = preferred ?? fallback
    if (!chosen) {
        fail(`cannot find matching python-build-standalone asset for ${pyMajorMinor} ${triple} tag=${tag}`)
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-translater-py-'))
    const archivePath = path.join(tmpDir, chosen.name)
    const extractDir = path.join(tmpDir, 'extract')
    fs.mkdirSync(extractDir, { recursive: true })

    console.log(`[python] download ${chosen.name}`)
    run('curl', ['-L', chosen.url, '-o', archivePath])

    if (archivePath.endsWith('.tar.gz')) {
        console.log('[python] extract (.tar.gz)')
        run('tar', ['-xzf', archivePath, '-C', extractDir])
    } else if (archivePath.endsWith('.tar.zst')) {
        // Extract: zstd -d -> tar -xf (macOS default tar often lacks -a for zstd)
        console.log('[python] extract (.tar.zst, requires zstd + tar)')
        const tarPath = archivePath.replace(/\.zst$/, '')
        run('zstd', ['-d', '-f', archivePath, '-o', tarPath])
        run('tar', ['-xf', tarPath, '-C', extractDir])
    } else {
        fail(`unsupported archive type: ${archivePath}`)
    }

    const pythonDir = path.join(extractDir, 'python')
    if (!fs.existsSync(pythonDir)) {
        fail(`unexpected archive layout: missing ${pythonDir}`)
    }

    const outDir = path.join(OUT_ROOT, dir)
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.mkdirSync(outDir, { recursive: true })

    // Copy python/* into resources/py/<dir> so we get bin/python3 or python.exe at expected paths.
    console.log(`[python] install into ${path.relative(ROOT, outDir)}`)
    const entries = fs.readdirSync(pythonDir)
    for (const name of entries) {
        const from = path.join(pythonDir, name)
        const to = path.join(outDir, name)
        fs.cpSync(from, to, { recursive: true })
    }

    // Node/fs.cpSync can preserve symlinks that point at the *extract temp dir*; Tauri then fails.
    // Unix/macOS/Linux: rewrite those to same-dir relative links. Skip on Windows: standalone layout
    // uses .exe / launcher files, not bin/python3-style symlinks; symlink creation also needs extra privileges.
    if (process.platform !== 'win32') {
        relativizeBrokenAbsoluteSymlinks(outDir)
    }

    console.log('[python] done')
    console.log(`[python] next: run dev-tauri and click “一键准备” in Settings`)
}

main().catch((e) => fail(String(e?.stack ?? e)))

