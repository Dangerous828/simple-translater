import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createUseStyles } from 'react-jss'
import { useTranslation } from 'react-i18next'
import { Input } from 'baseui-sd/input'
import { Button } from 'baseui-sd/button'
import { Checkbox } from 'baseui-sd/checkbox'
import { Select, type Value } from 'baseui-sd/select'
import toast from 'react-hot-toast/headless'
import { MdArrowBack, MdSave } from 'react-icons/md'
import { invoke } from '@tauri-apps/api/core'
import { listen, type Event } from '@tauri-apps/api/event'

import { useTheme } from '../hooks/useTheme'
import { useThemeType } from '../hooks/useThemeType'
import type { ISettings, ThemeType } from '../types'
import { getSettings, isMacOS, setSettings } from '../utils'
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

const HEADER_HEIGHT_PX = 56

const PROVIDER_OPTIONS: Array<{ label: string; id: ISettings['provider'] }> = [
    { label: '标准模式（推荐，本地 Python）', id: 'Standard' },
    { label: 'Ollama（可选）', id: 'Ollama' },
]

type StylesProps = {
    bg: string
    border: string
    cardBg: string
    muted: string
    titleColor: string
    topOffsetPx: number
    primary: string
}

const useStyles = createUseStyles<string, StylesProps>({
    'page': (p) => ({
        background: p.bg,
        minHeight: '100%',
    }),
    'header': (p) => ({
        position: 'fixed',
        top: `${p.topOffsetPx}px`,
        left: 0,
        right: 0,
        height: `${HEADER_HEIGHT_PX}px`,
        // Must be above Window titlebar background on macOS.
        zIndex: 2147483647,
        background: p.bg,
        borderBottom: `1px solid ${p.border}`,
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
    }),
    'headerInner': {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        gap: 12,
    },
    'headerLeft': {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
    },
    'title': (p) => ({
        color: p.titleColor,
        fontWeight: 750,
        letterSpacing: '-0.01em',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
    }),
    'headerRight': {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
    },
    'content': () => ({
        padding: 16,
        // The fixed header is already offset by `topOffsetPx` (macOS traffic-lights).
        // The Window component also reserves the safe area via paddingTop, so only reserve header height here.
        paddingTop: HEADER_HEIGHT_PX,
    }),
    'grid': {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: 14,
        alignItems: 'start',
    },
    'card': (p) => ({
        background: p.cardBg,
        border: `1px solid ${p.border}`,
        borderRadius: 16,
        padding: 14,
        boxShadow: '0 8px 26px rgba(0,0,0,0.06)',
    }),
    'cardTitle': (p) => ({
        color: p.titleColor,
        fontWeight: 750,
        letterSpacing: '-0.01em',
        marginBottom: 10,
    }),
    'field': {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginTop: 12,
    },
    'hotkeyInputShell': {
        width: '100%',
    },
    'label': (p) => ({
        color: p.titleColor,
        fontWeight: 650,
    }),
    'help': (p) => ({
        color: p.muted,
        fontSize: 12,
        lineHeight: 1.45,
    }),
    'error': {
        color: '#dc2626',
        fontSize: 12,
        lineHeight: 1.45,
    },
    'progressButtonWrap': {
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 10,
        display: 'inline-flex',
        width: 'fit-content',
        maxWidth: '100%',
    },
    'progressFill': (p) => ({
        position: 'absolute',
        inset: 0,
        width: '0%',
        background: `linear-gradient(90deg, ${p.primary} 0%, rgba(255,255,255,0.0) 100%)`,
        opacity: 0.18,
        transformOrigin: 'left center',
        pointerEvents: 'none',
        transition: 'width 240ms ease',
    }),
    'progressFillIndeterminate': (p) => ({
        position: 'absolute',
        inset: 0,
        background: `linear-gradient(90deg, rgba(255,255,255,0) 0%, ${p.primary} 35%, rgba(255,255,255,0) 70%)`,
        opacity: 0.18,
        pointerEvents: 'none',
        animation: '$progressSweep 1.2s ease-in-out infinite',
    }),
    'progressContent': {
        position: 'relative',
        zIndex: 1,
    },
    '@keyframes progressSweep': {
        '0%': { transform: 'translateX(-80%)' },
        '100%': { transform: 'translateX(80%)' },
    },
    'footer': (p) => ({
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
        primary: theme.colors.primary,
    })

    const [capturing, setCapturing] = useState(false)
    const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

    return (
        <div className={styles.field}>
            <div className={styles.label}>{props.label}</div>
            {/* Base UI Input typings omit onMouseDown; shell handles re-capture click. */}
            <div
                className={styles.hotkeyInputShell}
                onMouseDown={() => {
                    setCapturing(true)
                    inputRef.current?.focus()
                }}
            >
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
                        // Exit capture mode after a successful capture so users can click again to re-capture.
                        setCapturing(false)
                        inputRef.current?.blur()
                    }}
                    onChange={(e) => props.onChange((e.target as HTMLInputElement).value)}
                />
            </div>
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
    const topOffsetPx = isMacOS ? 46 : 0
    const styles = useStyles({
        bg: theme.colors.backgroundPrimary,
        border: theme.colors.borderTransparent ?? 'rgba(0,0,0,0.08)',
        cardBg: theme.colors.backgroundPrimary,
        muted: theme.colors.contentSecondary,
        titleColor: theme.colors.contentPrimary,
        topOffsetPx,
        primary: theme.colors.primary,
    })
    const { refreshThemeType } = useThemeType()

    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [oldSettings, setOldSettings] = useState<ISettings | null>(null)
    const [draft, setDraft] = useState<Partial<ISettings>>({})
    const [stdPreparing, setStdPreparing] = useState(false)
    const [stdStep, setStdStep] = useState<
        'idle' | 'creatingVenv' | 'upgradingPip' | 'installingDeps' | 'downloadingModel' | 'verifying' | 'done'
    >('idle')
    const stdStepRef = useRef<
        'idle' | 'creatingVenv' | 'upgradingPip' | 'installingDeps' | 'downloadingModel' | 'verifying' | 'done'
    >('idle')
    const [stdProgress, setStdProgress] = useState(0)
    const stdProgressTimerRef = useRef<number | null>(null)
    const [stdStatus, setStdStatus] = useState<{ pythonReady: boolean; modelReady: boolean; modelPath: string } | null>(
        null
    )
    const [stdStatusRefreshing, setStdStatusRefreshing] = useState(false)
    const stdStatusRefreshingRef = useRef(false)
    const [stdRuntimeInfo, setStdRuntimeInfo] = useState<{
        daemonRunning: boolean
        threads: number
        gpuLayers: number
        batch: number
        ctx: number
    } | null>(null)
    const [stdDownloadLog, setStdDownloadLog] = useState<string>('')

    const refreshStdStatus = useCallback(
        async ({ silent = false }: { silent?: boolean } = {}) => {
            if (stdStatusRefreshingRef.current) return
            stdStatusRefreshingRef.current = true
            setStdStatusRefreshing(true)
            const toastId = 'std-status-refresh'
            if (!silent) {
                toast.loading('刷新中…', { id: toastId })
            }
            try {
                const r = (await invoke('standard_status')) as {
                    python_ready: boolean
                    model_ready: boolean
                    model_path: string
                }
                setStdStatus({
                    pythonReady: !!r.python_ready,
                    modelReady: !!r.model_ready,
                    modelPath: String(r.model_path ?? ''),
                })
                if (!silent) {
                    toast.success('已刷新标准模式状态', { id: toastId })
                }
            } catch (e) {
                console.debug('[settings] standard_status failed', e)
                const msg = e instanceof Error ? e.message : String(e)
                if (!silent) {
                    toast.error(`刷新失败：${msg}`, { id: toastId })
                }
            } finally {
                stdStatusRefreshingRef.current = false
                setStdStatusRefreshing(false)
            }
        },
        [] // stable reference — no state deps
    )

    const refreshStdRuntimeInfo = useCallback(async () => {
        try {
            const r = (await invoke('standard_runtime_info')) as {
                daemon_running: boolean
                threads: number
                gpu_layers: number
                batch: number
                ctx: number
            }
            setStdRuntimeInfo({
                daemonRunning: !!r.daemon_running,
                threads: Number(r.threads ?? 0),
                gpuLayers: Number(r.gpu_layers ?? 0),
                batch: Number(r.batch ?? 0),
                ctx: Number(r.ctx ?? 0),
            })
        } catch (e) {
            console.debug('[settings] standard_runtime_info failed', e)
        }
    }, [])

    const keepAlive = (draft.ollamaModelLifetimeInMemory ?? '').trim()
    const keepAliveInvalid = keepAlive.length > 0 && !isValidOllamaKeepAlive(keepAlive)

    useEffect(() => {
        let mounted = true
        ;(async () => {
            const s = await getSettings()
            if (!mounted) return
            setOldSettings(s)
            // Migration: older builds forced provider to Ollama.
            // Default experience should be Standard mode; users can switch back to Ollama explicitly.
            setDraft({
                ...s,
                provider: (s.provider === 'Ollama' ? 'Standard' : s.provider ?? 'Standard') as ISettings['provider'],
            })
            setLoading(false)
            void refreshStdStatus({ silent: true })
            void refreshStdRuntimeInfo()
        })().catch(console.error)
        return () => {
            mounted = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const themeValue: Value = useMemo(() => {
        const id = (draft.themeType ?? 'followTheSystem') as ThemeType
        const label = THEME_OPTIONS.find((o) => o.id === id)?.label ?? id
        return [{ id, label }]
    }, [draft.themeType])

    const providerValue: Value = useMemo(() => {
        const id = (draft.provider ?? 'Standard') as ISettings['provider']
        const label = PROVIDER_OPTIONS.find((o) => o.id === id)?.label ?? id
        return [{ id, label }]
    }, [draft.provider])

    const isOllama = (draft.provider ?? 'Standard') === 'Ollama'

    const setStdStepSafe = useCallback(
        (
            next:
                | 'idle'
                | 'creatingVenv'
                | 'upgradingPip'
                | 'installingDeps'
                | 'downloadingModel'
                | 'verifying'
                | 'done'
        ) => {
            stdStepRef.current = next
            setStdStep(next)
        },
        []
    )

    const prepareStandard = useCallback(async () => {
        if (stdPreparing) return
        setStdPreparing(true)
        setStdStepSafe('creatingVenv')
        setStdProgress(0)
        setStdDownloadLog('')
        if (stdProgressTimerRef.current) {
            window.clearInterval(stdProgressTimerRef.current)
            stdProgressTimerRef.current = null
        }
        // Listen for detailed download log messages from the Rust backend
        const unlistenLogHolder: { fn: (() => void) | null } = { fn: null }
        listen<{ message: string }>('standard-model-download-log', (ev) => {
            setStdDownloadLog(ev.payload.message)
        })
            .then((fn_) => {
                unlistenLogHolder.fn = fn_
            })
            .catch(console.error)
        stdProgressTimerRef.current = window.setInterval(() => {
            setStdProgress((p) => {
                const step = stdStepRef.current
                const cap =
                    step === 'creatingVenv'
                        ? 0.18
                        : step === 'upgradingPip'
                        ? 0.28
                        : step === 'installingDeps'
                        ? 0.55
                        : step === 'downloadingModel'
                        ? 0.92
                        : step === 'verifying'
                        ? 0.97
                        : 1
                const next = Math.min(cap, p + 0.015)
                return next
            })
        }, 180)
        try {
            // Phase 1: python runtime + venv + pip
            setStdStepSafe('upgradingPip')
            await invoke('ensure_python_runtime')
            // For UX: show a distinct "installing deps" stage even though pip runs inside ensure_python_runtime.
            // This is a pseudo-stage but makes the progress feel consistent.
            setStdStepSafe('installingDeps')
            // Phase 2: model download (Rust 流式下载 + 事件进度；不用 Python 子进程，避免管道阻塞)
            setStdStepSafe('downloadingModel')
            if (stdProgressTimerRef.current) {
                window.clearInterval(stdProgressTimerRef.current)
                stdProgressTimerRef.current = null
            }
            const unlistenDl = await listen<{ received: number; total: number | null }>(
                'standard-model-download-progress',
                (ev: Event<{ received: number; total: number | null }>) => {
                    const { received, total } = ev.payload
                    if (typeof total === 'number' && total > 0) {
                        setStdProgress(0.55 + 0.37 * Math.min(1, received / total))
                    } else {
                        const guessTotal = 1.45e9
                        setStdProgress(0.55 + 0.37 * Math.min(0.97, received / guessTotal))
                    }
                }
            )
            try {
                const hfRaw = (draft.hfEndpoint ?? '').trim()
                await invoke('ensure_model', { hfEndpoint: hfRaw.length > 0 ? hfRaw : null })
            } finally {
                unlistenDl()
            }
            // Phase 3: verify status
            setStdStepSafe('verifying')
            setStdProgress(1)
            void refreshStdStatus({ silent: true })
            toast.success('标准模式已准备完成（Python/模型就绪）')
            setStdStepSafe('done')
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            toast.error(`标准模式准备失败：${msg}`)
        } finally {
            setStdPreparing(false)
            if (stdProgressTimerRef.current) {
                window.clearInterval(stdProgressTimerRef.current)
                stdProgressTimerRef.current = null
            }
            if (unlistenLogHolder.fn) {
                unlistenLogHolder.fn()
            }
            window.setTimeout(() => {
                setStdStepSafe('idle')
                setStdProgress(0)
            }, 700)
        }
    }, [draft.hfEndpoint, refreshStdStatus, setStdStepSafe, stdPreparing])

    const save = useCallback(async () => {
        if (!oldSettings) return
        setSaving(true)
        try {
            if (isOllama && keepAliveInvalid) {
                toast.error('模型存活时间格式不正确（例如 5m / 1h / 30s / 0）')
                return
            }
            await setSettings({
                provider: (draft.provider ?? 'Standard') as ISettings['provider'],
                themeType: draft.themeType ?? oldSettings.themeType,
                enableBackgroundBlur: !!draft.enableBackgroundBlur,
                hotkey: draft.hotkey ?? '',
                displayWindowHotkey: draft.displayWindowHotkey ?? '',
                autoHideWindowWhenOutOfFocus: !!draft.autoHideWindowWhenOutOfFocus,
                ollamaAPIURL: draft.ollamaAPIURL ?? 'http://127.0.0.1:11434',
                ollamaAPIModel: draft.ollamaAPIModel ?? 'llama3.1',
                ollamaCustomModelName: draft.ollamaCustomModelName ?? '',
                ollamaModelLifetimeInMemory: draft.ollamaModelLifetimeInMemory ?? '5m',
                hfEndpoint: (draft.hfEndpoint ?? '').trim(),
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
    }, [draft, isOllama, keepAliveInvalid, oldSettings, onSave, refreshThemeType, t])

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
                                disabled={isOllama && keepAliveInvalid}
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
                        <div className={styles.cardTitle}>提供商</div>

                        <div className={styles.field}>
                            <div className={styles.label}>默认提供商</div>
                            <Select
                                value={providerValue}
                                clearable={false}
                                searchable={false}
                                options={PROVIDER_OPTIONS}
                                onChange={(params) => {
                                    const next = (params.value?.[0]?.id ?? 'Standard') as ISettings['provider']
                                    setDraft((d) => ({ ...d, provider: next }))
                                    // Apply immediately so Translator uses it without requiring an extra Save click.
                                    setSettings({ provider: next }).catch(console.error)
                                    toast.success(`已切换为：${next === 'Standard' ? '标准模式' : 'Ollama'}`)
                                }}
                            />
                            <div className={styles.help}>
                                标准模式会自动准备 Python 环境与下载模型；如你已安装 Ollama，可切换到 Ollama。
                            </div>
                        </div>
                    </div>

                    <div className={styles.card}>
                        <div className={styles.cardTitle}>标准模式（本地 Python）</div>

                        <div className={styles.field}>
                            <div className={styles.label}>默认模型（HuggingFace）</div>
                            <Input value='tencent/HY-MT1.5-1.8B-GGUF (HY-MT1.5-1.8B-Q4_K_M.gguf)' disabled />
                            <div className={styles.help}>
                                首次使用会自动下载到本机缓存目录。模型较大，准备时间取决于网络与磁盘速度。
                            </div>
                        </div>

                        <div className={styles.field}>
                            <div className={styles.label}>Hugging Face 下载地址（可选）</div>
                            <Input
                                value={draft.hfEndpoint ?? ''}
                                onChange={(e) =>
                                    setDraft((d) => ({ ...d, hfEndpoint: (e.target as HTMLInputElement).value }))
                                }
                                placeholder='默认：https://huggingface.co'
                                clearOnEscape
                            />
                            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                <Button
                                    kind='tertiary'
                                    size='compact'
                                    type='button'
                                    onClick={() => setDraft((d) => ({ ...d, hfEndpoint: 'https://hf-mirror.com' }))}
                                >
                                    填入 hf-mirror 镜像
                                </Button>
                                <Button
                                    kind='tertiary'
                                    size='compact'
                                    type='button'
                                    onClick={() => setDraft((d) => ({ ...d, hfEndpoint: '' }))}
                                >
                                    恢复官方地址
                                </Button>
                            </div>
                            <div className={styles.help}>
                                无法直连官方站点时，可填镜像根地址（不要带仓库路径）。此处留空时，会依次使用系统环境变量
                                HF_ENDPOINT（若已配置）、否则使用官方 huggingface.co。
                            </div>
                        </div>

                        <div className={styles.field}>
                            <div className={styles.label}>当前状态</div>
                            <div className={styles.help}>
                                Python：{stdStatus?.pythonReady ? '已就绪' : '未就绪'}；模型：
                                {stdStatus?.modelReady ? '已就绪' : '未就绪'}
                                {stdStatus?.modelPath ? (
                                    <div style={{ marginTop: 6, wordBreak: 'break-all' }}>
                                        模型路径：{stdStatus.modelPath}
                                    </div>
                                ) : null}
                                {stdRuntimeInfo ? (
                                    <div style={{ marginTop: 8 }}>
                                        后端：{stdRuntimeInfo.daemonRunning ? '常驻服务运行中' : '未启动'}；threads：
                                        {stdRuntimeInfo.threads}；gpu_layers：{stdRuntimeInfo.gpuLayers}；batch：
                                        {stdRuntimeInfo.batch}；ctx：{stdRuntimeInfo.ctx}
                                    </div>
                                ) : null}
                            </div>
                        </div>

                        <div className={styles.field}>
                            {stdStatus?.pythonReady && stdStatus?.modelReady ? (
                                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                                    <Button kind='secondary' size='compact' disabled>
                                        已就绪
                                    </Button>
                                    <Button
                                        kind='tertiary'
                                        size='compact'
                                        isLoading={stdStatusRefreshing}
                                        onClick={async () => {
                                            await refreshStdStatus({ silent: false })
                                            await refreshStdRuntimeInfo()
                                        }}
                                    >
                                        重新检查
                                    </Button>
                                    <Button kind='secondary' size='compact' onClick={prepareStandard}>
                                        重新准备
                                    </Button>
                                </div>
                            ) : (
                                <div className={styles.progressButtonWrap}>
                                    {stdPreparing ? (
                                        <div className={styles.progressFillIndeterminate} aria-hidden='true' />
                                    ) : null}
                                    <div
                                        className={styles.progressFill}
                                        style={{ width: `${Math.round(stdProgress * 100)}%` }}
                                        aria-hidden='true'
                                    />
                                    <div className={styles.progressContent}>
                                        <Button
                                            kind='primary'
                                            size='compact'
                                            isLoading={false}
                                            disabled={stdPreparing}
                                            onClick={prepareStandard}
                                        >
                                            {stdPreparing
                                                ? stdStep === 'downloadingModel'
                                                    ? '下载模型中…'
                                                    : stdStep === 'creatingVenv'
                                                    ? '创建环境中…'
                                                    : stdStep === 'upgradingPip'
                                                    ? '升级 pip 中…'
                                                    : stdStep === 'installingDeps'
                                                    ? '安装依赖中…'
                                                    : stdStep === 'verifying'
                                                    ? '校验中…'
                                                    : '准备中…'
                                                : '一键准备（安装依赖 + 下载模型）'}
                                        </Button>
                                    </div>
                                </div>
                            )}
                            <div className={styles.help}>
                                如果你打包了内置 Python，此按钮会创建 venv 并安装依赖；随后下载模型。
                                {stdPreparing ? (
                                    <div style={{ marginTop: 6 }}>
                                        pip 日志在<strong>启动本应用的终端</strong>；模型下载使用上方「Hugging Face
                                        下载地址」或官方站点，进度条随已下载字节更新。
                                    </div>
                                ) : null}
                                {stdDownloadLog ? (
                                    <div
                                        style={{
                                            marginTop: 8,
                                            padding: '6px 10px',
                                            borderRadius: 8,
                                            background: 'rgba(128,128,128,0.1)',
                                            fontFamily: 'monospace',
                                            fontSize: 11,
                                            lineHeight: 1.5,
                                            wordBreak: 'break-all',
                                            whiteSpace: 'pre-wrap',
                                        }}
                                    >
                                        {stdDownloadLog}
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    </div>

                    {isOllama ? (
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
                                        setDraft((d) => ({
                                            ...d,
                                            ollamaAPIModel: (e.target as HTMLInputElement).value,
                                        }))
                                    }
                                    placeholder='llama3.1'
                                    clearOnEscape
                                />
                                <div className={styles.help}>
                                    {t('Tip')}: {t('You can also use')} <code>{CUSTOM_MODEL_ID}</code> + custom model
                                    name.
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
                                <div className={styles.label}>
                                    {t('The survival time of the Ollama model in memory')}
                                </div>
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
                                    {t('Tip')}: 例如 <code>5m</code> / <code>1h</code> / <code>30s</code> /{' '}
                                    <code>0</code>
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
                    ) : null}

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
