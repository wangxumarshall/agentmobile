/**
 * Feishu card action callback server.
 *
 * Long-connection mode receives message events only. Interactive card button
 * callbacks still need an HTTP request URL, so the IM process exposes this
 * small endpoint alongside the WebSocket adapter.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { info, error, debug } from '../config/logger.js';

export const FEISHU_CARD_ACTION_PATH = '/api/webhooks/feishu/card-action';

export interface FeishuCardActionReceiver {
  handleCardActionPayload(data: unknown): Promise<boolean>;
}

export interface FeishuCardActionServerOptions {
  port: number;
  adapter: FeishuCardActionReceiver;
  verificationToken?: string;
  encryptKey?: string;
  path?: string;
  maxBodyBytes?: number;
}

export async function startFeishuCardActionServer(
  options: FeishuCardActionServerOptions,
): Promise<Server> {
  const larkModule = await import('@larksuiteoapi/node-sdk');
  const lark = larkModule.default || larkModule;
  const path = options.path || FEISHU_CARD_ACTION_PATH;
  const maxBodyBytes = options.maxBodyBytes || 1024 * 1024;

  const cardActionHandler = new lark.CardActionHandler(
    {
      verificationToken: options.verificationToken || '',
      encryptKey: options.encryptKey || '',
      loggerLevel: lark.LoggerLevel?.info ?? 'info',
    },
    async (data: unknown) => {
      await options.adapter.handleCardActionPayload(data);
      return {};
    },
  );

  const server = createServer(async (req, res) => {
    const pathname = getPathname(req);
    if (req.method !== 'POST' || pathname !== path) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }

    try {
      const body = await readJsonBody(req, maxBodyBytes);
      const sdkPayload = Object.assign(Object.create({ headers: req.headers }), body);

      const challenge = maybeGenerateChallenge(lark, sdkPayload, options.encryptKey || '');
      if (challenge) {
        sendJson(res, 200, challenge);
        return;
      }

      const result = await cardActionHandler.invoke(sdkPayload);
      sendJson(res, 200, result || {});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      error('feishu-card-action', `Callback failed: ${message}`);
      sendJson(res, 400, { ok: false, error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once('error', onError);
    server.listen(options.port, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : options.port;
  info('feishu-card-action', `Listening on port ${actualPort} path ${path}`);
  return server;
}

function getPathname(req: IncomingMessage): string {
  return new URL(req.url || '/', 'http://localhost').pathname;
}

async function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) {
      throw new Error('request body too large');
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};

  const raw = Buffer.concat(chunks).toString('utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function maybeGenerateChallenge(
  lark: any,
  data: Record<string, unknown>,
  encryptKey: string,
): Record<string, unknown> | null {
  if (!('type' in data) && !('encrypt' in data)) return null;
  const generated = lark.generateChallenge(data, { encryptKey });
  return generated?.isChallenge ? generated.challenge : null;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
  debug('feishu-card-action', `Responded ${statusCode}`);
}
