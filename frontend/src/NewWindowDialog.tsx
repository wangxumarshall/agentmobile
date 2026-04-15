import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { Icon } from './icons'

interface Config {
  id: string
  label: string
  agent_type?: string
}

interface Props {
  token: string
  onClose: () => void
  onConfirm: (shellType: 'claude' | 'codex' | 'bash', profile?: string) => void
}

export default function NewWindowDialog({ token, onClose, onConfirm }: Props) {
  const { t } = useTranslation()
  const [shellType, setShellType] = useState<'claude' | 'codex' | 'bash'>('claude')
  const [configs, setConfigs] = useState<Config[]>([])
  const [selectedProfile, setSelectedProfile] = useState<string>(() => localStorage.getItem('nexus_last_profile') || '')
  const [showConfigs, setShowConfigs] = useState(false)

  useEffect(() => {
    fetch('/api/configs', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : [])
      .then((data: Config[]) => {
        setConfigs(data)
        if (!localStorage.getItem('nexus_last_profile') && data.length > 0) {
          setSelectedProfile(data[0].id)
        }
      })
      .catch(() => {})
  }, [token])

  function handleConfirm() {
    // 如果有选中的 profile，从它读取 agent_type；否则用当前 shellType
    const cfg = configs.find(c => c.id === selectedProfile)
    const agentType = cfg?.agent_type || shellType
    const profile = agentType === 'bash' ? undefined : (selectedProfile || undefined)
    if (profile) localStorage.setItem('nexus_last_profile', profile)
    onConfirm(agentType, profile)
  }

  function handleProfileChange(id: string) {
    setSelectedProfile(id)
    if (id) localStorage.setItem('nexus_last_profile', id)
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-5">
      <GhostShield />
      <div className="bg-nexus-bg border border-nexus-border rounded-xl flex flex-col text-nexus-text w-full max-w-[360px] shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden">
        {/* 标题 */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-nexus-border">
          <span className="text-base font-semibold">{t('newChannel.title')}</span>
          <button
            className="bg-transparent border-none text-nexus-text-2 cursor-pointer flex items-center justify-center"
            onPointerDown={onClose}
          >
            <Icon name="x" size={20} />
          </button>
        </div>

        <div className="px-4 py-4 flex flex-col gap-4">
          {/* Agent 类型 */}
          <div>
            <div className="text-[11px] text-nexus-text-2 tracking-wider uppercase mb-2">{t('newChannel.agentType')}</div>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-nexus-text text-sm cursor-pointer">
                <input
                  type="radio"
                  name="agentType"
                  value="claude"
                  checked={shellType === 'claude'}
                  onChange={() => setShellType('claude')}
                />
                <span>⚡ Claude</span>
              </label>
              <label className="flex items-center gap-2 text-nexus-text text-sm cursor-pointer">
                <input
                  type="radio"
                  name="agentType"
                  value="codex"
                  checked={shellType === 'codex'}
                  onChange={() => setShellType('codex')}
                />
                <span>🔷 Codex</span>
              </label>
              <label className="flex items-center gap-2 text-nexus-text text-sm cursor-pointer">
                <input
                  type="radio"
                  name="agentType"
                  value="bash"
                  checked={shellType === 'bash'}
                  onChange={() => setShellType('bash')}
                />
                <span>Zsh</span>
              </label>
            </div>
          </div>

          {/* Profile — Claude */}
          {shellType === 'claude' && configs.filter(c => !c.agent_type || c.agent_type === 'claude').length > 0 && (
            <div>
              <div
                className="text-[11px] text-nexus-text-2 tracking-wider uppercase mb-2 cursor-pointer select-none"
                onClick={() => setShowConfigs(!showConfigs)}
              >
                {t('newChannel.profile')} {showConfigs ? '▲' : '▼'}
              </div>
              {showConfigs && (
                <select
                  className="bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text text-sm px-2.5 py-2 w-full outline-none"
                  value={selectedProfile}
                  onChange={e => handleProfileChange(e.target.value)}
                >
                  <option value="">{t('newChannel.profileDefault')}</option>
                  {configs.filter(c => !c.agent_type || c.agent_type === 'claude').map(cfg => (
                    <option key={cfg.id} value={cfg.id}>{cfg.label}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* Profile — Codex */}
          {shellType === 'codex' && configs.filter(c => c.agent_type === 'codex').length > 0 && (
            <div>
              <div
                className="text-[11px] text-nexus-text-2 tracking-wider uppercase mb-2 cursor-pointer select-none"
                onClick={() => setShowConfigs(!showConfigs)}
              >
                {t('newChannel.profile')} {showConfigs ? '▲' : '▼'}
              </div>
              {showConfigs && (
                <select
                  className="bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text text-sm px-2.5 py-2 w-full outline-none"
                  value={selectedProfile}
                  onChange={e => handleProfileChange(e.target.value)}
                >
                  <option value="">{t('newChannel.profileDefault')}</option>
                  {configs.filter(c => c.agent_type === 'codex').map(cfg => (
                    <option key={cfg.id} value={cfg.id}>{cfg.label}</option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex gap-3 px-4 py-3 border-t border-nexus-border justify-end">
          <button
            className="bg-transparent border border-nexus-border rounded-md text-nexus-text-2 cursor-pointer text-sm px-4 py-2"
            onPointerDown={onClose}
          >
            {t('common.cancel')}
          </button>
          <button
            className="bg-nexus-accent border-none rounded-md text-white cursor-pointer text-sm font-semibold px-4 py-2"
            onPointerDown={handleConfirm}
          >
            {t('common.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
