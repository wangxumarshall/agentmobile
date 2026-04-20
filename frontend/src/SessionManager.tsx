import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { Icon } from './icons'

// 检测是否为 PC 端（>= 768px）
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768)
  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isDesktop
}

interface Config {
  id: string
  label: string
  agent_type?: 'claude' | 'codex' | 'trae' | 'opencode'
  BASE_URL?: string
  AUTH_TOKEN?: string
  API_KEY?: string
  DEFAULT_MODEL?: string
  THINK_MODEL?: string
  LONG_CONTEXT_MODEL?: string
  DEFAULT_HAIKU_MODEL?: string
  API_TIMEOUT_MS?: string
  REASONING_EFFORT?: string
  SANDBOX_MODE?: string
}

interface Props {
  token: string
  onClose: () => void
}

const EMPTY_CONFIG: Omit<Config, 'id'> = {
  label: '',
  agent_type: 'claude',
  BASE_URL: '',
  AUTH_TOKEN: '',
  API_KEY: '',
  DEFAULT_MODEL: '',
  THINK_MODEL: '',
  LONG_CONTEXT_MODEL: '',
  DEFAULT_HAIKU_MODEL: '',
  API_TIMEOUT_MS: '3000000',
  REASONING_EFFORT: '',
  SANDBOX_MODE: '',
}

