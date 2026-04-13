import { describe, it, expect, vi } from 'vitest'
import React from 'react'

vi.mock('styletron-react', () => ({
    Provider: ({ children }: any) => React.createElement('div', null, children),
}))
vi.mock('baseui-sd', () => ({
    BaseProvider: ({ children }: any) => React.createElement('div', null, children),
}))
vi.mock('baseui-sd/textarea', () => ({
    Textarea: (props: any) => React.createElement('textarea', { value: props.value ?? '' }),
}))
vi.mock('baseui-sd/button', () => ({
    Button: ({ children }: any) => React.createElement('button', null, children),
}))
vi.mock('baseui-sd/select', () => ({ Select: () => null }))
vi.mock('react-hot-toast/headless', () => ({ default: { error: vi.fn() } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock(
    'react-icons/md',
    () =>
        new Proxy(
            {},
            {
                get: (_: any, p: string | symbol) =>
                    typeof p === 'string' && p !== '__esModule' ? () => null : undefined,
            }
        )
)
vi.mock('../../translate', () => ({ translate: vi.fn() }))
vi.mock('../../lang', () => ({
    detectLang: vi.fn().mockResolvedValue('en'),
    targetLanguages: [],
    intoLangCode: (c: string) => c,
}))
vi.mock('../../hooks/useSettings', () => ({
    useSettings: () => ({ settings: { provider: 'OpenAI', defaultTargetLanguage: 'zh-Hans' } }),
}))
vi.mock('../../hooks/useTheme', () => ({
    useTheme: () => ({ theme: { colors: { backgroundPrimary: '#fff', contentPrimary: '#000' } } }),
}))
vi.mock('../../services/history', () => ({ historyService: { create: vi.fn() } }))
vi.mock('../../utils', () => ({ isTauri: () => false }))
vi.mock('@/tauri/bindings', () => ({ commands: { showHistoryWindow: vi.fn() }, events: {} }))
vi.mock('../Settings', () => ({ InnerSettings: () => null }))

// Try importing Translator directly
import { Translator } from '../Translator'

describe('debug', () => {
    it('Translator is a function', () => {
        expect(typeof Translator).toBe('function')
    })
})
