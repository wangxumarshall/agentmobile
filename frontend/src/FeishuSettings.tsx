import { useEffect, useMemo, useState } from 'react'
import { apiUrl } from './api'
import { useTranslation } from 'react-i18next'
import { Icon } from './icons'

interface Props {
  token: string
}

type FeishuDomain = 'feishu' | 'lark'
type SetupStatus = 'idle' | 'starting' | 'waiting' | 'slow_down' | 'saved' | 'error' | 'aborted' | 'expired'

interface FeishuSettingsSnapshot {
  imBridgeEnabled: boolean
  feishuEnabled: boolean
  configured: boolean
  appIdMasked: string
  appSecretConfigured: boolean
  domain: string
  callbackPort: string
  verificationTokenConfigured: boolean
  encryptKeyConfigured: boolean
  allowedUsers: string[]
}

interface FeishuSetupSession {
  id: string
  status: SetupStatus
  statusDetail?: string
  error?: string
  domain: FeishuDomain
  qrUrl?: string
  qrSvg?: string
  expiresAt?: string
  saved?: boolean
  appIdMasked?: string
  openId?: string
  tenantBrand?: string
  settings?: FeishuSettingsSnapshot
}

const EMPTY_SETTINGS: FeishuSettingsSnapshot = {
  imBridgeEnabled: false,
  feishuEnabled: false,
  configured: false,
  appIdMasked: '',
  appSecretConfigured: false,
  domain: '',
  callbackPort: '',
  verificationTokenConfigured: false,
  encryptKeyConfigured: false,
  allowedUsers: [],
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

function svgToDataUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`text-xs px-2 py-1 rounded-md ${ok ? 'bg-green-500/15 text-green-400' : 'bg-agentmobile-bg-2 text-agentmobile-text-2'}`}>
      {label}
    </span>
  )
}