export default function SessionManager({ token, onClose }: Props) {
  const { t } = useTranslation()
  const isDesktop = useIsDesktop()

  const [configs, setConfigs] = useState<Config[]>([])
  const [loadingCfg, setLoadingCfg] = useState(false)
  const [editingConfig, setEditingConfig] = useState<(Config & { isNew: boolean }) | null>(null)
  const [savingCfg, setSavingCfg] = useState(false)
  const [cfgError, setCfgError] = useState<string | null>(null)

  const headers = { Authorization: `Bearer ${token}` }

  async function fetchConfigs() {
    setLoadingCfg(true)
    try {
      const r = await fetch('/api/configs', { headers })
      setConfigs(r.ok ? await r.json() : [])
    } catch { setConfigs([]) }
    finally { setLoadingCfg(false) }
  }

  useEffect(() => { fetchConfigs() }, [])

  async function saveConfig() {
    if (!editingConfig) return
    const { id, isNew, ...data } = editingConfig
    if (!id.trim() || !data.label.trim()) { setCfgError('ID 和名称不能为空'); return }
    setSavingCfg(true); setCfgError(null)
    try {
      const r = await fetch(`/api/configs/${id.trim()}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setEditingConfig(null)
      await fetchConfigs()
    } catch (e: unknown) {
      setCfgError(e instanceof Error ? e.message : '保存失败')
    } finally { setSavingCfg(false) }
  }

  async function deleteConfig(id: string) {
    try {
      await fetch(`/api/configs/${id}`, { method: 'DELETE', headers })
      await fetchConfigs()
    } catch { /* ignore */ }
  }

  // ── 配置编辑面板 ──
  if (editingConfig) {
    const fields: Array<{ key: keyof typeof EMPTY_CONFIG; label: string; placeholder: string; secret?: boolean }> = [
      { key: 'label',              label: t('apiConfig.labelName'),         placeholder: t('apiConfig.labelNamePlaceholder') },
      { key: 'BASE_URL',           label: t('apiConfig.apiBaseUrl'),        placeholder: 'https://api.kimi.com/coding' },
      { key: 'AUTH_TOKEN',         label: t('apiConfig.authToken'),         placeholder: 'sk-...', secret: true },
      { key: 'API_KEY',            label: t('apiConfig.apiKey'),            placeholder: t('apiConfig.apiKeyNote'), secret: true },
      { key: 'DEFAULT_MODEL',      label: t('apiConfig.defaultModel'),      placeholder: 'kimi-for-coding' },
      { key: 'THINK_MODEL',        label: t('apiConfig.thinkingModel'),     placeholder: 'kimi-for-coding' },
      { key: 'LONG_CONTEXT_MODEL', label: t('apiConfig.longContextModel'),  placeholder: 'kimi-for-coding' },
      { key: 'DEFAULT_HAIKU_MODEL',label: t('apiConfig.haikuModel'),        placeholder: 'kimi-for-coding' },
      { key: 'API_TIMEOUT_MS',     label: t('apiConfig.timeout'),           placeholder: '3000000' },
      { key: 'REASONING_EFFORT',   label: t('apiConfig.reasoningEffort'),   placeholder: 'high' },
      { key: 'SANDBOX_MODE',       label: t('apiConfig.sandboxMode'),       placeholder: 'danger-full-access' },
    ]
    return (
      <div className={isDesktop ? 'fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-5' : 'fixed inset-0 bg-black/60 z-[100]'}>
        <div className={isDesktop ? 'bg-agentmobile-bg border border-agentmobile-border rounded-xl flex flex-col text-agentmobile-text w-full max-w-[800px] max-h-[85vh] shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden' : 'fixed inset-0 bg-agentmobile-bg flex flex-col text-agentmobile-text'}>
          <div className="flex items-center justify-between px-4 py-3.5 border-b border-agentmobile-border shrink-0">
            <span className="text-base font-semibold">{editingConfig.isNew ? t('apiConfig.newConfig') : t('apiConfig.editConfig')}</span>
            <button className="bg-transparent border-none text-agentmobile-text-2 cursor-pointer text-2xl leading-none px-1 flex items-center justify-center" onPointerDown={() => { setEditingConfig(null); setCfgError(null) }}><Icon name="x" size={20} /></button>
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            <div className="px-4 py-3 border-b border-agentmobile-border">
              {cfgError && <div className="text-agentmobile-error text-xs mb-2">{cfgError}</div>}
              {/* ID 字段只在新建时可编辑 */}
              <div className={isDesktop ? 'flex flex-row items-center gap-4 mb-3' : 'flex flex-col gap-1 mb-2.5'}>
                <label className={isDesktop ? 'text-agentmobile-text-2 text-sm w-[140px] shrink-0 text-right' : 'text-agentmobile-text-2 text-xs'}>{t('apiConfig.idLabel')}</label>
                <input
                  className={isDesktop ? 'bg-agentmobile-bg-2 border border-agentmobile-border rounded-md text-agentmobile-text text-sm px-3 py-2.5 outline-none flex-1 box-border' : 'bg-agentmobile-bg-2 border border-agentmobile-border rounded-md text-agentmobile-text text-sm px-2.5 py-2 outline-none w-full box-border'}
                  value={editingConfig.id}
                  readOnly={!editingConfig.isNew}
                  onChange={e => setEditingConfig(c => c && { ...c, id: e.target.value.replace(/[^a-z0-9_-]/gi, '-').toLowerCase() })}
                  placeholder="kimi"
                  autoCapitalize="off" autoCorrect="off" spellCheck={false}
                />
              </div>
              <div className={isDesktop ? 'flex flex-row items-center gap-4 mb-3' : 'flex flex-col gap-1 mb-2.5'}>
                <label className={isDesktop ? 'text-agentmobile-text-2 text-sm w-[140px] shrink-0 text-right' : 'text-agentmobile-text-2 text-xs'}>{t('apiConfig.agentType')}</label>
                <select
                  className={isDesktop ? 'bg-agentmobile-bg-2 border border-agentmobile-border rounded-md text-agentmobile-text text-sm px-3 py-2.5 outline-none flex-1 box-border' : 'bg-agentmobile-bg-2 border border-agentmobile-border rounded-md text-agentmobile-text text-sm px-2.5 py-2 outline-none w-full box-border'}
                  value={editingConfig.agent_type || 'claude'}
                  onChange={e => setEditingConfig(c => c && { ...c, agent_type: e.target.value as Config['agent_type'] })}
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                  <option value="trae">Trae CLI</option>
                  <option value="opencode">OpenCode</option>
                </select>
              </div>
              {fields.map(f => (
                <div key={f.key} className={isDesktop ? 'flex flex-row items-center gap-4 mb-3' : 'flex flex-col gap-1 mb-2.5'}>
                  <label className={isDesktop ? 'text-agentmobile-text-2 text-sm w-[140px] shrink-0 text-right' : 'text-agentmobile-text-2 text-xs'}>{f.label}</label>
                  <input
                    className={isDesktop ? 'bg-agentmobile-bg-2 border border-agentmobile-border rounded-md text-agentmobile-text text-sm px-3 py-2.5 outline-none flex-1 box-border' : 'bg-agentmobile-bg-2 border border-agentmobile-border rounded-md text-agentmobile-text text-sm px-2.5 py-2 outline-none w-full box-border'}
                    type={f.secret ? 'password' : 'text'}
                    value={(editingConfig as unknown as Record<string, string>)[f.key] ?? ''}
                    onChange={e => setEditingConfig(c => c && { ...c, [f.key]: e.target.value })}
                    placeholder={f.placeholder}
                    autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  />
                </div>
              ))}
              <button
                className={`bg-agentmobile-accent border-none rounded-md text-white cursor-pointer text-sm font-semibold px-5 py-2.5 w-full ${savingCfg ? 'opacity-50 cursor-not-allowed' : ''}`}
                onPointerDown={() => { if (!savingCfg) saveConfig() }}
                disabled={savingCfg}
              >
                {savingCfg ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={isDesktop ? 'fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-5' : 'fixed inset-0 bg-black/60 z-[100]'}>
      <GhostShield />
      <div className={isDesktop ? 'bg-agentmobile-bg border border-agentmobile-border rounded-xl flex flex-col text-agentmobile-text w-full max-w-[800px] max-h-[85vh] shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden' : 'fixed inset-0 bg-agentmobile-bg flex flex-col text-agentmobile-text'}>
        {/* 顶部：标题 + 关闭 */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-agentmobile-border shrink-0">
          <span className="text-base font-semibold">{t('apiConfig.title')}</span>
          <button className="bg-transparent border-none text-agentmobile-text-2 cursor-pointer text-2xl leading-none px-1 flex items-center justify-center" onPointerDown={onClose}><Icon name="x" size={20} /></button>
        </div>

        {/* 配置列表 */}
        <div className="flex-1 overflow-y-auto py-2">
          <div className="px-4 py-3 border-b border-agentmobile-border">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] text-agentmobile-text-2 tracking-wider uppercase mb-2">{t('apiConfig.profiles')}</span>
              <button
                className="bg-transparent border border-agentmobile-border rounded text-agentmobile-text-2 cursor-pointer text-[11px] px-2 py-0.5"
                onPointerDown={() => setEditingConfig({ id: '', isNew: true, ...EMPTY_CONFIG })}
              >
                {t('apiConfig.addNew')}
              </button>
            </div>
            {loadingCfg && <div className="text-agentmobile-muted text-sm py-2">{t('common.loading')}</div>}
            {!loadingCfg && configs.length === 0 && (
              <div className="text-agentmobile-muted text-sm py-2">{t('apiConfig.noConfigs')}</div>
            )}
            {configs.map(cfg => (
              <div key={cfg.id} className="flex items-center gap-2.5 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="text-agentmobile-text text-sm truncate">{cfg.label}</div>
                  <div className="text-agentmobile-muted text-[11px] mt-0.5 font-mono truncate" title={`${cfg.id} · ${cfg.DEFAULT_MODEL || '—'}`}>{cfg.id} · {cfg.DEFAULT_MODEL || '—'}</div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button
                    className="bg-transparent border border-agentmobile-border rounded text-agentmobile-accent cursor-pointer text-[11px] px-2 py-[3px]"
                    onPointerDown={() => setEditingConfig({ id: cfg.id, isNew: false, label: cfg.label, agent_type: cfg.agent_type || 'claude', BASE_URL: cfg.BASE_URL, AUTH_TOKEN: cfg.AUTH_TOKEN, API_KEY: cfg.API_KEY, DEFAULT_MODEL: cfg.DEFAULT_MODEL, THINK_MODEL: cfg.THINK_MODEL, LONG_CONTEXT_MODEL: cfg.LONG_CONTEXT_MODEL, DEFAULT_HAIKU_MODEL: cfg.DEFAULT_HAIKU_MODEL, API_TIMEOUT_MS: cfg.API_TIMEOUT_MS, REASONING_EFFORT: cfg.REASONING_EFFORT, SANDBOX_MODE: cfg.SANDBOX_MODE })}
                  >{t('common.edit')}</button>
                  <button
                    className="bg-transparent border border-agentmobile-border rounded text-agentmobile-error cursor-pointer text-[11px] px-2 py-[3px]"
                    onPointerDown={() => deleteConfig(cfg.id)}
                  >{t('common.delete')}</button>
                </div>
              </div>
            ))}
          </div>
          <div className="px-4 py-3 text-agentmobile-text-2 text-[11px] leading-relaxed">
            <div className="text-[11px] text-agentmobile-text-2 tracking-wider uppercase mb-2">{t('apiConfig.notes')}</div>
            <p>每个配置对应一个 agent provider。新建会话时选择配置后，会以该 provider 的 API key 和模型设置启动对应 agent。Claude 会话历史仍保存在项目目录的 <code className="bg-agentmobile-bg-2 rounded px-1 font-mono text-[10px] text-agentmobile-accent">.claude-data/</code> 中。</p>
          </div>
        </div>
      </div>
    </div>
  )
}
