export const AUTH_TOKEN_STORAGE_KEY = 'agentmobile_token'

export type CookieSessionStatus = 'valid' | 'unauthorized' | 'error'
export type AuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

// 本端 cookie 校验：始终走本端 /api/auth/session，不受远端实例切换影响
const LOCAL_API_BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL || '/').replace(/\/$/, '')

export async function checkCookieSession(fetcher: AuthFetch = fetch): Promise<CookieSessionStatus> {
  try {
    const response = await fetcher(`${LOCAL_API_BASE}/api/auth/session`, { credentials: 'same-origin' })
    if (response.ok) return 'valid'
    return response.status === 401 ? 'unauthorized' : 'error'
  } catch {
    return 'error'
  }
}

export function clearStoredAuth(storage: Pick<Storage, 'removeItem'> = window.localStorage): void {
  storage.removeItem(AUTH_TOKEN_STORAGE_KEY)
}

export function clearAuthAndReload(
  storage: Pick<Storage, 'removeItem'> = window.localStorage,
  location: Pick<Location, 'reload'> = window.location,
): void {
  clearStoredAuth(storage)
  location.reload()
}

export function buildWebSocketAuthMessage(token: string): string {
  return JSON.stringify({ type: 'auth', token })
}
