import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createUseStyles } from 'react-jss'
import { useTranslation } from 'react-i18next'
import { Input } from 'baseui-sd/input'
import { Button } from 'baseui-sd/button'
import { Checkbox } from 'baseui-sd/checkbox'
import { Select, type Value } from 'baseui-sd/select'
import toast from 'react-hot-toast/headless'
import { MdArrowBack, MdSave } from 'react-icons/md'

import { useTheme } from '../hooks/useTheme'
import { useThemeType } from '../hooks/useThemeType'
import type { ISettings, ThemeType } from '../types'
import { getSettings, setSettings } from '../utils'
import { CUSTOM_MODEL_ID } from '../constants'

export interface InnerSettingsProps {
    showFooter?: boolean
    onSave?: (oldSettings: ISettings) => void
    onBack?: () => void
}

const THEME_OPTIONS: Array<{ label: string; id: ThemeType }> = [
    { label: 'Follow system', id: 'followTheSystem' },
    { label: 'Light', id: 'light' },
    { label: 'Dark', id: 'dark' },
]

const HEADER_HEIGHT_PX = 0

type StylesProps = {
    bg: string
    border: string
    cardBg: string
    muted: string
    titleColor: string
    topOffsetPx: number
}

const useStyles = createUseStyles<string, StylesProps>({
    page: (p) => ({
        background: p.bg,
        minHeight: '100%',
    }),
    header: (p) => ({
        position: 'fixed',
        top: `${p.topOffsetPx}px`,
        left: 0,
        right: 0,
        height: `${HEADER_HEIGHT_PX}px`,
        zIndex: 500,
        background: p.bg,
        borderBottom: `1px solid ${p.border}`,
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
    }),
    headerInner: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        gap: 12,
    },
    headerLeft: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
    },
    title: (p) => ({
        color: p.titleColor,
        fontWeight: 750,
        letterSpacing: '-0.01em',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
    }),
    headerRight: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
    },
    content: (p) => ({
        padding: 16,
        paddingTop: p.topOffsetPx + HEADER_HEIGHT_PX + 16,
    }),
    grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: 14,
        alignItems: 'start',
    },
    card: (p) => ({
        background: p.cardBg,
        border: `1px solid ${p.border}`,
        borderRadius: 16,
        padding: 14,
        boxShadow: '0 8px 26px rgba(0,0,0,0.06)',
    }),
    cardTitle: (p) => ({
        color: p.titleColor,
        fontWeight: 750,
        letterSpacing: '-0.01em',
        marginBottom: 10,
    }),
    field: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginTop: 12,
    },
    label: (p) => ({
        color: p.titleColor,
        fontWeight: 650,
    }),
    help: (p) => ({
        color: p.muted,
        fontSize: 12,
        lineHeight: 1.45,
    }),
    error: {
        color: '#dc2626',
        fontSize: 12,
        lineHeight: 1.45,
    },
    footer: (p) => ({
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        padding: '12px 16px',
        background: p.bg,
        borderTop: `1px solid ${p.border}`,
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 10,
        zIndex: 400,
    }),
})

function normalizeHotkeyFromEvent(e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): string | null {
    const key = e.key
    if (key === 'Backspace' || key === 'Delete') return ''
    if (key === 'Escape') return null

    const tokens: string[] = []
    if (e.metaKey || e.ctrlKey) tokens.push('CmdOrCtrl')
    if (e.shiftKey) tokens.push('Shift')
    if (e.altKey) tokens.push('Alt')

    const isPureModifier = key === 'Meta' || key === 'Control' || key === 'Shift' || key === 'Alt'
    if (isPureModifier) return null

    const normalizedKey = (() => {
        if (key.length === 1) return key.toUpperCase()
        if (key === ' ') return 'Space'
        if (key === 'Enter') return 'Enter'
        if (key === 'Tab') return 'Tab'
        if (key === 'ArrowUp') return 'Up'
        if (key === 'ArrowDown') return 'Down'
        if (key === 'ArrowLeft') return 'Left'
        if (key === 'ArrowRight') return 'Right'
        if (/^F\\d{1,2}$/.test(key)) return key.toUpperCase()
        return key
    })()

    tokens.push(normalizedKey)
    return tokens.join('+')
}

function isValidOllamaKeepAlive(value: string): boolean {
    const v = value.trim()
    if (!v) return false
    if (v === '0') return true
    return /^\\d+\\s*(ms|s|m|h|d|w)$/.test(v)
}

