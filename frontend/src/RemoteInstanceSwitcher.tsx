import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRemoteInstances, LOCAL_INSTANCE_ID, type RemoteInstance } from './remoteInstance'
import { Icon } from './icons'

interface Props {
  variant?: 'sidebar' | 'compact'
  onAfterSwitch?: () => void
}

export default function RemoteInstanceSwitcher({ variant = 'sidebar', onAfterSwitch }: Props) {
  const { t } = useTranslation()
  const { instances, currentId, isLocal, loading, refresh, switchInstance } = useRemoteInstances()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (open) {
      // 打开后聚焦搜索框，方便键盘输入
      setTimeout(() => searchRef.current?.focus(), 0)
    } else {
      setQuery('')
    }
  }, [open])

  const currentInst = instances.find(i => i.id === currentId) || null
  const currentLabel = isLocal
    ? t('remote.localInstance')
    : (currentInst?.label || t('remote.unknownInstance'))

  // 当前实例状态灯：本地=绿；远端有 token 且未过期=绿；远端 token 过期=红；远端无 token=黄
  const currentExpired = currentInst?.remoteTokenExpiresAt
    ? Date.parse(currentInst.remoteTokenExpiresAt) - Date.now() < 60_000
    : false
  const currentStatusColor = isLocal
    ? 'bg-green-500'
    : !currentInst?.hasRemoteToken
      ? 'bg-yellow-500'
      : currentExpired
        ? 'bg-red-500'
        : 'bg-green-500'
  const currentStatusLabel = isLocal
    ? 'live'
    : !currentInst?.hasRemoteToken
      ? 'idle'
      : currentExpired
        ? 'expired'
        : 'live'

  const handleSwitch = (id: string) => {
    switchInstance(id)
    setOpen(false)
    setQuery('')
    onAfterSwitch?.()
  }

  // 按 lastUsedAt 降序排序，常用实例置顶
  const sortedInstances = useMemo(() => {
    return [...instances].sort((a, b) => {
      const aT = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0
      const bT = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0
      return bT - aT
    })
  }, [instances])

  // 按 label/host 过滤
  const filteredInstances = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sortedInstances
    return sortedInstances.filter(i =>
      i.label.toLowerCase().includes(q) ||
      i.host.toLowerCase().includes(q) ||
      String(i.port).includes(q)
    )
  }, [sortedInstances, query])

  const compact = variant === 'compact'

  return (
    <div ref={ref} className={`relative ${compact ? 'flex-1' : ''}`}>
      <button
        onClick={() => { setOpen(v => !v); refresh() }}
        className={`flex items-center gap-2 w-full ${compact ? 'h-9 px-2' : 'px-2.5 py-2'} rounded-md border border-agentmobile-border bg-agentmobile-bg-2 text-agentmobile-text text-sm hover:bg-agentmobile-bg transition-colors cursor-pointer`}
        title={t('remote.switchInstance')}
      >
        <Icon name={isLocal ? 'server' : 'cloud'} size={14} />
        <span className="flex-1 truncate text-left">{currentLabel}</span>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: currentStatusColor }} title={currentStatusLabel} />
        <span className="text-[10px] text-agentmobile-text-2 shrink-0">
          {`${instances.length + 1} total`}
        </span>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-[500] bg-agentmobile-menu-bg border border-agentmobile-border rounded-md shadow-lg max-h-[60vh] overflow-y-auto flex flex-col">
          {/* 搜索框 */}
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-agentmobile-border shrink-0">
            <Icon name="refresh" size={12} className="text-agentmobile-text-2 opacity-60" />
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('remote.searchPlaceholder')}
              className="flex-1 bg-transparent border-none outline-none text-sm text-agentmobile-text placeholder-agentmobile-text-2"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="text-agentmobile-text-2 hover:text-agentmobile-text bg-transparent border-none cursor-pointer p-0.5"
                title={t('common.cancel')}
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            <button
              onClick={() => handleSwitch(LOCAL_INSTANCE_ID)}
              className={`flex items-center gap-2 w-full px-2.5 py-2 text-sm text-left cursor-pointer hover:bg-agentmobile-tab-active ${isLocal ? 'text-agentmobile-accent' : 'text-agentmobile-text'}`}
            >
              <Icon name="server" size={14} />
              <span className="flex-1 truncate">{t('remote.localInstance')}</span>
              {isLocal && <Icon name="check" size={14} />}
            </button>
            {sortedInstances.length > 0 && <div className="border-t border-agentmobile-border" />}
            <div className="text-[10px] text-agentmobile-text-2 px-2.5 py-1 uppercase tracking-wider">
              {t('remote.remoteInstances')} ({sortedInstances.length})
            </div>
            {loading && (
              <div className="px-2.5 py-2 text-xs text-agentmobile-text-2">{t('common.loading')}</div>
            )}
            {!loading && sortedInstances.length === 0 && (
              <div className="px-2.5 py-2 text-xs text-agentmobile-text-2">{t('remote.noInstances')}</div>
            )}
            {!loading && sortedInstances.length > 0 && filteredInstances.length === 0 && (
              <div className="px-2.5 py-2 text-xs text-agentmobile-text-2">{t('remote.noSearchResults')}</div>
            )}
            {filteredInstances.map(inst => (
              <InstanceRow
                key={inst.id}
                inst={inst}
                active={currentId === inst.id}
                onSwitch={() => handleSwitch(inst.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function InstanceRow({ inst, active, onSwitch }: { inst: RemoteInstance; active: boolean; onSwitch: () => void }) {
  // 状态：有缓存 token / 无 token / token 过期
  const expired = inst.remoteTokenExpiresAt ? Date.parse(inst.remoteTokenExpiresAt) - Date.now() < 60_000 : false
  const statusColor = !inst.hasRemoteToken
    ? 'bg-yellow-500'
    : expired
      ? 'bg-red-500'
      : 'bg-green-500'
  const statusLabel = !inst.hasRemoteToken ? 'idle' : expired ? 'expired' : 'live'

  return (
    <button
      onClick={onSwitch}
      className={`flex items-center gap-2 w-full px-2.5 py-2 text-sm text-left cursor-pointer hover:bg-agentmobile-tab-active ${active ? 'text-agentmobile-accent' : 'text-agentmobile-text'}`}
    >
      <Icon name="cloud" size={14} className="shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="truncate">{inst.label}</div>
        <div className="text-[10px] text-agentmobile-text-2 truncate">
          {inst.useTls ? 'https' : 'http'}://{inst.host}:{inst.port}
        </div>
      </div>
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColor }} title={statusLabel} />
      {active && <Icon name="check" size={14} className="shrink-0" />}
    </button>
  )
}
