import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { AUTH_TOKEN_STORAGE_KEY, checkCookieSession, clearStoredAuth } from './auth'
import Terminal from './Terminal'
import Login from './Login'

export default function App() {
  const { t } = useTranslation()
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY))
  const [checkingSession, setCheckingSession] = useState(() => Boolean(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)))

  useEffect(() => {
    // 注册 Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (!token) {
      setCheckingSession(false)
      return
    }

    let cancelled = false
    setCheckingSession(true)
    checkCookieSession()
      .then(status => {
        if (cancelled) return
        if (status === 'unauthorized') {
          clearStoredAuth()
          setToken(null)
        }
      })
      .finally(() => {
        if (!cancelled) setCheckingSession(false)
      })

    return () => {
      cancelled = true
    }
  }, [token])

  if (checkingSession) {
    return (
      <div className="flex items-center justify-center w-full h-full bg-agentmobile-bg text-agentmobile-text-2 text-sm">
        {t('common.loading')}
      </div>
    )
  }

  if (token) {
    return <Terminal token={token} />
  }

  return <Login onLogin={setToken} />
}