function HotkeyCaptureInput(props: {
    label: string
    value: string
    placeholder?: string
    onChange: (value: string) => void
    help?: React.ReactNode
}) {
    const { theme } = useTheme()
    const { t } = useTranslation()
    const styles = useStyles({
        bg: theme.colors.backgroundPrimary,
        border: theme.colors.borderTransparent ?? 'rgba(0,0,0,0.08)',
        cardBg: theme.colors.backgroundPrimary,
        muted: theme.colors.contentSecondary,
        titleColor: theme.colors.contentPrimary,
        topOffsetPx: 0,
    })

    const [capturing, setCapturing] = useState(false)
    const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

    return (
        <div className={styles.field}>
            <div className={styles.label}>{props.label}</div>
            <Input
                inputRef={inputRef}
                value={props.value}
                placeholder={props.placeholder}
                clearOnEscape
                onFocus={() => setCapturing(true)}
                onBlur={() => setCapturing(false)}
                onKeyDown={(e) => {
                    if (!capturing) return
                    e.preventDefault()
                    e.stopPropagation()
                    const normalized = normalizeHotkeyFromEvent(e)
                    if (normalized === null) return
                    props.onChange(normalized)
                }}
                onChange={(e) => props.onChange((e.target as HTMLInputElement).value)}
            />
            <div className={styles.help}>
                {capturing ? t('Please press the hotkey you want to set.') : t('Click above to set hotkeys.')}
                {props.help ? <div style={{ marginTop: 4 }}>{props.help}</div> : null}
            </div>
        </div>
    )
}

