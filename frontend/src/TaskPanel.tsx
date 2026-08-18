import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiUrl } from './api'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { Icon } from './icons'

type AgentType = 'claude' | 'codex' | 'trae' | 'opencode'

interface ConfigProfile {
  id: string
  label: string
  agent_type?: AgentType
}

interface TaskRecord {
  id: string
  session_name: string
  prompt: string
  status: 'running' | 'success' | 'error'
  output: string
  error: string
  createdAt: string
  updatedAt?: string
  completedAt?: string
  source?: string
  agent_type?: AgentType
  tmux_session?: string
  last_seq?: number
  exitCode?: number | null
}

interface Props {
  token: string
  currentProject: string
  currentChannelName: string | null
  onClose: () => void
}

interface ResumeState {
  lastSeq: number
}

interface ParsedSseEvent {
  event: string
  data: unknown
}

const TASK_STREAM_STATE_KEY = 'agentmobile_task_stream_state_v1'
const TASK_OUTPUT_LIMIT = 10000
const TASK_ERROR_LIMIT = 1000
const AGENT_OPTIONS: Array<{ value: AgentType; label: string }> = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'trae', label: 'Trae CLI' },
  { value: 'opencode', label: 'OpenCode' },
]

function loadResumeState(): Record<string, ResumeState> {
  try {
    const raw = localStorage.getItem(TASK_STREAM_STATE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, ResumeState>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function formatDateTime(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

async function parseApiError(r: Response, fallback: string): Promise<string> {
  try {
    const data = await r.json()
    if (typeof data?.error === 'string' && data.error) return data.error
  } catch {
    // ignore invalid JSON bodies
  }
  return fallback
}

function sortTasks(tasks: TaskRecord[]): TaskRecord[] {
  return [...tasks].sort((a, b) => {
    const left = Date.parse(b.createdAt || '') || 0
    const right = Date.parse(a.createdAt || '') || 0
    return left - right
  })
}

function parseSseChunk(chunk: string): ParsedSseEvent | null {
  const lines = chunk.split(/\r?\n/)
  let event = 'message'
  const dataLines: string[] = []

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  if (dataLines.length === 0) return null
  const raw = dataLines.join('\n')
  try {
    return { event, data: JSON.parse(raw) }
  } catch {
    return { event, data: raw }
  }
}

async function readSseResponse(response: Response, onEvent: (event: ParsedSseEvent) => boolean | void): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const parsed = parseSseChunk(rawEvent)
      if (parsed) {
        const shouldStop = onEvent(parsed)
        if (shouldStop === true) {
          await reader.cancel()
          return
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}

export default function TaskPanel({ token, currentProject, currentChannelName, onClose }: Props) {
  const { t } = useTranslation()
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [profiles, setProfiles] = useState<ConfigProfile[]>([])
  const [prompt, setPrompt] = useState('')
  const [agentType, setAgentType] = useState<AgentType>(() => {
    const saved = localStorage.getItem('agentmobile_task_agent')
    return AGENT_OPTIONS.some(option => option.value === saved) ? (saved as AgentType) : 'claude'
  })
  const [selectedProfile, setSelectedProfile] = useState(() => localStorage.getItem('agentmobile_task_profile') || '')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tasksRef = useRef<TaskRecord[]>([])
  const eventSourcesRef = useRef<Map<string, EventSource>>(new Map())
  const startControllerRef = useRef<AbortController | null>(null)
  const resumeStateRef = useRef<Record<string, ResumeState>>(loadResumeState())

  const filteredProfiles = useMemo(
    () => profiles.filter(profile => (profile.agent_type || 'claude') === agentType),
    [profiles, agentType],
  )

  const selectedTask = useMemo(
    () => tasks.find(task => task.id === selectedTaskId) || null,
    [tasks, selectedTaskId],
  )

  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  useEffect(() => {
    localStorage.setItem('agentmobile_task_agent', agentType)
  }, [agentType])

  useEffect(() => {
    if (!selectedProfile) return
    if (filteredProfiles.some(profile => profile.id === selectedProfile)) return
    setSelectedProfile('')
  }, [filteredProfiles, selectedProfile])

  useEffect(() => {
    if (selectedProfile) {
      localStorage.setItem('agentmobile_task_profile', selectedProfile)
    } else {
      localStorage.removeItem('agentmobile_task_profile')
    }
  }, [selectedProfile])

  const persistResumeState = useCallback(() => {
    localStorage.setItem(TASK_STREAM_STATE_KEY, JSON.stringify(resumeStateRef.current))
  }, [])

  const updateResumeSeq = useCallback((taskId: string, seq?: number) => {
    if (typeof seq !== 'number' || Number.isNaN(seq)) return
    const current = resumeStateRef.current[taskId]?.lastSeq ?? 0
    if (seq <= current) return
    resumeStateRef.current = {
      ...resumeStateRef.current,
      [taskId]: { lastSeq: seq },
    }
    persistResumeState()
  }, [persistResumeState])

  const closeTaskStream = useCallback((taskId: string) => {
    const source = eventSourcesRef.current.get(taskId)
    if (!source) return
    source.close()
    eventSourcesRef.current.delete(taskId)
  }, [])

  const upsertTask = useCallback((incoming: TaskRecord) => {
    setTasks(previous => {
      const next = [...previous]
      const index = next.findIndex(task => task.id === incoming.id)
      if (index === -1) {
        next.unshift(incoming)
      } else {
        next[index] = { ...next[index], ...incoming }
      }
      return sortTasks(next)
    })
  }, [])

  const patchTask = useCallback((taskId: string, patch: Partial<TaskRecord> | ((current: TaskRecord) => TaskRecord)) => {
    setTasks(previous => {
      const index = previous.findIndex(task => task.id === taskId)
      if (index === -1) return previous
      const current = previous[index]
      const updated = typeof patch === 'function' ? patch(current) : { ...current, ...patch }
      const next = [...previous]
      next[index] = updated
      return sortTasks(next)
    })
  }, [])

  const handleSnapshot = useCallback((task: TaskRecord) => {
    updateResumeSeq(task.id, task.last_seq)
    upsertTask(task)
    if (!selectedTaskId) setSelectedTaskId(task.id)
    if (task.status !== 'running') closeTaskStream(task.id)
  }, [closeTaskStream, selectedTaskId, updateResumeSeq, upsertTask])

  const handleChunk = useCallback((taskId: string, seq: number | undefined, chunk: string, isErr: boolean) => {
    const previousSeq = resumeStateRef.current[taskId]?.lastSeq ?? 0
    if (typeof seq === 'number' && seq <= previousSeq) return
    updateResumeSeq(taskId, seq)
    patchTask(taskId, current => ({
      ...current,
      status: 'running',
      updatedAt: new Date().toISOString(),
      output: isErr ? current.output : (current.output + chunk).slice(-TASK_OUTPUT_LIMIT),
      error: isErr ? (current.error + chunk).slice(-TASK_ERROR_LIMIT) : current.error,
      last_seq: typeof seq === 'number' ? seq : current.last_seq,
    }))
  }, [patchTask, updateResumeSeq])

  const handleDone = useCallback((taskId: string, seq: number | undefined, status: TaskRecord['status'], exitCode: number | null | undefined) => {
    closeTaskStream(taskId)
    updateResumeSeq(taskId, seq)
    patchTask(taskId, current => ({
      ...current,
      status,
      exitCode: exitCode ?? current.exitCode ?? null,
      completedAt: current.completedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      last_seq: typeof seq === 'number' ? seq : current.last_seq,
    }))
  }, [closeTaskStream, patchTask, updateResumeSeq])

  const openTaskStream = useCallback((taskId: string) => {
    if (eventSourcesRef.current.has(taskId)) return

    const fromSeq = resumeStateRef.current[taskId]?.lastSeq ?? 0
    const url = apiUrl(`/api/tasks/${encodeURIComponent(taskId)}/events?from_seq=${fromSeq}`)
    const source = new EventSource(url)

    source.addEventListener('snapshot', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { task?: TaskRecord }
        if (payload.task) handleSnapshot(payload.task)
      } catch {
        // ignore malformed SSE payloads
      }
    })

    source.addEventListener('output', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { taskId: string; seq: number; chunk: string }
        handleChunk(payload.taskId, payload.seq, payload.chunk, false)
      } catch {
        // ignore malformed SSE payloads
      }
    })

    source.addEventListener('error', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { taskId: string; seq: number; chunk: string }
        handleChunk(payload.taskId, payload.seq, payload.chunk, true)
      } catch {
        // ignore malformed SSE payloads
      }
    })

    source.addEventListener('done', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          taskId: string
          seq: number
          status: TaskRecord['status']
          exitCode?: number | null
        }
        handleDone(payload.taskId, payload.seq, payload.status, payload.exitCode)
      } catch {
        // ignore malformed SSE payloads
      }
    })

    source.onerror = () => {
      const current = tasksRef.current.find(task => task.id === taskId)
      if (current && current.status !== 'running') closeTaskStream(taskId)
    }

    eventSourcesRef.current.set(taskId, source)
  }, [closeTaskStream, handleChunk, handleDone, handleSnapshot, token])

  const syncRunningSubscriptions = useCallback((nextTasks: TaskRecord[]) => {
    const runningTaskIds = new Set(nextTasks.filter(task => task.status === 'running').map(task => task.id))
    for (const taskId of runningTaskIds) openTaskStream(taskId)
    for (const [taskId, source] of Array.from(eventSourcesRef.current.entries())) {
      if (runningTaskIds.has(taskId)) continue
      source.close()
      eventSourcesRef.current.delete(taskId)
    }
  }, [openTaskStream])

  const fetchProfiles = useCallback(async () => {
    try {
      const response = await fetch(apiUrl('/api/configs'), {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) return
      const data = await response.json() as ConfigProfile[]
      setProfiles(data)
    } catch {
      // ignore passive failures
    }
  }, [token])

  const fetchTasks = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true)
    try {
      const response = await fetch(apiUrl('/api/tasks'), {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        setError(await parseApiError(response, t('tasks.requestFailed', { status: response.status })))
        return
      }
      const data = await response.json() as TaskRecord[]
      const sorted = sortTasks(data)
      setTasks(sorted)
      if (!selectedTaskId && sorted.length > 0) {
        const running = sorted.find(task => task.status === 'running')
        setSelectedTaskId((running || sorted[0]).id)
      }
      syncRunningSubscriptions(sorted)
      setError(null)
    } catch {
      setError(t('login.connectionFailed'))
    } finally {
      setLoading(false)
      if (!silent) setRefreshing(false)
    }
  }, [selectedTaskId, syncRunningSubscriptions, t, token])

  useEffect(() => {
    fetchProfiles()
    fetchTasks()
    const interval = window.setInterval(() => { fetchTasks(true) }, 10000)
    return () => window.clearInterval(interval)
  }, [fetchProfiles, fetchTasks])

  useEffect(() => {
    return () => {
      startControllerRef.current?.abort()
      startControllerRef.current = null
      for (const source of eventSourcesRef.current.values()) source.close()
      eventSourcesRef.current.clear()
    }
  }, [])

  useEffect(() => {
    if (!selectedTaskId && tasks.length > 0) {
      setSelectedTaskId(tasks[0].id)
      return
    }
    if (selectedTaskId && !tasks.some(task => task.id === selectedTaskId)) {
      setSelectedTaskId(tasks[0]?.id || null)
    }
  }, [selectedTaskId, tasks])

  const handleStartTask = useCallback(async () => {
    const nextPrompt = prompt.trim()
    if (!nextPrompt) return
    if (!currentChannelName) {
      setError(t('tasks.noActiveChannel'))
      return
    }

    startControllerRef.current?.abort()
    const controller = new AbortController()
    startControllerRef.current = controller
    setSubmitting(true)
    setError(null)

    let startedTaskId: string | null = null

    try {
      const response = await fetch(apiUrl('/api/tasks'), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session_name: currentChannelName,
          prompt: nextPrompt,
          profile: selectedProfile || undefined,
          tmux_session: currentProject,
          agent_type: agentType,
        }),
      })

      if (!response.ok) {
        setError(await parseApiError(response, t('tasks.requestFailed', { status: response.status })))
        return
      }

      await readSseResponse(response, (event) => {
        if (event.event !== 'start') return false
        const payload = event.data as {
          taskId: string
          session_name?: string
          prompt?: string
          createdAt?: string
        }
        startedTaskId = payload.taskId
        const createdAt = payload.createdAt || new Date().toISOString()
        upsertTask({
          id: payload.taskId,
          session_name: payload.session_name || currentChannelName,
          prompt: payload.prompt || nextPrompt,
          status: 'running',
          output: '',
          error: '',
          createdAt,
          updatedAt: createdAt,
          source: 'web',
          agent_type: agentType,
          tmux_session: currentProject,
          last_seq: 0,
        })
        setSelectedTaskId(payload.taskId)
        setPrompt('')
        controller.abort()
        openTaskStream(payload.taskId)
        return true
      })

      if (!startedTaskId) {
        setError(t('tasks.startFailed'))
      }
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError' && startedTaskId)) {
        setError(t('login.connectionFailed'))
      }
    } finally {
      if (startControllerRef.current === controller) startControllerRef.current = null
      setSubmitting(false)
    }
  }, [agentType, currentChannelName, currentProject, openTaskStream, prompt, selectedProfile, t, token, upsertTask])

  const handleDeleteTask = useCallback(async (taskId: string) => {
    const confirmed = window.confirm(t('tasks.deleteConfirm'))
    if (!confirmed) return
    try {
      const response = await fetch(apiUrl(`/api/tasks/${encodeURIComponent(taskId)}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        setError(await parseApiError(response, t('tasks.requestFailed', { status: response.status })))
        return
      }
      closeTaskStream(taskId)
      setTasks(previous => previous.filter(task => task.id !== taskId))
      if (selectedTaskId === taskId) {
        const remaining = tasksRef.current.filter(task => task.id !== taskId)
        setSelectedTaskId(remaining[0]?.id || null)
      }
    } catch {
      setError(t('login.connectionFailed'))
    }
  }, [closeTaskStream, selectedTaskId, t, token])

  return (
    <div className="fixed inset-0 z-[460] bg-agentmobile-bg flex flex-col">
      <GhostShield />

      <div className="flex items-center justify-between px-4 py-3.5 border-b border-agentmobile-border shrink-0">
        <div className="flex items-center gap-2.5">
          <Icon name="history" size={20} />
          <span className="text-agentmobile-text font-semibold text-base">{t('tasks.title')}</span>
          <span className="text-agentmobile-muted text-[13px] bg-agentmobile-bg-2 px-2 py-0.5 rounded-[10px]">
            {tasks.length}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => { void fetchTasks() }}
            className="bg-transparent border border-agentmobile-border rounded-md text-agentmobile-text-2 cursor-pointer px-2.5 py-1.5 flex items-center gap-1 text-xs"
            disabled={refreshing}
            title={t('common.refresh')}
          >
            <Icon name="refresh" size={14} />
            <span>{refreshing ? t('common.loading') : t('common.refresh')}</span>
          </button>
          <button
            onClick={onClose}
            className="bg-transparent border-none text-agentmobile-text-2 cursor-pointer p-1.5 flex items-center justify-center rounded-md"
            title={t('common.close')}
          >
            <Icon name="x" size={20} />
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 flex-col lg:flex-row">
        <div className="w-full lg:w-[360px] lg:border-r border-agentmobile-border flex flex-col min-h-0 shrink-0">
          <div className="px-4 py-4 border-b border-agentmobile-border flex flex-col gap-3 shrink-0">
            <div className="rounded-lg border border-agentmobile-border bg-agentmobile-bg-2 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-agentmobile-text-2 mb-1">{t('tasks.currentTarget')}</div>
              <div className="text-sm text-agentmobile-text font-mono break-all">
                {currentChannelName ? `${currentProject} / ${currentChannelName}` : t('tasks.noActiveChannel')}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-xs text-agentmobile-text-2">
                <span>{t('tasks.agentType')}</span>
                <select
                  value={agentType}
                  onChange={(event) => setAgentType(event.target.value as AgentType)}
                  className="bg-agentmobile-bg-2 border border-agentmobile-border rounded-md text-agentmobile-text text-sm px-2.5 py-2 outline-none"
                >
                  {AGENT_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs text-agentmobile-text-2">
                <span>{t('tasks.profile')}</span>
                <select
                  value={selectedProfile}
                  onChange={(event) => setSelectedProfile(event.target.value)}
                  className="bg-agentmobile-bg-2 border border-agentmobile-border rounded-md text-agentmobile-text text-sm px-2.5 py-2 outline-none"
                >
                  <option value="">{t('newChannel.profileDefault')}</option>
                  {filteredProfiles.map(profile => (
                    <option key={profile.id} value={profile.id}>{profile.label}</option>
                  ))}
                </select>
              </label>
            </div>

            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={t('tasks.promptPlaceholder')}
              rows={5}
              className="w-full bg-agentmobile-bg-2 border border-agentmobile-border rounded-lg text-agentmobile-text text-sm p-3 resize-none outline-none"
            />

            <button
              onClick={() => { void handleStartTask() }}
              disabled={submitting || !prompt.trim() || !currentChannelName}
              className={`w-full rounded-lg text-white text-sm font-semibold py-2.5 px-4 border-none ${
                submitting || !prompt.trim() || !currentChannelName ? 'bg-agentmobile-muted cursor-not-allowed' : 'bg-agentmobile-accent cursor-pointer'
              }`}
            >
              {submitting ? t('tasks.running') : t('tasks.sendTask')}
            </button>

            <p className="text-[11px] text-agentmobile-text-2 leading-5">
              {t('tasks.resumeNotice')}
            </p>

            {error && (
              <div className="text-xs text-agentmobile-error rounded-md border border-agentmobile-error/40 bg-agentmobile-bg px-3 py-2">
                {error}
              </div>
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
            <div className="text-[11px] uppercase tracking-wide text-agentmobile-text-2 px-1 pb-2">
              {t('tasks.history')}
            </div>

            {loading ? (
              <div className="text-agentmobile-muted text-sm px-1 py-6">{t('common.loading')}</div>
            ) : tasks.length === 0 ? (
              <div className="text-agentmobile-muted text-sm px-1 py-6">{t('tasks.noTasks')}</div>
            ) : (
              <div className="flex flex-col gap-2">
                {tasks.map(task => {
                  const isSelected = task.id === selectedTaskId
                  const statusColor = task.status === 'running'
                    ? 'var(--agentmobile-success)'
                    : task.status === 'success'
                      ? 'var(--agentmobile-accent)'
                      : 'var(--agentmobile-error)'

                  return (
                    <button
                      key={task.id}
                      onClick={() => setSelectedTaskId(task.id)}
                      className={`w-full text-left rounded-lg border px-3 py-3 transition-colors ${
                        isSelected
                          ? 'bg-agentmobile-bg-2 border-agentmobile-accent'
                          : 'bg-transparent border-agentmobile-border'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className="w-2 h-2 rounded-full mt-1 shrink-0"
                          style={{ background: statusColor }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-agentmobile-text text-sm font-medium truncate">
                              {task.prompt || t('tasks.noOutput')}
                            </span>
                            <span className="text-[11px] text-agentmobile-text-2 shrink-0">
                              {task.agent_type || 'claude'}
                            </span>
                          </div>
                          <div className="text-[11px] text-agentmobile-text-2 mt-1 truncate">
                            {(task.tmux_session || currentProject)} / {task.session_name || 'default'}
                          </div>
                          <div className="text-[11px] text-agentmobile-text-2 mt-1 flex items-center justify-between gap-2">
                            <span className="truncate">{formatDateTime(task.updatedAt || task.createdAt)}</span>
                            <span className="shrink-0">{task.source || 'web'}</span>
                          </div>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-4 py-3 border-b border-agentmobile-border flex items-start justify-between gap-3 shrink-0">
            {selectedTask ? (
              <>
                <div className="min-w-0">
                  <div className="text-agentmobile-text text-sm font-semibold truncate">
                    {selectedTask.prompt}
                  </div>
                  <div className="text-agentmobile-text-2 text-xs mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    <span>{t('tasks.project')}: {selectedTask.tmux_session || currentProject}</span>
                    <span>{t('tasks.channel')}: {selectedTask.session_name || 'default'}</span>
                    <span>{t('tasks.source')}: {selectedTask.source || 'web'}</span>
                    <span>{t('tasks.startedAt')}: {formatDateTime(selectedTask.createdAt)}</span>
                    <span>{t('tasks.updatedAt')}: {formatDateTime(selectedTask.updatedAt || selectedTask.createdAt)}</span>
                    {selectedTask.completedAt && (
                      <span>{t('tasks.completedAt')}: {formatDateTime(selectedTask.completedAt)}</span>
                    )}
                  </div>
                </div>
                {selectedTask.status !== 'running' && (
                  <button
                    onClick={() => { void handleDeleteTask(selectedTask.id) }}
                    className="bg-transparent border border-agentmobile-error text-agentmobile-error cursor-pointer px-2.5 py-1.5 flex items-center gap-1 rounded-md text-xs font-medium shrink-0"
                  >
                    <Icon name="trash" size={14} />
                    <span>{t('common.delete')}</span>
                  </button>
                )}
              </>
            ) : (
              <div className="text-agentmobile-text-2 text-sm">{t('tasks.selectTask')}</div>
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
            {selectedTask ? (
              <div className="flex flex-col gap-4 min-h-full">
                <div className="rounded-lg border border-agentmobile-border bg-agentmobile-bg-2 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-agentmobile-text-2 mb-2">{t('tasks.output')}</div>
                  <pre className="whitespace-pre-wrap break-words text-agentmobile-text text-sm font-mono leading-6 min-h-[180px]">
                    {selectedTask.output || (selectedTask.status === 'running' ? t('tasks.waitingOutput') : t('tasks.noOutput'))}
                  </pre>
                </div>

                {selectedTask.error && (
                  <div className="rounded-lg border border-agentmobile-error/50 bg-agentmobile-bg-2 p-3">
                    <div className="text-[11px] uppercase tracking-wide text-agentmobile-error mb-2">{t('tasks.stderr')}</div>
                    <pre className="whitespace-pre-wrap break-words text-agentmobile-error text-sm font-mono leading-6">
                      {selectedTask.error}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-agentmobile-text-2 text-sm">
                {t('tasks.selectTask')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
