export const AUTH_COOKIE_NAME = 'agentmobile_token';

export function getCookieTokenFromHeader(cookieHeader = '') {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (rawKey !== AUTH_COOKIE_NAME) continue;
    const rawValue = rest.join('=');
    if (!rawValue) return null;
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return null;
}

export function getCookieToken(req) {
  return getCookieTokenFromHeader(req.headers?.cookie || '');
}

export function getRequestToken(req, options = {}) {
  const { allowQuery = true } = options;
  const auth = req.headers?.authorization || '';
  const headerToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const cookieToken = getCookieToken(req);
  const queryToken = allowQuery && typeof req.query?.token === 'string' ? req.query.token : null;
  return headerToken || cookieToken || queryToken;
}

export function isSecureRequest(req) {
  return String(req.headers?.['x-forwarded-proto'] || req.protocol || '').includes('https');
}

export function buildAuthCookie(token, options = {}) {
  const { secure = false, maxAgeSeconds = 2592000 } = options;
  const cookieAttrs = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) cookieAttrs.push('Secure');
  return cookieAttrs.join('; ');
}

export function buildClearAuthCookie(options = {}) {
  const { secure = false } = options;
  const cookieAttrs = [
    `${AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) cookieAttrs.push('Secure');
  return cookieAttrs.join('; ');
}

export function buildWebSocketAuthMessage(token) {
  return JSON.stringify({ type: 'auth', token });
}