export function InnerSettings({ showFooter, onSave, onBack }: InnerSettingsProps) {
    const { t } = useTranslation()
    const { theme } = useTheme()
    // Window already reserves the macOS traffic-lights safe area.
    const topOffsetPx = 0
    const styles = useStyles({
        bg: theme.colors.backgroundPrimary,
        border: theme.colors.borderTransparent ?? 'rgba(0,0,0,0.08)',
        cardBg: theme.colors.backgroundPrimary,
        muted: theme.colors.contentSecondary,
        titleColor: theme.colors.contentPrimary,
        topOffsetPx,
    })
    const { refreshThemeType } = useThemeType()

    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [oldSettings, setOldSettings] = useState<ISettings | null>(null)
    const [draft, setDraft] = useState<Partial<ISettings>>({})

    const keepAlive = (draft.ollamaModelLifetimeInMemory ?? '').trim()
    const keepAliveInvalid = keepAlive.length > 0 && !isValidOllamaKeepAlive(keepAlive)

    useEffect(() => {
        let mounted = true
        ;(async () => {
            const s = await getSettings()
            if (!mounted) return
            setOldSettings(s)
            setDraft(s)
            setLoading(false)
        })().catch(console.error)
        return () => {
            mounted = false
        }
    }, [])

    const themeValue: Value = useMemo(() => {
        const id = (draft.themeType ?? 'followTheSystem') as ThemeType
        const label = THEME_OPTIONS.find((o) => o.id === id)?.label ?? id
        return [{ id, label }]
    }, [draft.themeType])

    const save = useCallback(async () => {
        if (!oldSettings) return
        setSaving(true)
        try {
            if (keepAliveInvalid) {
                toast.error('模型存活时间格式不正确（例如 5m / 1h / 30s / 0）')
                return
            }
            await setSettings({
                provider: 'Ollama',
                themeType: draft.themeType ?? oldSettings.themeType,
                enableBackgroundBlur: !!draft.enableBackgroundBlur,
                hotkey: draft.hotkey ?? '',
                displayWindowHotkey: draft.displayWindowHotkey ?? '',
                autoHideWindowWhenOutOfFocus: !!draft.autoHideWindowWhenOutOfFocus,
                ollamaAPIURL: draft.ollamaAPIURL ?? 'http://127.0.0.1:11434',
                ollamaAPIModel: draft.ollamaAPIModel ?? 'llama3.1',
                ollamaCustomModelName: draft.ollamaCustomModelName ?? '',
                ollamaModelLifetimeInMemory: draft.ollamaModelLifetimeInMemory ?? '5m',
            })
            await refreshThemeType()
            onSave?.(oldSettings)
            const updated = await getSettings()
            setOldSettings(updated)
            setDraft(updated)
            toast.success(t('Saved'))
        } catch (e) {
            console.error(e)
            toast.error(t('Save failed'))
        } finally {
            setSaving(false)
        }
    }, [draft, keepAliveInvalid, oldSettings, onSave, refreshThemeType, t])

    if (loading || !oldSettings) {
        return <div style={{ padding: 16, color: theme.colors.contentSecondary }}>{t('Loading')}...</div>
    }

    return (
        <div className={styles.page}>
            <div className={styles.header} data-tauri-drag-ignore='true'>
                <div className={styles.headerInner}>
                    <div className={styles.headerLeft}>
                        {onBack ? (
                            <Button kind='secondary' size='compact' onClick={onBack}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                    <MdArrowBack size={16} />
                                    返回
                                </span>
                            </Button>
                        ) : null}
                        <div className={styles.title}>{t('Settings')}</div>
                    </div>
                    <div className={styles.headerRight}>
                        {showFooter ? (
                            <Button
                                kind='primary'
                                size='compact'
                                isLoading={saving}
                                disabled={keepAliveInvalid}
                                onClick={save}
                            >
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                    <MdSave size={16} />
                                    {t('Save')}
                                </span>
                            </Button>
                        ) : null}
                    </div>
                </div>
            </div>

            <div className={styles.content}>
                <div className={styles.grid}>
                    <div className={styles.card}>
                        <div className={styles.cardTitle}>Ollama</div>

                        <div className={styles.field}>
                            <div className={styles.label}>Ollama URL</div>
                            <Input
                                value={draft.ollamaAPIURL ?? ''}
                                onChange={(e) =>
                                    setDraft((d) => ({ ...d, ollamaAPIURL: (e.target as HTMLInputElement).value }))
                                }
                                placeholder='http://127.0.0.1:11434'
                                clearOnEscape
                            />
                        </div>

                        <div className={styles.field}>
                            <div className={styles.label}>Ollama Model</div>
                            <Input
                                value={draft.ollamaAPIModel ?? ''}
                                onChange={(e) =>
                                    setDraft((d) => ({ ...d, ollamaAPIModel: (e.target as HTMLInputElement).value }))
                                }
                                placeholder='llama3.1'
                                clearOnEscape
                            />
                            <div className={styles.help}>
                                {t('Tip')}: {t('You can also use')} <code>{CUSTOM_MODEL_ID}</code> + custom model name.
                            </div>
                        </div>

                        {(draft.ollamaAPIModel ?? '') === CUSTOM_MODEL_ID ? (
                            <div className={styles.field}>
                                <div className={styles.label}>Custom model name</div>
                                <Input
                                    value={draft.ollamaCustomModelName ?? ''}
                                    onChange={(e) =>
                                        setDraft((d) => ({
                                            ...d,
                                            ollamaCustomModelName: (e.target as HTMLInputElement).value,
                                        }))
                                    }
                                    placeholder='llama3.1:8b'
                                    clearOnEscape
                                />
                            </div>
                        ) : null}

                        <div className={styles.field}>
                            <div className={styles.label}>{t('The survival time of the Ollama model in memory')}</div>
                            <Input
                                value={draft.ollamaModelLifetimeInMemory ?? ''}
                                onChange={(e) =>
                                    setDraft((d) => ({
                                        ...d,
                                        ollamaModelLifetimeInMemory: (e.target as HTMLInputElement).value,
                                    }))
                                }
                                placeholder='5m'
                                clearOnEscape
                            />
                            <div className={styles.help}>
                                {t('Tip')}: 例如 <code>5m</code> / <code>1h</code> / <code>30s</code> / <code>0</code>
                                （立即卸载）。
                            </div>
                            {keepAliveInvalid ? (
                                <div className={styles.error}>
                                    格式不正确：请输入类似 <code>5m</code> / <code>1h</code> / <code>30s</code> /{' '}
                                    <code>0</code>
                                </div>
                            ) : null}
                        </div>
                    </div>

                    <div className={styles.card}>
                        <div className={styles.cardTitle}>快捷键</div>

                        <HotkeyCaptureInput
                            label='划词翻译快捷键'
                            value={draft.hotkey ?? ''}
                            placeholder='CmdOrCtrl+Shift+E'
                            onChange={(value) => setDraft((d) => ({ ...d, hotkey: value }))}
                            help={<span>用于“划词后唤起并翻译”（全局快捷键）。</span>}
                        />

                        <HotkeyCaptureInput
                            label='显示/隐藏窗口快捷键'
                            value={draft.displayWindowHotkey ?? ''}
                            placeholder='CmdOrCtrl+Shift+D'
                            onChange={(value) => setDraft((d) => ({ ...d, displayWindowHotkey: value }))}
                            help={<span>用于快速显示/隐藏主窗口。</span>}
                        />
                    </div>

                    <div className={styles.card}>
                        <div className={styles.cardTitle}>外观</div>

                        <div className={styles.field}>
                            <div className={styles.label}>{t('Theme')}</div>
                            <Select
                                size='compact'
                                searchable={false}
                                clearable={false}
                                value={themeValue}
                                options={THEME_OPTIONS as unknown as Array<{ label: string; id: string }>}
                                onChange={(params) => {
                                    const id = params.value[0]?.id
                                    if (typeof id !== 'string') return
                                    setDraft((d) => ({ ...d, themeType: id as ThemeType }))
                                }}
                            />
                        </div>

                        <div className={styles.field}>
                            <Checkbox
                                checked={!!draft.enableBackgroundBlur}
                                onChange={(e) =>
                                    setDraft((d) => ({
                                        ...d,
                                        enableBackgroundBlur: (e.target as HTMLInputElement).checked,
                                    }))
                                }
                            >
                                {t('Enable Background Blur')}
                            </Checkbox>
                        </div>
                    </div>

                    <div className={styles.card}>
                        <div className={styles.cardTitle}>行为</div>

                        <div className={styles.field}>
                            <Checkbox
                                checked={!!draft.autoHideWindowWhenOutOfFocus}
                                onChange={(e) =>
                                    setDraft((d) => ({
                                        ...d,
                                        autoHideWindowWhenOutOfFocus: (e.target as HTMLInputElement).checked,
                                    }))
                                }
                            >
                                {t('Auto hide window when out of focus')}
                            </Checkbox>
                        </div>
                    </div>
                </div>
            </div>

            {/* Save button is in header to avoid duplicated CTAs */}
        </div>
    )
}