export default function FeishuSettings({ token }: Props) {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<FeishuSettingsSnapshot>(EMPTY_SETTINGS)
  const [domain, setDomain] = useState<FeishuDomain>('feishu')
  const [setup, setSetup] = useState<FeishuSetupSession | null>(null)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  const setupActive = setup?.id && ['starting', 'waiting', 'slow_down'].includes(setup.status)

  useEffect(() => {
    void loadSettings()
  }, [token])

  useEffect(() => {
    if (!setupActive || !setup?.id) return
    const timer = window.setInterval(() => {
      void refreshSetup(setup.id)
    }, 2500)
    return () => window.clearInterval(timer)
  }, [setupActive, setup?.id, token])

  async function loadSettings() {
    setLoadingSettings(true)
    try {
      const res = await fetch(apiUrl('/api/feishu/settings'), {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(t('settings.feishuLoadFailed'))
      setSettings(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingSettings(false)
    }
  }

  async function startSetup() {
    setStarting(true)
    setError('')
    try {
      const res = await fetch(apiUrl('/api/feishu/setup'), {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ domain }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || t('settings.feishuSetupFailed'))
      setSetup(data)
      if (data.settings) setSettings(data.settings)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  async function refreshSetup(id: string) {
    try {
      const res = await fetch(apiUrl(`/api/feishu/setup/${id}`), {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const data: FeishuSetupSession = await res.json()
      setSetup(data)
      if (data.settings) setSettings(data.settings)
    } catch {
      // Polling is best effort; the next tick can recover.
    }
  }

  async function cancelSetup() {
    if (!setup?.id) return
    try {
      await fetch(apiUrl(`/api/feishu/setup/${setup.id}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      setSetup({ ...setup, status: 'aborted' })
    } catch {
      setSetup({ ...setup, status: 'aborted' })
    }
  }

  const setupLabel = useMemo(() => {
    if (!setup) return ''
    if (setup.status === 'saved') return t('settings.feishuAuthSaved')
    if (setup.status === 'slow_down') return t('settings.feishuSlowDown')
    if (setup.status === 'waiting') return t('settings.feishuWaitingScan')
    if (setup.status === 'starting') return t('settings.feishuStarting')
    if (setup.status === 'expired') return t('settings.feishuExpired')
    if (setup.status === 'aborted') return t('settings.feishuAborted')
    return t('settings.feishuAuthFailed')
  }, [setup, t])

  const qrSrc = setup?.qrSvg ? svgToDataUrl(setup.qrSvg) : ''
  const expiresLabel = setup?.expiresAt ? new Date(setup.expiresAt).toLocaleTimeString() : ''

  return (
    <div className="border-t border-agentmobile-border pt-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-[11px] text-agentmobile-text-2 tracking-wider uppercase">
          {t('settings.feishuSetup')}
        </div>
        {loadingSettings ? null : (
          <StatusPill
            ok={settings.configured}
            label={settings.configured ? t('settings.configured') : t('settings.notConfigured')}
          />
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
        <SettingRow label={t('settings.imBridge')} value={settings.imBridgeEnabled ? t('settings.enabled') : t('settings.disabled')} ok={settings.imBridgeEnabled} />
        <SettingRow label={t('settings.feishuAdapter')} value={settings.feishuEnabled ? t('settings.enabled') : t('settings.disabled')} ok={settings.feishuEnabled} />
        <SettingRow label={t('settings.feishuApp')} value={settings.appIdMasked || t('settings.notConfigured')} ok={settings.configured} />
        <SettingRow label={t('settings.feishuCallback')} value={settings.callbackPort || t('settings.callbackUnset')} ok={Boolean(settings.callbackPort)} />
      </div>

      {settings.allowedUsers.length > 0 && (
        <p className="text-xs text-agentmobile-text-2 mb-3">
          {t('settings.feishuAllowedUsers')}: {settings.allowedUsers.map(user => user.length > 10 ? `${user.slice(0, 6)}…${user.slice(-4)}` : user).join(', ')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex bg-agentmobile-bg-2 rounded-md p-1 border border-agentmobile-border">
          <button
            className={`text-xs px-3 py-1.5 rounded ${domain === 'feishu' ? 'bg-agentmobile-accent text-white' : 'text-agentmobile-text-2'}`}
            onPointerDown={() => setDomain('feishu')}
            type="button"
          >
            {t('settings.feishuChina')}
          </button>
          <button
            className={`text-xs px-3 py-1.5 rounded ${domain === 'lark' ? 'bg-agentmobile-accent text-white' : 'text-agentmobile-text-2'}`}
            onPointerDown={() => setDomain('lark')}
            type="button"
          >
            {t('settings.feishuLark')}
          </button>
        </div>
        <button
          className="flex items-center gap-1.5 bg-transparent border border-agentmobile-border rounded-md text-agentmobile-text text-sm px-3 py-2 cursor-pointer disabled:opacity-50"
          onPointerDown={starting ? undefined : startSetup}
          disabled={starting}
          type="button"
        >
          <Icon name="refresh" size={14} />
          <span>{starting ? t('settings.feishuGenerating') : t('settings.feishuGenerateQr')}</span>
        </button>
        {setupActive && (
          <button
            className="bg-transparent border border-agentmobile-border rounded-md text-agentmobile-text-2 text-sm px-3 py-2 cursor-pointer"
            onPointerDown={cancelSetup}
            type="button"
          >
            {t('common.cancel')}
          </button>
        )}
      </div>

      {setup && (
        <div className="border border-agentmobile-border rounded-lg p-3 bg-agentmobile-bg-2/40">
          <div className="flex items-center justify-between gap-3 mb-3">
            <span className="text-sm text-agentmobile-text">{setupLabel}</span>
            {setup.status === 'saved' && <Icon name="check" size={16} className="text-green-400" />}
          </div>
          {qrSrc && setup.status !== 'saved' && (
            <div className="flex flex-col sm:flex-row gap-3 items-start">
              <img
                src={qrSrc}
                alt={t('settings.feishuQrAlt')}
                className="w-[220px] h-[220px] bg-white rounded-md border border-agentmobile-border"
              />
              <div className="flex flex-col gap-2 min-w-0">
                {expiresLabel && (
                  <span className="text-xs text-agentmobile-text-2">
                    {t('settings.feishuQrExpires', { time: expiresLabel })}
                  </span>
                )}
                {setup.qrUrl && (
                  <a
                    className="text-sm text-agentmobile-accent underline break-all"
                    href={setup.qrUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('settings.feishuOpenAuthLink')}
                  </a>
                )}
              </div>
            </div>
          )}
          {setup.status === 'saved' && (
            <p className="text-xs text-agentmobile-text-2">
              {t('settings.feishuRestartHint')}
            </p>
          )}
          {setup.error && (
            <p className="text-xs text-red-400 break-words">{setup.error}</p>
          )}
        </div>
      )}

      {error && <p className="text-xs text-red-400 mt-2 break-words">{error}</p>}
    </div>
  )
}

function SettingRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-agentmobile-bg-2/50 rounded-md px-3 py-2 min-w-0">
      <span className="text-xs text-agentmobile-text-2 shrink-0">{label}</span>
      <span className={`text-xs font-mono truncate ${ok ? 'text-agentmobile-text' : 'text-agentmobile-text-2'}`}>{value}</span>
    </div>
  )
}
