import assert from 'node:assert/strict';
import {
  AUTH_COOKIE_NAME,
  buildAuthCookie,
  buildClearAuthCookie,
  buildWebSocketAuthMessage,
  getCookieTokenFromHeader,
  getRequestToken,
  isSecureRequest,
} from '../auth.js';

assert.equal(getCookieTokenFromHeader(''), null);
assert.equal(getCookieTokenFromHeader(`${AUTH_COOKIE_NAME}=abc.def`), 'abc.def');
assert.equal(getCookieTokenFromHeader(`foo=1; ${AUTH_COOKIE_NAME}=a%20b; bar=2`), 'a b');
assert.equal(getCookieTokenFromHeader(`${AUTH_COOKIE_NAME}=`), null);

assert.equal(
  getRequestToken({
    headers: { authorization: 'Bearer header-token', cookie: `${AUTH_COOKIE_NAME}=cookie-token` },
    query: { token: 'query-token' },
  }),
  'header-token',
);
assert.equal(
  getRequestToken({
    headers: { cookie: `${AUTH_COOKIE_NAME}=cookie-token` },
    query: { token: 'query-token' },
  }),
  'cookie-token',
);
assert.equal(
  getRequestToken({ headers: {}, query: { token: 'query-token' } }, { allowQuery: false }),
  null,
);

const loginCookie = buildAuthCookie('tok en', { secure: true, maxAgeSeconds: 60 });
assert.match(loginCookie, new RegExp(`${AUTH_COOKIE_NAME}=tok%20en`));
assert.match(loginCookie, /HttpOnly/);
assert.match(loginCookie, /SameSite=Lax/);
assert.match(loginCookie, /Max-Age=60/);
assert.match(loginCookie, /Secure/);

const clearCookie = buildClearAuthCookie();
assert.match(clearCookie, new RegExp(`${AUTH_COOKIE_NAME}=`));
assert.match(clearCookie, /Max-Age=0/);
assert.doesNotMatch(clearCookie, /Secure/);

assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https' } }), true);
assert.equal(isSecureRequest({ headers: {}, protocol: 'http' }), false);
assert.equal(buildWebSocketAuthMessage('jwt-token'), '{"type":"auth","token":"jwt-token"}');

console.log('auth helper tests passed');
