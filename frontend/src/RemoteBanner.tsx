import { useTranslation } from 'react-i18next'
import { useRemoteInstances, LOCAL_INSTANCE_ID } from './remoteInstance'
import { Icon } from './icons'

/**
 * 远端模式视觉提示条：当 currentId 不是本地实例时，渲染一条彩色横幅，显示
 * 当前远端实例 label + host，并提供「切回本地」按钮。
 */
export default function RemoteBanner() {
  const { t } = useTranslation()
  const { instances, currentId, isLocal, switchInstance } = useRemoteInstances()
  if (isLocal) return null

  const inst = instances.find(i => i.id === currentId) || null
  const label = inst?.label || t('remote.unknownInstance')
  const host = inst ? `${inst.useTls ? 'https' : 'http'}://${inst.host}:${inst.port}` : ''

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/15 border-b border-yellow-500/40 text-yellow-600 dark:text-yellow-400 text-xs shrink-0">
      <Icon name="cloud" size={12} className="shrink-0" />
      <span className="flex-1 truncate">
        <span className="font-medium">{t('remote.remoteInstances')}:</span>{' '}
        <span className="text-agentmobile-text">{label}</span>
        {host && <span className="text-agentmobile-text-2 ml-1">({host})</span>}
      </span>
      <button
        onClick={() => switchInstance(LOCAL_INSTANCE_ID)}
        className="flex items-center gap-1 px-2 py-0.5 rounded bg-yellow-500/20 hover:bg-yellow-500/30 border border-yellow-500/40 text-yellow-700 dark:text-yellow-300 cursor-pointer text-[11px] shrink-0"
        title={t('remote.localInstance')}
      >
        <Icon name="server" size={10} />
        <span>{t('remote.localInstance')}</span>
      </button>
    </div>
  )
}
