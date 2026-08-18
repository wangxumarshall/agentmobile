// Path-prefix helper for mounting the SPA under a sub-path (e.g. /agentmobile/).
// In dev, Vite's `base` defaults to '/' -> BASE = '' -> no prefix.
// In prod build with `base: '/agentmobile/'` -> BASE = '/agentmobile'.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

// 当前激活的远端实例（null = 本地）。由 RemoteInstanceProvider 通过 setRemoteInstanceContext 设置。
// 切换实例时，所有 apiUrl/wsUrl 调用会自动指向 /api/remote-instances/:id/proxy/* 与 /api/remote-instances/:id/ws-proxy。
let remoteInstanceId: string | null = null

export function setRemoteInstanceContext(id: string | null): void {
  remoteInstanceId = id
}

export function getRemoteInstanceContext(): string | null {
  return remoteInstanceId
}

function trimLeadingSlash(p: string): string {
  return p.replace(/^\/+/, '')
}

export const apiUrl = (p: string): string => {
  // p 形如 '/api/sessions'；统一去前导斜杠后构造
  const path = trimLeadingSlash(p)
  if (remoteInstanceId) {
    return `${BASE}/api/remote-instances/${encodeURIComponent(remoteInstanceId)}/proxy/${path}`
  }
  return `${BASE}/${path}`
}

export const wsUrl = (p: string): string => {
  const path = trimLeadingSlash(p)
  if (remoteInstanceId) {
    const proxyPath = `${BASE}/api/remote-instances/${encodeURIComponent(remoteInstanceId)}/ws-proxy`
    return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${proxyPath}`
  }
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${BASE}/${path}`
}
