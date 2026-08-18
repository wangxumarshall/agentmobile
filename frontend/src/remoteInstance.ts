import { useEffect, useState, useCallback } from 'react'
import { setRemoteInstanceContext } from './api'

// 远端实例类型（与后端 publicInstance 对齐）
export interface RemoteInstance {
  id: string
  label: string
  host: string
  port: number
  useTls: boolean
  authMode: 'web' | 'ssh'
  username: string
  sshPort: number
  hasPassword: boolean
  hasRemoteToken: boolean
  remoteTokenExpiresAt: string | null
  createdAt: string
  lastUsedAt: string | null
}

const LOCAL_INSTANCE_ID = 'local'
const STORAGE_KEY = 'agentmobile_remote_instance_id'
const BASE_API = import.meta.env.BASE_URL.replace(/\/$/, '')

export function isLocalInstance(id: string | null): boolean {
  return !id || id === LOCAL_INSTANCE_ID
}

export function getCurrentInstanceId(): string {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored || LOCAL_INSTANCE_ID
}

// 拉取远端实例列表（始终走本端 API，不能用 apiUrl，否则切换后死循环）
async function fetchInstances(token: string): Promise<RemoteInstance[]> {
  if (!token) return []
  const r = await fetch(`${BASE_API}/api/remote-instances`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) return []
  return await r.json()
}

export function useRemoteInstances() {
  const [instances, setInstances] = useState<RemoteInstance[]>([])
  const [currentId, setCurrentId] = useState<string>(() => getCurrentInstanceId())
  const [loading, setLoading] = useState(false)

  // 启动时同步 context
  useEffect(() => {
    setRemoteInstanceContext(isLocalInstance(currentId) ? null : currentId)
  }, [currentId])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const token = localStorage.getItem('agentmobile_token') || ''
      const list = await fetchInstances(token)
      setInstances(list)
      // 如果当前选中的实例已被删除，切回本地
      if (!isLocalInstance(currentId) && !list.find(i => i.id === currentId)) {
        setCurrentId(LOCAL_INSTANCE_ID)
        localStorage.setItem(STORAGE_KEY, LOCAL_INSTANCE_ID)
        setRemoteInstanceContext(null)
      }
    } finally {
      setLoading(false)
    }
  }, [currentId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const switchInstance = useCallback((id: string) => {
    const target = isLocalInstance(id) ? LOCAL_INSTANCE_ID : id
    localStorage.setItem(STORAGE_KEY, target)
    setCurrentId(target)
    setRemoteInstanceContext(isLocalInstance(target) ? null : target)
    // 触发顶层重载，让 Terminal 等组件重新读取 token 并重建 WebSocket
    // 这里通过 dispatchEvent 通知 useInstanceSwitch 监听者
    window.dispatchEvent(new CustomEvent('agentmobile:instance-switch', { detail: { id: target } }))
  }, [])

  return {
    instances,
    currentId,
    isLocal: isLocalInstance(currentId),
    loading,
    refresh,
    switchInstance,
  }
}

// 让任意组件订阅实例切换事件
export function useInstanceSwitch(): string {
  const [id, setId] = useState<string>(() => getCurrentInstanceId())
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.id) setId(detail.id)
    }
    window.addEventListener('agentmobile:instance-switch', handler)
    return () => window.removeEventListener('agentmobile:instance-switch', handler)
  }, [])
  return id
}

export function clearRemoteInstanceOnLogout() {
  localStorage.removeItem(STORAGE_KEY)
  setRemoteInstanceContext(null)
}

// 独立切换函数（不依赖 hook 上下文）：登录页等场景下，直接写入 localStorage
// 并同步 api 上下文 + dispatchEvent，让 useInstanceSwitch 监听者响应
export function switchInstanceById(id: string) {
  const target = isLocalInstance(id) ? LOCAL_INSTANCE_ID : id
  localStorage.setItem(STORAGE_KEY, target)
  setRemoteInstanceContext(isLocalInstance(target) ? null : target)
  window.dispatchEvent(new CustomEvent('agentmobile:instance-switch', { detail: { id: target } }))
}

export { LOCAL_INSTANCE_ID }
