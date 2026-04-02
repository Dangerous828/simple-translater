import { isRegistered, register, unregister } from '@tauri-apps/plugin-global-shortcut'
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

export async function bindHotkey(oldHotKey?: string) {
    if (oldHotKey && !isMissingNormalKey(oldHotKey) && (await isRegistered(oldHotKey))) {
        await unregister(oldHotKey)
    }
    const settings = await getSettings()
    if (!settings.hotkey) return
    const hotkey = normalizeTauriHotkey(settings.hotkey)
    if (isMissingNormalKey(settings.hotkey)) {
        sendNotification({
            title: 'Cannot bind hotkey',
            body: `Hotkey must contain at least one normal key: ${settings.hotkey}`,
        })
        return
    }
    if (await isRegistered(hotkey)) {
        await unregister(hotkey)
    }
    try {
        await register(hotkey, () => commands.showTranslatorWindowWithSelectedTextCommand())
        console.log('register hotkey success', hotkey)
    } catch (e) {
        console.error('register hotkey failed', hotkey, e)
        sendNotification({
            title: 'Hotkey bind failed',
            body: `Failed to bind hotkey: ${hotkey}`,
        })
    }
}

export async function bindDisplayWindowHotkey(oldHotKey?: string) {
    if (oldHotKey && !isMissingNormalKey(oldHotKey) && (await isRegistered(oldHotKey))) {
        await unregister(oldHotKey)
    }
    const settings = await getSettings()
    if (!settings.displayWindowHotkey) return
    const hotkey = normalizeTauriHotkey(settings.displayWindowHotkey)
    if (isMissingNormalKey(settings.displayWindowHotkey)) {
        sendNotification({
            title: 'Cannot bind hotkey',
            body: `Hotkey must contain at least one normal key: ${settings.displayWindowHotkey}`,
        })
        return
    }
    if (await isRegistered(hotkey)) {
        await unregister(hotkey)
    }
    try {
        await register(hotkey, () => commands.showTranslatorWindowCommand())
        console.log('register display window hotkey success', hotkey)
    } catch (e) {
        console.error('register display window hotkey failed', hotkey, e)
        sendNotification({
            title: 'Hotkey bind failed',
            body: `Failed to bind hotkey: ${hotkey}`,
        })
    }
}

export function onSettingsSave(oldSettings: ISettings) {
    events.configUpdatedEvent.emit()
    bindHotkey(oldSettings.hotkey)
    bindDisplayWindowHotkey(oldSettings.displayWindowHotkey)
}
