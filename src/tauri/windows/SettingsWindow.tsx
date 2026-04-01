import { InnerSettings } from '../../common/components/Settings'
import { Window } from '../components/Window'
import { onSettingsSave } from '../utils'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

export function SettingsWindow() {
    const appWindow = WebviewWindow.getCurrent()
    return (
        <Window windowsTitlebarDisableDarkMode>
            <InnerSettings
                showFooter
                onBack={() => {
                    void appWindow.close()
                }}
                onSave={onSettingsSave}
            />
        </Window>
    )
}
