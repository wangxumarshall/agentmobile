import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  token: string
}

interface TelegramSettingsSnapshot {
  imBridgeEnabled: boolean
  telegramEnabled: boolean
  configured: boolean
  botTokenMasked: string
  defaultSession: string
  webhookSecretConfigured: boolean
  botUsername: string
  botDisplayName: string
  botId: string
  botLink: string
}

const EMPTY_SETTINGS: TelegramSettingsSnapshot = {
  imBridgeEnabled: false,
  telegramEnabled: false,
  configured: false,
  botTokenMasked: '',
  defaultSession: '',
  webhookSecretConfigured: false,
  botUsername: '',
  botDisplayName: '',
  botId: '',
  botLink: '',
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function readJsonResponse(response: Response, invalidResponseMessage: string): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    const contentType = response.headers.get('content-type') || 'unknown content type'
    const preview = text.trim().replace(/\s+/g, ' ').slice(0, 120)
    throw new Error(`${invalidResponseMessage}: ${contentType}${preview ? ` (${preview})` : ''}`)
  }
}

function getResponseError(data: unknown, fallback: string) {
  return isRecord(data) && typeof data.error === 'string' ? data.error : fallback
}

function isTelegramSettingsSnapshot(value: unknown): value is TelegramSettingsSnapshot {
  if (!isRecord(value)) return false
  return (
    typeof value.imBridgeEnabled === 'boolean' &&
    typeof value.telegramEnabled === 'boolean' &&
    typeof value.configured === 'boolean' &&
    typeof value.botTokenMasked === 'string' &&
    typeof value.defaultSession === 'string' &&
    typeof value.webhookSecretConfigured === 'boolean' &&
    typeof value.botUsername === 'string' &&
    typeof value.botDisplayName === 'string' &&
    typeof value.botId === 'string' &&
    typeof value.botLink === 'string'
  )
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`text-xs px-2 py-1 rounded-md ${ok ? 'bg-green-500/15 text-green-400' : 'bg-agentmobile-bg-2 text-agentmobile-text-2'}`}>
      {label}
    </span>
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

export default function TelegramSettings({ token }: Props) {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<TelegramSettingsSnapshot>(EMPTY_SETTINGS)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [saving, setSaving] = useState(false)
  const [botToken, setBotToken] = useState('')
  const [defaultSession, setDefaultSession] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void loadSettings()
  }, [token])

  async function loadSettings() {
    setLoadingSettings(true)
    setSaved(false)
    try {
      const res = await fetch('/api/telegram/settings', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await readJsonResponse(res, t('settings.telegramInvalidResponse'))
      if (!res.ok) throw new Error(getResponseError(data, t('settings.telegramLoadFailed')))
      if (!isTelegramSettingsSnapshot(data)) throw new Error(t('settings.telegramInvalidResponse'))
      setSettings(data)
      setDefaultSession(data.defaultSession || '')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingSettings(false)
    }
  }

  async function saveSettings() {
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const res = await fetch('/api/telegram/settings', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          botToken,
          defaultSession,
        }),
      })
      const data = await readJsonResponse(res, t('settings.telegramInvalidResponse'))
      if (!res.ok) throw new Error(getResponseError(data, t('settings.telegramSaveFailed')))
      if (!isRecord(data) || !isTelegramSettingsSnapshot(data.settings)) throw new Error(t('settings.telegramInvalidResponse'))
      const savedSettings = data.settings
      setSettings(savedSettings)
      setBotToken('')
      setDefaultSession(savedSettings.defaultSession || '')
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const botDisplay = useMemo(() => {
    if (!settings.botUsername && !settings.botDisplayName) return t('settings.notConfigured')
    if (settings.botDisplayName && settings.botUsername) return `${settings.botDisplayName} (@${settings.botUsername})`
    return settings.botDisplayName || `@${settings.botUsername}`
  }, [settings.botDisplayName, settings.botUsername, t])

  return (
    <div className="border-t border-agentmobile-border pt-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-[11px] text-agentmobile-text-2 tracking-wider uppercase">
          {t('settings.telegramSetup')}
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
        <SettingRow label={t('settings.telegramAdapter')} value={settings.telegramEnabled ? t('settings.enabled') : t('settings.disabled')} ok={settings.telegramEnabled} />
        <SettingRow label={t('settings.telegramBot')} value={botDisplay} ok={settings.configured} />
        <SettingRow label={t('settings.telegramDefaultSession')} value={settings.defaultSession || t('settings.notConfigured')} ok={Boolean(settings.defaultSession)} />
      </div>

      <p className="text-xs text-agentmobile-text-2 mb-3">
        {t('settings.telegramGuide')}
        {' '}
        <a
          className="text-agentmobile-accent underline"
          href="https://t.me/BotFather"
          target="_blank"
          rel="noopener noreferrer"
        >
          @BotFather
        </a>
        {' '}
        {t('settings.telegramGuideSuffix')}
      </p>

      <div className="flex flex-col gap-2 mb-3">
        <input
          type="password"
          className="bg-agentmobile-bg-2 border border-agentmobile-border rounded-md text-agentmobile-text text-sm px-3 py-2 outline-none"
          placeholder={settings.configured ? t('settings.telegramKeepTokenHint') : t('settings.telegramTokenPlaceholder')}
          value={botToken}
          onChange={(event) => setBotToken(event.target.value)}
        />
        <input
          type="text"
          className="bg-agentmobile-bg-2 border border-agentmobile-border rounded-md text-agentmobile-text text-sm px-3 py-2 outline-none"
          placeholder={t('settings.telegramSessionPlaceholder')}
          value={defaultSession}
          onChange={(event) => setDefaultSession(event.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="flex items-center gap-1.5 bg-transparent border border-agentmobile-border rounded-md text-agentmobile-text text-sm px-3 py-2 cursor-pointer disabled:opacity-50"
          onPointerDown={saving ? undefined : saveSettings}
          disabled={saving}
          type="button"
        >
          <span>{saving ? t('common.saving') : t('common.save')}</span>
        </button>
        {saved && <span className="text-xs text-green-400">{t('common.saved')}</span>}
        {settings.botLink && (
          <a
            className="text-sm text-agentmobile-accent underline break-all"
            href={settings.botLink}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('settings.telegramOpenBot')}
          </a>
        )}
      </div>

      {settings.configured && (
        <div className="text-xs text-agentmobile-text-2 mt-3 flex flex-col gap-1.5">
          <p>{t('settings.telegramRestartHint')}</p>
          <p>{t('settings.telegramUsageHint')}</p>
          <p>{t('settings.telegramCommandHint')}</p>
        </div>
      )}

      {error && <p className="text-xs text-red-400 mt-2 break-words">{error}</p>}
    </div>
  )
}
