import { useToaster } from 'react-hot-toast/headless'
import { createUseStyles } from 'react-jss'
import clsx from 'clsx'
import { useTheme } from '../hooks/useTheme'

const useStyles = createUseStyles({
    'rootContainer': {
        pointerEvents: 'none',
        zIndex: 2147483647,
        position: 'fixed',
        inset: '16px',
    },
    'container': {
        left: '0px',
        right: '0px',
        top: '0px',
        position: 'absolute',
        transition: 'all 230ms cubic-bezier(0.21, 1.02, 0.73, 1)',
        justifyContent: 'center',
        display: 'flex',
    },
    '@keyframes enter': {
        '0%': { transform: 'translate3d(0,-100%,0) scale(.6)', opacity: '.5' },
        '100%': { transform: 'translate3d(0,0,0) scale(1)', opacity: '1' },
    },
    '@keyframes exit': {
        '0%': { transform: 'translate3d(0,0,-1px) scale(1)', opacity: '1' },
        '100%': { transform: 'translate3d(0,-100%,-1px) scale(.6)', opacity: '0' },
    },
    '@keyframes icon-anim': {
        '0%': {
            transform: 'scale(0.6)',
            opacity: '0.4',
        },
        '100%': {
            transform: 'scale(1)',
            opacity: 1,
        },
    },
    'innerContainer': {
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        background: 'rgba(255, 255, 255, 0.92)',
        color: '#1a1a1a',
        lineHeight: 1.4,
        willChange: 'transform',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.1), 0 1px 4px rgba(0, 0, 0, 0.04), 0 0 0 1px rgba(0, 0, 0, 0.03)',
        maxWidth: '360px',
        pointerEvents: 'auto',
        padding: '12px 16px',
        borderRadius: '14px',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        fontSize: '13px',
        letterSpacing: '-0.01em',
    },
    'innerContainerDark': {
        background: 'rgba(17, 17, 17, 0.72)',
        color: 'rgba(255,255,255,0.92)',
        boxShadow:
            '0 10px 40px rgba(0, 0, 0, 0.45), 0 1px 0 rgba(255,255,255,0.06) inset, 0 0 0 1px rgba(255,255,255,0.08)',
    },
    'enterAnimation': {
        animation: '$enter 0.35s cubic-bezier(.21,1.02,.73,1) forwards',
    },
    'exitAnimation': {
        animation: '$exit 0.4s forwards cubic-bezier(.06,.71,.55,1)',
    },
    'icon': {
        position: 'relative',
        transform: 'scale(0.6)',
        opacity: '0.4',
        minWidth: '20px',
        animation: '$icon-anim 0.3s 0.12s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards',
    },
    'iconPill': {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '22px',
        height: '22px',
        borderRadius: '999px',
    },
    'iconSuccess': {
        background: 'rgba(16, 185, 129, 0.18)',
        color: '#10b981',
    },
    'iconError': {
        background: 'rgba(239, 68, 68, 0.16)',
        color: '#ef4444',
    },
    'iconInfo': {
        background: 'rgba(59, 130, 246, 0.16)',
        color: '#3b82f6',
    },
    'message': {
        display: 'flex',
        justifyContent: 'center',
        margin: '4px 10px',
        color: 'inherit',
        flex: '1 1 auto',
        whiteSpace: 'pre-line',
    },
})

function CheckIcon(props: { size?: number }) {
    const size = props.size ?? 14
    return (
        <svg width={size} height={size} viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
            <path
                d='M20 6L9 17l-5-5'
                stroke='currentColor'
                strokeWidth='2.4'
                strokeLinecap='round'
                strokeLinejoin='round'
            />
        </svg>
    )
}

function XIcon(props: { size?: number }) {
    const size = props.size ?? 14
    return (
        <svg width={size} height={size} viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
            <path
                d='M18 6L6 18M6 6l12 12'
                stroke='currentColor'
                strokeWidth='2.4'
                strokeLinecap='round'
                strokeLinejoin='round'
            />
        </svg>
    )
}

function InfoIcon(props: { size?: number }) {
    const size = props.size ?? 14
    return (
        <svg width={size} height={size} viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
            <path d='M12 17v-6' stroke='currentColor' strokeWidth='2.4' strokeLinecap='round' strokeLinejoin='round' />
            <path d='M12 7h.01' stroke='currentColor' strokeWidth='3.2' strokeLinecap='round' strokeLinejoin='round' />
            <path
                d='M21 12a9 9 0 1 1-18 0a9 9 0 0 1 18 0Z'
                stroke='currentColor'
                strokeWidth='1.8'
                strokeLinecap='round'
                strokeLinejoin='round'
                opacity='0.35'
            />
        </svg>
    )
}

export default function Toaster() {
    const { toasts, handlers } = useToaster()
    const { startPause, endPause, calculateOffset, updateHeight } = handlers
    const styles = useStyles()
    const { themeType } = useTheme()

    return (
        <div onMouseEnter={startPause} onMouseLeave={endPause} className={styles.rootContainer}>
            {toasts.map((toast) => {
                const offset = calculateOffset(toast, {
                    reverseOrder: false,
                    gutter: 8,
                })

                const ref = (el: HTMLDivElement | null) => {
                    if (el && typeof toast.height !== 'number') {
                        const height = el.getBoundingClientRect().height
                        updateHeight(toast.id, height)
                    }
                }

                return (
                    <div
                        key={toast.id}
                        ref={ref}
                        {...toast.ariaProps}
                        className={styles.container}
                        style={{ transform: `translateY(${offset}px)` }}
                    >
                        <div
                            className={clsx(styles.innerContainer, themeType === 'dark' && styles.innerContainerDark, {
                                [styles.enterAnimation]: toast.visible,
                                [styles.exitAnimation]: !toast.visible,
                            })}
                        >
                            <div className={styles.icon}>
                                {toast.icon ?? (
                                    <span
                                        className={clsx(
                                            styles.iconPill,
                                            toast.type === 'success'
                                                ? styles.iconSuccess
                                                : toast.type === 'error'
                                                  ? styles.iconError
                                                  : styles.iconInfo
                                        )}
                                    >
                                        {toast.type === 'success' ? (
                                            <CheckIcon />
                                        ) : toast.type === 'error' ? (
                                            <XIcon />
                                        ) : (
                                            <InfoIcon />
                                        )}
                                    </span>
                                )}
                            </div>
                            <div className={styles.message} role='status' aria-live='polite'>
                                {toast.message?.toString()}
                            </div>
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
