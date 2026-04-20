import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { Icon } from './icons'

interface Config {
  id: string
  label: string
  agent_type?: 'claude' | 'codex' | 'trae' | 'opencode'
}

interface Props {
  token: string
  onClose: () => void
  onConfirm: (shellType: 'claude' | 'codex' | 'trae' | 'opencode' | 'bash', profile?: string) => void
}

export default function NewWindowDialog({ token, onClose, onConfirm }: Props) {
  const { t } = useTranslation()
  const [shellType, setShellType] = useState<'claude' | 'codex' | 'trae' | 'opencode' | 'bash'>('claude')
  const [configs, setConfigs] = useState<Config[]>([])
  const [selectedProfile, setSelectedProfile] = useState<string>('')
  const [showConfigs, setShowConfigs] = useState(false)

  useEffect(() => {
    fetch('/api/configs', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : [])
      .then((data: Config[]) => {
        setConfigs(data)
        setSelectedProfile('')
      })
      .catch(() => {})
  }, [token])

  useEffect(() => {
    if (shellType === 'bash') {
      setSelectedProfile('')
      return
    }
    const available = configs.filter(c => (c.agent_type || 'claude') === shellType)
    setSelectedProfile(prev => (prev && available.some(cfg => cfg.id === prev)) ? prev : '')
  }, [shellType, configs])

  function handleConfirm() {
    const agentType = shellType
    const validProfile = configs.some(c => c.id === selectedProfile && (c.agent_type || 'claude') === agentType)
    const profile = agentType === 'bash' || !showConfigs || !validProfile ? undefined : selectedProfile
    if (profile) localStorage.setItem('agentmobile_last_profile', profile)
    onConfirm(agentType, profile)
  }

  function handleProfileChange(id: string) {
    setSelectedProfile(id)
    if (id) localStorage.setItem('agentmobile_last_profile', id)
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-5">
      <GhostShield />
      <div className="bg-agentmobile-bg border border-agentmobile-border rounded-xl flex flex-col text-agentmobile-text w-full max-w-[360px] shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden">
        {/* 标题 */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-agentmobile-border">
          <span className="text-base font-semibold">{t('newChannel.title')}</span>
          <button
            className="bg-transparent border-none text-agentmobile-text-2 cursor-pointer flex items-center justify-center"
            onPointerDown={onClose}
          >
            <Icon name="x" size={20} />
          </button>
        </div>

        <div className="px-4 py-4 flex flex-col gap-4">
          {/* Agent 类型 */}
          <div>
            <div className="text-[11px] text-agentmobile-text-2 tracking-wider uppercase mb-2">{t('newChannel.agentType')}</div>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-agentmobile-text text-sm cursor-pointer">
                <input
                  type="radio"
                  name="agentType"
                  value="claude"
                  checked={shellType === 'claude'}
                  onChange={() => setShellType('claude')}
                />
                <span>⚡ Claude</span>
              </label>
              <label className="flex items-center gap-2 text-agentmobile-text text-sm cursor-pointer">
                <input
                  type="radio"
                  name="agentType"
                  value="codex"
                  checked={shellType === 'codex'}
                  onChange={() => setShellType('codex')}
                />
                <span>🔷 Codex</span>
              </label>
              <label className="flex items-center gap-2 text-agentmobile-text text-sm cursor-pointer">
                <input
                  type="radio"
                  name="agentType"
                  value="trae"
                  checked={shellType === 'trae'}
                  onChange={() => setShellType('trae')}
                />
                <span>△ Trae CLI</span>
              </label>
              <label className="flex items-center gap-2 text-agentmobile-text text-sm cursor-pointer">
                <input
                  type="radio"
                  name="agentType"
                  value="opencode"
                  checked={shellType === 'opencode'}
                  onChange={() => setShellType('opencode')}
                />
                <span>◎ OpenCode</span>
              </label>
              <label className="flex items-center gap-2 text-agentmobile-text text-sm cursor-pointer">
                <input
                  type="radio"
                  name="agentType"
                  value="bash"
                  checked={shellType === 'bash'}
                  onChange={() => setShellType('bash')}
                />
                <span>Bash</span>
              </label>
            </div>
          </div>

          {/* Profile */}
          {shellType !== 'bash' && configs.filter(c => (c.agent_type || 'claude') === shellType).length > 0 && (
            <div>
              <div
                className="text-[11px] text-agentmobile-text-2 tracking-wider uppercase mb-2 cursor-pointer select-none"
                onClick={() => setShowConfigs(!showConfigs)}
              >
                {t('newChannel.profile')} {showConfigs ? '▲' : '▼'}
              </div>
              {showConfigs && (
                <select
                  className="bg-agentmobile-bg-2 border border-agentmobile-border rounded-md text-agentmobile-text text-sm px-2.5 py-2 w-full outline-none"
                  value={selectedProfile}
                  onChange={e => handleProfileChange(e.target.value)}
                >
                  <option value="">{t('newChannel.profileDefault')}</option>
                  {configs.filter(c => (c.agent_type || 'claude') === shellType).map(cfg => (
                    <option key={cfg.id} value={cfg.id}>{cfg.label}</option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex gap-3 px-4 py-3 border-t border-agentmobile-border justify-end">
          <button
            className="bg-transparent border border-agentmobile-border rounded-md text-agentmobile-text-2 cursor-pointer text-sm px-4 py-2"
            onPointerDown={onClose}
          >
            {t('common.cancel')}
          </button>
          <button
            className="bg-agentmobile-accent border-none rounded-md text-white cursor-pointer text-sm font-semibold px-4 py-2"
            onClick={handleConfirm}
          >
            {t('common.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
