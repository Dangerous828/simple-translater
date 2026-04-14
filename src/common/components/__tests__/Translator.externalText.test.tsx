import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
// @ts-expect-error fast-check may not be installed
import fc from 'fast-check'

// --- Mocks (same pattern as minimal.test.tsx) ---

vi.mock('styletron-engine-atomic', () => ({
    Client: class {
        renderStyle() {
            return ''
        }
    },
}))
vi.mock('styletron-react', () => ({
    Provider: ({ children }: any) => React.createElement('div', null, children),
}))
vi.mock('baseui-sd', () => ({
    BaseProvider: ({ children }: any) => React.createElement('div', null, children),
}))
vi.mock('baseui-sd/textarea', () => ({
    Textarea: (props: any) =>
        React.createElement('textarea', {
            'value': props.value ?? '',
            'onChange': props.onChange,
            'data-testid': props.placeholder === 'Enter text to translate' ? 'source-textarea' : 'result-textarea',
        }),
}))
vi.mock('baseui-sd/button', () => ({
    Button: ({ children, onClick }: any) => React.createElement('button', { onClick }, children),
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
vi.mock('../../internal-services/db', () => ({}))
vi.mock('../../services/history', () => ({ historyService: { create: vi.fn() } }))
vi.mock('../../utils', () => ({ isTauri: () => false }))
vi.mock('@/tauri/bindings', () => ({ commands: { showHistoryWindow: vi.fn() }, events: {} }))
vi.mock('../Settings', () => ({ InnerSettings: () => null }))

// --- Import after mocks ---

import { Translator } from '../Translator'
import { setExternalOriginalText, useTranslatorStore } from '../../store'
import { Client } from 'styletron-engine-atomic'

const engine = new Client()

/**
 * **Validates: Requirements 1.1, 1.2, 2.1, 2.2**
 *
 * Property 1: Bug Condition — externalOriginalText 未同步到 Translator 输入框
 *
 * For any non-empty trimmed string set via setExternalOriginalText,
 * the Translator textarea should display that string.
 *
 * On UNFIXED code this test is EXPECTED TO FAIL because Translator
 * never subscribes to the externalOriginalText store.
 */
describe('Bug Condition: externalOriginalText sync to Translator textarea', () => {
    beforeEach(() => {
        // Reset store before each test
        useTranslatorStore.setState({ externalOriginalText: undefined })
    })

    it('property: any non-empty trimmed string set via setExternalOriginalText appears in textarea', () => {
        fc.assert(
            fc.property(
                fc
                    .string({ minLength: 1 })
                    .map((s: string) => s.trim())
                    .filter((s: string) => s.length > 0),
                (text: string) => {
                    // Set external text in store BEFORE render
                    act(() => {
                        setExternalOriginalText(text)
                    })

                    const { unmount, getByTestId } = render(<Translator uuid='test-uuid' engine={engine} />)

                    const textarea = getByTestId('source-textarea') as HTMLTextAreaElement

                    // Bug condition: textarea value should equal the external text
                    // On unfixed code, textarea will be '' because Translator never reads the store
                    expect(textarea.value).toBe(text)

                    unmount()
                }
            ),
            { numRuns: 50 }
        )
    })
})
