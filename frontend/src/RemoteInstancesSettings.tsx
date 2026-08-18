import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from './icons'
import { useRemoteInstances, type RemoteInstance } from './remoteInstance'

const LOCAL_API_BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

interface Props {
  token: string
}

interface EditState {
  id: string | null
  label: string
  host: string
  port: string
  useTls: boolean
  authMode: 'web' | 'ssh'
  username: string
  password: string
  sshPort: string
}

const EMPTY_EDIT: EditState = {
  id: null,
  label: '',
  host: '',
  port: '5000',
  useTls: false,
  authMode: 'web',
  username: '',
  password: '',
  sshPort: '22',
}

export default function RemoteInstancesSettings({ token }: Props) {
  const { t } = useTranslation()
  const { instances, currentId, refresh, switchInstance, isLocal } = useRemoteInstances()
  const [edit, setEdit] = useState<EditState>(EMPTY_EDIT)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [testStatus, setTestStatus] = useState<Record<string, 'idle' | 'testing' | 'ok' | 'fail'>>({})

  useEffect(() => { refresh() }, [refresh])

  function startEdit(inst?: RemoteInstance) {
    if (inst) {
      setEdit({
        id: inst.id,
        label: inst.label,
        host: inst.host,
        port: String(inst.port),
        useTls: inst.useTls,
        authMode: inst.authMode,
        username: inst.username,
        password: '',
        sshPort: String(inst.sshPort || 22),
      })
    } else {
      setEdit({ ...EMPTY_EDIT })
    }
    setError('')
  }

  async function callApi(method: string, path: string, body?: any) {
    const r = await fetch(`${LOCAL_API_BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`)
    return data
  }

  async function handleSave() {
    if (!edit.label || !edit.host || !edit.port || !edit.password) {
      setError(t('remote.formErrorRequired'))
      return
    }
    setSaving(true)
    setError('')
    try {
      const body = {
        label: edit.label,
        host: edit.host,
        port: Number(edit.port),
        useTls: edit.useTls,
        authMode: edit.authMode,
        username: edit.username,
        password: edit.password,
        sshPort: Number(edit.sshPort || 22),
      }
      if (edit.id) {
        await callApi('PUT', `/api/remote-instances/${encodeURIComponent(edit.id)}`, body)
      } else {
        await callApi('POST', '/api/remote-instances', body)
      }
      setEdit(EMPTY_EDIT)
      await refresh()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t('remote.confirmDelete'))) return
    try {
      await callApi('DELETE', `/api/remote-instances/${encodeURIComponent(id)}`)
      if (currentId === id) switchInstance('local')
      await refresh()
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleTest(inst: RemoteInstance) {
    setTestStatus(s => ({ ...s, [inst.id]: 'testing' }))
    try {
      const r = await callApi('POST', `/api/remote-instances/${encodeURIComponent(inst.id)}/test`, {})
      setTestStatus(s => ({ ...s, [inst.id]: r.ok ? 'ok' : 'fail' }))
    } catch (e: any) {
      setTestStatus(s => ({ ...s, [inst.id]: 'fail' }))
    }
  }

  async function handleLogin(inst: RemoteInstance) {
    const password = prompt(t('remote.enterPassword', { label: inst.label }))
    if (!password) return
    setSaving(true)
    setError('')
    try {
      await callApi('POST', `/api/remote-instances/${encodeURIComponent(inst.id)}/login`, { password })
      await refresh()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (edit.id !== null || edit.label !== '') {
    // 编辑/新建表单
    return (
      <div className="border-t border-agentmobile-border pt-4">
        <div className="text-[11px] text-agentmobile-text-2 tracking-wider uppercase mb-3">
          {edit.id ? t('remote.editInstance') : t('remote.newInstance')}
        </div>
        <div className="flex flex-col gap-3">
          <Field label={t('remote.fieldLabel')}>
            <input className={inputCls} value={edit.label} onChange={e => setEdit({ ...edit, label: e.target.value })} placeholder="My Server" />
          </Field>
          <div className="flex gap-2">
            <Field label={t('remote.fieldHost')} className="flex-1">
              <input className={inputCls} value={edit.host} onChange={e => setEdit({ ...edit, host: e.target.value })} placeholder="1.2.3.4 or example.com" />
            </Field>
            <Field label={t('remote.fieldPort')} className="w-20">
              <input className={inputCls} value={edit.port} onChange={e => setEdit({ ...edit, port: e.target.value })} type="number" />
            </Field>
          </div>
          <Field label={t('remote.fieldAuthMode')}>
            <select
              className={inputCls}
              value={edit.authMode}
              onChange={e => {
                const mode = e.target.value as 'web' | 'ssh'
                setEdit({ ...edit, authMode: mode, useTls: mode === 'ssh' ? false : edit.useTls })
              }}
            >
              <option value="web">{t('remote.authModeWeb')}</option>
              <option value="ssh">{t('remote.authModeSsh')}</option>
            </select>
          </Field>
          {edit.authMode === 'ssh' && (
            <div className="flex gap-2">
              <Field label={t('remote.fieldSshUser')} className="flex-1">
                <input className={inputCls} value={edit.username} onChange={e => setEdit({ ...edit, username: e.target.value })} />
              </Field>
              <Field label={t('remote.fieldSshPort')} className="w-20">
                <input className={inputCls} value={edit.sshPort} onChange={e => setEdit({ ...edit, sshPort: e.target.value })} type="number" />
              </Field>
            </div>
          )}
          {edit.authMode === 'web' && (
            <Field label={t('remote.fieldUsername')}>
              <input className={inputCls} value={edit.username} onChange={e => setEdit({ ...edit, username: e.target.value })} placeholder="(optional identifier)" />
            </Field>
          )}
          <Field label={t('remote.fieldPassword')}>
            <input className={inputCls} type="password" value={edit.password} onChange={e => setEdit({ ...edit, password: e.target.value })} placeholder={edit.id ? t('remote.passwordPlaceholderEdit') : t('remote.passwordPlaceholderNew')} />
          </Field>
          {edit.authMode === 'web' && (
            <label className="flex items-center gap-2 text-sm text-agentmobile-text">
              <input type="checkbox" checked={edit.useTls} onChange={e => setEdit({ ...edit, useTls: e.target.checked })} />
              <span>{t('remote.fieldUseTls')}</span>
            </label>
          )}
          {edit.authMode === 'ssh' && (
            <p className="text-[11px] text-agentmobile-text-2 leading-relaxed">
              {t('remote.sshModeHint')}
            </p>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex gap-2">
            <button
              className="px-3 py-1.5 text-sm rounded-md bg-agentmobile-accent text-white border-none cursor-pointer disabled:opacity-50"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
            <button
              className="px-3 py-1.5 text-sm rounded-md bg-transparent border border-agentmobile-border text-agentmobile-text cursor-pointer"
              onClick={() => { setEdit({ ...EMPTY_EDIT }); setError('') }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // 列表视图
  return (
    <div className="border-t border-agentmobile-border pt-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] text-agentmobile-text-2 tracking-wider uppercase">
          {t('remote.remoteInstances')}
        </div>
        <button
          className="flex items-center gap-1 text-sm px-2 py-1 rounded-md border border-agentmobile-border text-agentmobile-text cursor-pointer hover:bg-agentmobile-bg-2"
          onClick={() => startEdit()}
        >
          <Icon name="plus" size={14} />
          <span>{t('remote.add')}</span>
        </button>
      </div>
      <p className="text-sm text-agentmobile-text-2 mb-3">{t('remote.desc')}</p>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {instances.length === 0 ? (
        <p className="text-sm text-agentmobile-text-2">{t('remote.noInstances')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {instances.map(inst => {
            const status = testStatus[inst.id] || 'idle'
            const isActive = !isLocal && currentId === inst.id
            return (
              <div key={inst.id} className="flex items-center gap-2 p-2.5 rounded-md border border-agentmobile-border bg-agentmobile-bg-2">
                <Icon name="cloud" size={16} className="text-agentmobile-text-2 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-agentmobile-text truncate flex items-center gap-1.5">
                    {inst.label}
                    {isActive && <span className="text-[10px] text-agentmobile-accent">●</span>}
                    {inst.hasRemoteToken
                      ? <span className="text-[10px] text-green-500">{t('remote.tokenCached')}</span>
                      : <span className="text-[10px] text-yellow-500">{t('remote.noToken')}</span>}
                  </div>
                  <div className="text-[11px] text-agentmobile-text-2 truncate">
                    {inst.useTls ? 'https' : 'http'}://{inst.host}:{inst.port}
                    {inst.authMode === 'ssh' && ` · ssh@${inst.username}`}
                  </div>
                  {status === 'fail' && <div className="text-[11px] text-red-400">{t('remote.testFailed')}</div>}
                  {status === 'ok' && <div className="text-[11px] text-green-500">{t('remote.testOk')}</div>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <IconBtn title={t('remote.test')} onClick={() => handleTest(inst)} disabled={status === 'testing'}>
                    {status === 'testing' ? <span className="text-xs">…</span> : <Icon name="wifi" size={14} />}
                  </IconBtn>
                  <IconBtn title={t('remote.login')} onClick={() => handleLogin(inst)}>
                    <Icon name="lock" size={14} />
                  </IconBtn>
                  <IconBtn title={t('common.edit')} onClick={() => startEdit(inst)}>
                    <Icon name="pencil" size={14} />
                  </IconBtn>
                  <IconBtn title={t('common.delete')} onClick={() => handleDelete(inst.id)}>
                    <Icon name="trash" size={14} />
                  </IconBtn>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const inputCls = "flex-1 bg-agentmobile-bg-2 border border-agentmobile-border rounded-md text-agentmobile-text text-sm px-2.5 py-1.5 outline-none"

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-[11px] text-agentmobile-text-2">{label}</span>
      {children}
    </label>
  )
}

function IconBtn({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="w-7 h-7 flex items-center justify-center rounded bg-transparent border-none text-agentmobile-text-2 cursor-pointer hover:bg-agentmobile-tab-active disabled:opacity-50"
    >
      {children}
    </button>
  )
}
