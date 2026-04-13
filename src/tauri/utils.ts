import { register, unregisterAll, type ShortcutEvent } from '@tauri-apps/plugin-global-shortcut'
import { getSettings } from '@/common/utils'
import { sendNotification } from '@tauri-apps/plugin-notification'
import { commands, events } from './bindings'
import { ISettings } from '@/common/types'

const modifierKeys = [
    'OPTION',
    'ALT',
    'CONTROL',
    'CTRL',
    'COMMAND',
    'CMD',
    'SUPER',
    'SHIFT',
    'COMMANDORCONTROL',
    'COMMANDORCTRL',
    'CMDORCTRL',
    'CMDORCONTROL',
]

const isModifierKey = (key: string): boolean => {
    return modifierKeys.includes(key.toUpperCase())
}

export function isMissingNormalKey(hotkey: string): boolean {
    const tokens = hotkey.split('+').map((token) => token.trim().toUpperCase())
    return tokens.every((token) => isModifierKey(token))
}

function normalizeTauriHotkey(hotkey: string): string {
    // The UI uses CmdOrCtrl; normalize to Tauri's canonical "CommandOrControl" for compatibility.
    return hotkey
        .split('+')
        .map((t) => t.trim())
        .map((t) => {
            if (t.toUpperCase() === 'CMDORCTRL' || t.toUpperCase() === 'CMDORCONTROL') {
                return 'CommandOrControl'
            }
            return t
        })
        .join('+')
}

function onShortcutPressed(event: ShortcutEvent, action: () => unknown) {
    if (event.state !== 'Pressed') {
        return
    }
    void action()
}

/**
 * Clears all app global shortcuts then registers 划词翻译 + 显示窗口 各一条。
 * 必须合并为一次流程：原先连续调用 bindHotkey 再 bindDisplayWindowHotkey 时，
 * 第二次注册前的逻辑会清掉第一次已注册的快捷键。
 */
export async function syncGlobalHotkeysFromSettings() {
    await unregisterAll().catch(() => {
        /* ignore */
    })
    const settings = await getSettings()

    const rawTranslate = (settings.hotkey ?? '').trim()
    const rawDisplay = (settings.displayWindowHotkey ?? '').trim()

    if (rawTranslate && rawDisplay && normalizeTauriHotkey(rawTranslate) === normalizeTauriHotkey(rawDisplay)) {
        sendNotification({
            title: '快捷键冲突',
            body: '划词翻译与显示翻译窗口的快捷键不能设为相同组合。',
        })
        return
    }

    if (rawTranslate) {
        if (isMissingNormalKey(rawTranslate)) {
            sendNotification({
                title: 'Cannot bind hotkey',
                body: `Hotkey must contain at least one normal key: ${rawTranslate}`,
            })
        } else {
            const hotkey = normalizeTauriHotkey(rawTranslate)
            try {
                await register(hotkey, (event) =>
                    onShortcutPressed(event, () => commands.showTranslatorWindowWithSelectedTextCommand())
                )
                console.log('register hotkey success', hotkey)
            } catch (e) {
                console.error('register hotkey failed', hotkey, e)
                sendNotification({
                    title: 'Hotkey bind failed',
                    body: `Failed to bind hotkey: ${hotkey}`,
                })
            }
        }
    }

    if (rawDisplay) {
        if (isMissingNormalKey(rawDisplay)) {
            sendNotification({
                title: 'Cannot bind hotkey',
                body: `Hotkey must contain at least one normal key: ${rawDisplay}`,
            })
        } else {
            const hotkey = normalizeTauriHotkey(rawDisplay)
            try {
                await register(hotkey, (event) =>
                    onShortcutPressed(event, () => commands.showTranslatorWindowCommand())
                )
                console.log('register display window hotkey success', hotkey)
            } catch (e) {
                console.error('register display window hotkey failed', hotkey, e)
                sendNotification({
                    title: 'Hotkey bind failed',
                    body: `Failed to bind hotkey: ${hotkey}`,
                })
            }
        }
    }
}

/** @deprecated 请使用 syncGlobalHotkeysFromSettings */
export async function bindHotkey() {
    await syncGlobalHotkeysFromSettings()
}

/** @deprecated 请使用 syncGlobalHotkeysFromSettings */
export async function bindDisplayWindowHotkey() {
    await syncGlobalHotkeysFromSettings()
}

export function onSettingsSave(_oldSettings: ISettings) {
    void _oldSettings
    events.configUpdatedEvent.emit()
    void syncGlobalHotkeysFromSettings()
}
