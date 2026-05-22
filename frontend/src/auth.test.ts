import assert from 'node:assert/strict'
import {
  AUTH_TOKEN_STORAGE_KEY,
  buildWebSocketAuthMessage,
  checkCookieSession,
  clearAuthAndReload,
  clearStoredAuth,
  type AuthFetch,
} from './auth'

function responseWithStatus(status: number): Response {
  return new Response(null, { status })
}

async function main() {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  const okFetch: AuthFetch = async (input, init) => {
    calls.push({ input, init })
    return responseWithStatus(204)
  }

  assert.equal(await checkCookieSession(okFetch), 'valid')
  assert.equal(calls[0]?.input, '/api/auth/session')
  assert.deepEqual(calls[0]?.init, { credentials: 'same-origin' })

  const unauthorizedFetch: AuthFetch = async () => responseWithStatus(401)
  assert.equal(await checkCookieSession(unauthorizedFetch), 'unauthorized')

  const serverErrorFetch: AuthFetch = async () => responseWithStatus(500)
  assert.equal(await checkCookieSession(serverErrorFetch), 'error')

  const throwingFetch: AuthFetch = async () => {
    throw new TypeError('network down')
  }
  assert.equal(await checkCookieSession(throwingFetch), 'error')

  const removedKeys: string[] = []
  const storage: Pick<Storage, 'removeItem'> = {
    removeItem(key: string) {
      removedKeys.push(key)
    },
  }
  let reloaded = false
  const location: Pick<Location, 'reload'> = {
    reload() {
      reloaded = true
    },
  }

  clearStoredAuth(storage)
  assert.deepEqual(removedKeys, [AUTH_TOKEN_STORAGE_KEY])

  clearAuthAndReload(storage, location)
  assert.deepEqual(removedKeys, [AUTH_TOKEN_STORAGE_KEY, AUTH_TOKEN_STORAGE_KEY])
  assert.equal(reloaded, true)
  assert.equal(buildWebSocketAuthMessage('jwt-token'), '{"type":"auth","token":"jwt-token"}')

  console.log('frontend auth tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
