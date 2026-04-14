/**
 * Ensure Windows bundler tools (NSIS + WiX) are in the Tauri cache directory.
 *
 * Tauri 2.x downloads NSIS and WiX on first Windows build into:
 *   %LOCALAPPDATA%/tauri/
 *
 * On networks with SSL/proxy issues this download fails.
 * This script has two modes:
 *
 * 1. SAVE mode (run on a machine that CAN access the internet):
 *      node scripts/setup-win-bundler-tools.mjs save
 *    Copies tools FROM Tauri cache INTO project at src-tauri/bundler-tools/
 *    so they can be committed to git.
 *
 * 2. RESTORE mode (run on a machine that CANNOT access the internet):
 *      node scripts/setup-win-bundler-tools.mjs restore
 *    Copies tools FROM project INTO Tauri cache so builds work offline.
 *    This is also run automatically as part of build-tauri-win.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.resolve(process.cwd())
const PROJECT_TOOLS = path.join(ROOT, 'src-tauri', 'bundler-tools')

function getTauriCacheDir() {
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA
        if (!localAppData) {
            console.error('LOCALAPPDATA not set')
            process.exit(1)
        }
        return path.join(localAppData, 'tauri')
    }
    // macOS/Linux: ~/.cache/tauri (not typically needed but for completeness)
    return path.join(os.homedir(), '.cache', 'tauri')
}

function copyDirSync(src, dest) {
    fs.cpSync(src, dest, { recursive: true, force: true })
}

function save() {
    const cacheDir = getTauriCacheDir()

    // Look for NSIS and WiX directories in Tauri cache
    const nsisDir = path.join(cacheDir, 'NSIS')
    const wixDir = path.join(cacheDir, 'WixTools')
    // Tauri 2.x also stores nsis-tauri-utils plugin
    const nsisPluginsDir = path.join(cacheDir, 'NSIS', 'Plugins')

    let found = false

    if (fs.existsSync(nsisDir)) {
        const dest = path.join(PROJECT_TOOLS, 'NSIS')
        console.log(`[bundler-tools] saving NSIS: ${nsisDir} -> ${path.relative(ROOT, dest)}`)
        fs.mkdirSync(dest, { recursive: true })
        copyDirSync(nsisDir, dest)
        found = true
    } else {
        console.warn(`[bundler-tools] NSIS not found at ${nsisDir}`)
        console.warn('  Run "pnpm build-tauri" once on a machine with internet to populate the cache.')
    }

    if (fs.existsSync(wixDir)) {
        const dest = path.join(PROJECT_TOOLS, 'WixTools')
        console.log(`[bundler-tools] saving WiX: ${wixDir} -> ${path.relative(ROOT, dest)}`)
        fs.mkdirSync(dest, { recursive: true })
        copyDirSync(wixDir, dest)
        found = true
    } else {
        console.warn(`[bundler-tools] WiX not found at ${wixDir}`)
        console.warn('  Run "pnpm build-tauri" with "msi" target once to populate the cache.')
    }

    // Also check for any other tool directories Tauri might create
    if (fs.existsSync(cacheDir)) {
        const entries = fs.readdirSync(cacheDir, { withFileTypes: true })
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name !== 'NSIS' && entry.name !== 'WixTools') {
                const src = path.join(cacheDir, entry.name)
                const dest = path.join(PROJECT_TOOLS, entry.name)
                console.log(`[bundler-tools] saving ${entry.name}: ${src} -> ${path.relative(ROOT, dest)}`)
                fs.mkdirSync(dest, { recursive: true })
                copyDirSync(src, dest)
                found = true
            }
        }
    }

    if (found) {
        console.log(`\n[bundler-tools] saved to ${path.relative(ROOT, PROJECT_TOOLS)}`)
        console.log('[bundler-tools] commit this directory to git so offline builds work.')
    } else {
        console.error('[bundler-tools] nothing to save. Build once with internet first.')
        process.exit(1)
    }
}

function restore() {
    if (!fs.existsSync(PROJECT_TOOLS)) {
        console.log('[bundler-tools] no bundler-tools directory found in project, skipping restore.')
        console.log('[bundler-tools] Tauri will download tools from the internet.')
        return
    }

    const cacheDir = getTauriCacheDir()
    fs.mkdirSync(cacheDir, { recursive: true })

    const entries = fs.readdirSync(PROJECT_TOOLS, { withFileTypes: true })
    let restored = 0

    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const src = path.join(PROJECT_TOOLS, entry.name)
        const dest = path.join(cacheDir, entry.name)

        if (fs.existsSync(dest)) {
            console.log(`[bundler-tools] ${entry.name} already in cache, skipping.`)
            continue
        }

        console.log(`[bundler-tools] restoring ${entry.name} -> ${dest}`)
        copyDirSync(src, dest)
        restored++
    }

    if (restored > 0) {
        console.log(`[bundler-tools] restored ${restored} tool(s) to Tauri cache.`)
    } else {
        console.log('[bundler-tools] all tools already in cache.')
    }
}

const mode = process.argv[2] || 'restore'

if (mode === 'save') {
    save()
} else if (mode === 'restore') {
    restore()
} else {
    console.error(`Usage: node setup-win-bundler-tools.mjs [save|restore]`)
    process.exit(1)
}
