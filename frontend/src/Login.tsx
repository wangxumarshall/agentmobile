import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from './icons'
import { switchInstanceById, LOCAL_INSTANCE_ID } from './remoteInstance'

// 登录页始终走本端 /api/auth/login，不通过远端代理
const LOCAL_API_BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

interface PublicInstance {
  id: string
  label: string
}

interface Props {
  onLogin: (token: string) => void
}

/**
 * agentmobile — Login entry
 * Aesthetic: Terminal hard-core × precision instrument.
 * Layered radial gradients + dot grid + scanline; glass card with backdrop-blur;
 * mono-vs-sans type pairing; staggered entrance; password visibility toggle;
 * shake on error; hover-glow submit. No external deps.
 */
export default function Login({ onLogin }: Props) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [remoteList, setRemoteList] = useState<PublicInstance[]>([])
  // 选中的远端实例：登录成功后切换到此实例（'local' 或 null = 不切换）
  const [pendingRemoteId, setPendingRemoteId] = useState<string | null>(null)

  // Re-mount the error node when message changes so the shake animation retriggers
  const [errorKey, setErrorKey] = useState(0)
  useEffect(() => {
    if (error) setErrorKey(k => k + 1)
  }, [error])

  // 拉取公开实例列表（仅 id+label，不暴露 host/port）
  useEffect(() => {
    let cancelled = false
    fetch(`${LOCAL_API_BASE}/api/remote-instances/public-list`)
      .then(r => (r.ok ? r.json() : []))
      .then((list: PublicInstance[]) => {
        if (!cancelled) setRemoteList(list)
      })
      .catch(() => { if (!cancelled) setRemoteList([]) })
    return () => { cancelled = true }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${LOCAL_API_BASE}/api/auth/login`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        setError(t('login.wrongPassword'))
        return
      }
      const { token: authToken } = await res.json()
      localStorage.setItem('agentmobile_token', authToken)
      // 如果用户在登录页选择了远端实例，登录成功后切换到该实例
      if (pendingRemoteId && pendingRemoteId !== LOCAL_INSTANCE_ID) {
        switchInstanceById(pendingRemoteId)
      }
      onLogin(authToken)
    } catch {
      setError(t('login.connectionFailed'))
    } finally {
      setLoading(false)
    }
  }

  const versionLabel = typeof __APP_VERSION__ === 'string' ? `v${__APP_VERSION__}` : 'v—'

  return (
    <div className="login-stage">
      <div className="login-grid-overlay" aria-hidden />
      <div className="login-scanline" aria-hidden />
      <div className="login-corner-deco login-corner-deco--tl" aria-hidden />
      <div className="login-corner-deco login-corner-deco--tr" aria-hidden />
      <div className="login-corner-deco login-corner-deco--bl" aria-hidden />
      <div className="login-corner-deco login-corner-deco--br" aria-hidden />

      <div className="login-card" role="dialog" aria-labelledby="login-title">
        {/* Status bar */}
        <div className="login-status-bar login-stagger-1">
          <span className="login-status-bar__dot" aria-hidden />
          <span>{t('login.statusReady')}</span>
          <span className="login-status-bar__version">{versionLabel}</span>
        </div>

        {/* Brand mark */}
        <div className="login-logo login-stagger-2" aria-hidden>
          <AgentmobileMark size={56} />
        </div>

        <h1 id="login-title" className="login-title login-stagger-2">{t('login.title')}</h1>
        <p className="login-subtitle login-stagger-3">{t('login.subtitle')}</p>

        <form onSubmit={handleSubmit} className="login-stagger-4" noValidate>
          <div className="login-field">
            <span className="login-field__icon--lead">
              <Icon name="lock" size={16} />
            </span>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={t('login.passwordPlaceholder')}
              autoFocus
              autoComplete="current-password"
              className="login-input"
              aria-label={t('login.passwordPlaceholder')}
            />
            <button
              type="button"
              onClick={() => setShowPassword(s => !s)}
              className="login-field__toggle"
              aria-label={t('login.togglePassword')}
              title={t('login.togglePassword')}
            >
              <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
            </button>
          </div>

          {error && (
            <p key={errorKey} className="login-error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" disabled={loading} className="login-submit">
            {loading ? t('login.loggingIn') : t('login.loginButton')}
          </button>
        </form>

        {remoteList.length > 0 && (
          <div className="login-stagger-5 mt-3 flex flex-col gap-1.5">
            <div className="text-[10px] uppercase tracking-wider opacity-60 flex items-center gap-1">
              <Icon name="cloud" size={10} />
              <span>{t('remote.remoteInstances')}</span>
            </div>
            <button
              type="button"
              onClick={() => setPendingRemoteId(null)}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded text-xs text-left cursor-pointer border transition-colors ${
                pendingRemoteId === null
                  ? 'bg-agentmobile-accent/15 border-agentmobile-accent text-agentmobile-accent'
                  : 'bg-transparent border-agentmobile-border text-agentmobile-text hover:bg-agentmobile-bg-2'
              }`}
            >
              <Icon name="server" size={12} />
              <span className="flex-1 truncate">{t('remote.localInstance')}</span>
              {pendingRemoteId === null && <Icon name="check" size={12} />}
            </button>
            {remoteList.map(inst => (
              <button
                key={inst.id}
                type="button"
                onClick={() => setPendingRemoteId(inst.id)}
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded text-xs text-left cursor-pointer border transition-colors ${
                  pendingRemoteId === inst.id
                    ? 'bg-agentmobile-accent/15 border-agentmobile-accent text-agentmobile-accent'
                    : 'bg-transparent border-agentmobile-border text-agentmobile-text hover:bg-agentmobile-bg-2'
                }`}
              >
                <Icon name="cloud" size={12} />
                <span className="flex-1 truncate">{inst.label}</span>
                {pendingRemoteId === inst.id && <Icon name="check" size={12} />}
              </button>
            ))}
            <p className="text-[10px] opacity-50 mt-1">
              {pendingRemoteId && pendingRemoteId !== LOCAL_INSTANCE_ID
                ? t('remote.loginHintRemote')
                : t('remote.loginHintLocal')}
            </p>
          </div>
        )}

        <div className="login-footer login-stagger-5">
          {t('login.footerHint')}
        </div>
      </div>
    </div>
  )
}

/**
 * Custom agentmobile brand mark — inline SVG so it inherits no deps.
 * Composition: terminal square brackets + 3-bar signal waveform + prompt caret.
 * Uses accent + muted vars to stay theme-aware.
 */
function AgentmobileMark({ size = 48 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      style={{ display: 'block' }}
    >
      <defs>
        <linearGradient id="amMarkGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#60a5fa" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      {/* Outer rounded plate */}
      <rect
        x="2"
        y="2"
        width="60"
        height="60"
        rx="14"
        fill="var(--agentmobile-bg2)"
        stroke="var(--agentmobile-border)"
        strokeWidth="1.5"
      />
      {/* Left bracket [ */}
      <path
        d="M22 16 L14 16 L14 48 L22 48"
        fill="none"
        stroke="url(#amMarkGrad)"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Right bracket ] */}
      <path
        d="M42 16 L50 16 L50 48 L42 48"
        fill="none"
        stroke="url(#amMarkGrad)"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Signal waveform — 3 ascending bars */}
      <line x1="26" y1="38" x2="26" y2="42" stroke="url(#amMarkGrad)" strokeWidth="3" strokeLinecap="round" />
      <line x1="32" y1="32" x2="32" y2="42" stroke="url(#amMarkGrad)" strokeWidth="3" strokeLinecap="round" />
      <line x1="38" y1="26" x2="38" y2="42" stroke="url(#amMarkGrad)" strokeWidth="3" strokeLinecap="round" />
      {/* Prompt caret */}
      <path d="M46 48 L52 48" stroke="var(--agentmobile-text2)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}
