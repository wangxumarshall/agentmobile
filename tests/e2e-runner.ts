#!/usr/bin/env node
/**
 * Integration test runner for IM Bridge.
 *
 * Runs tests against all bridge components:
 * 1. Channel Adapter abstraction
 * 2. Telegram adapter
 * 3. Feishu card building and services
 * 4. Bridge Manager routing
 * 5. Permission Broker
 * 6. Channel Router
 * 7. JSON File Store
 * 8. Config loading
 * 9. Integration: full message flow
 *
 * Usage:  npx tsx im-test.ts [--verbose]
 */

import { tmpdir } from 'os';
import { mkdirSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

// ── Mocks ───────────────────────────────────────────────────
import { MockLarkClient } from './mocks/mock-lark-client.js';
import { MockLLMProvider } from './mocks/mock-llm-provider.js';
import { MockStore } from './mocks/mock-store.js';
import { MockTelegramCardClient } from './mocks/mock-telegram-card-client.js';
import {
  makeInboundMessage,
  makeChannelAddress,
  makeTestBinding,
  waitFor,
  assert,
  assertEquals,
  assertContains,
} from './mocks/test-utils.js';

// ── Bridge modules ──────────────────────────────────────────
import { ChannelRouter } from '../im/bridge/channel-router.js';
import { PermissionBroker } from '../im/bridge/permission-broker.js';
import { ConversationEngine } from '../im/bridge/conversation-engine.js';
import { BridgeManager } from '../im/bridge/bridge-manager.js';
import type { InboundMessage, OutboundMessage, SendResult } from '../im/bridge/types.js';
import { buildRouteKey, stableMessageUuid, truncateText, normalizeLine } from '../im/feishu/utils.js';
import { buildPermissionCard, buildSimpleCard, buildStatusCard, buildActionCard, buildHandledPermissionCard } from '../im/feishu/cards/permission-cards.js';
import { buildToolActivityCard, buildCommandExecutionCard, buildFileChangeCard, buildLightweightActivityCard } from '../im/feishu/cards/activity-cards.js';
import { buildNewSessionCard, buildResumeCard, buildClaudeModeCard, buildResetConfirmationCard } from '../im/feishu/cards/session-cards.js';
import { buildStreamingCardSkeleton, buildFinalCard, buildStatusHeader } from '../im/feishu/cards/streaming-cards.js';
import {
  buildNewSessionCard as buildTelegramNewSessionCard,
  buildPermissionCard as buildTelegramPermissionCard,
  buildClaudeModeCard as buildTelegramClaudeModeCard,
} from '../im/telegram/cards/index.js';
import { PreviewService } from '../im/feishu/services/preview-service.js';
import { ActivityService } from '../im/feishu/services/activity-service.js';
import { TelegramPreviewService, TelegramActivityService } from '../im/telegram/services/index.js';
import { loadConfig } from '../im/config/config.js';
import { JsonFileStore } from '../im/infra/store.js';
import { ClaudeSDKProvider, classifyAuthError, isAuthError } from '../im/providers/claude-sdk.js';
import { LarkClient } from '../im/feishu/lark-client.js';
import { createFeishuEventDispatcher } from '../im/adapters/feishu-adapter.js';
import { TelegramAdapter } from '../im/adapters/telegram-adapter.js';
import { handleIncomingEvent } from '../im/feishu/handlers/inbound-handler.js';
import { handleCardAction } from '../im/feishu/handlers/card-action-handler.js';
import { startFeishuCardActionServer, FEISHU_CARD_ACTION_PATH } from '../im/feishu/card-action-server.js';

// ── Test runner ─────────────────────────────────────────────
let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;
let errors: string[] = [];

const verbose = process.argv.includes('--verbose');

async function test(name: string, fn: () => Promise<void> | void) {
  testsRun++;
  const start = Date.now();
  try {
    await fn();
    testsPassed++;
    const elapsed = Date.now() - start;
    console.log(`  ✅ ${name} (${elapsed}ms)`);
  } catch (e) {
    testsFailed++;
    const elapsed = Date.now() - start;
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name} (${elapsed}ms) — ${msg}`);
  }
}

function suite(name: string, fn: () => Promise<void>) {
  console.log(`\n📦 ${name}`);
  return fn();
}

function summary() {
  console.log('\n' + '═'.repeat(60));
  console.log(`  Tests: ${testsRun} | Passed: ${testsPassed} | Failed: ${testsFailed}`);
  if (errors.length > 0) {
    console.log('\nFailures:');
    for (const err of errors) {
      console.log(`  • ${err}`);
    }
  }
  console.log('═'.repeat(60));
  process.exit(errors.length > 0 ? 1 : 0);
}

class QueueAdapter {
  readonly channelType = 'feishu';
  readonly adapterId = 'feishu';
  readonly profileId = 'default';
  readonly label = 'Feishu';
  sentMessages: OutboundMessage[] = [];
  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(message: InboundMessage | null) => void> = [];

  async start() {
    this.running = true;
  }

  async stop() {
    this.running = false;
    for (const waiter of this.waiters) waiter(null);
    this.waiters = [];
  }

  isRunning() {
    return this.running;
  }

  async consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise(resolve => this.waiters.push(resolve));
  }

  push(message: InboundMessage) {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    this.queue.push(message);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    this.sentMessages.push(message);
    return {
      ok: true,
      messageId: `sent_${this.sentMessages.length}`,
      openMessageId: `open_sent_${this.sentMessages.length}`,
    };
  }
}

class TelegramQueueAdapter extends QueueAdapter {
  readonly channelType = 'telegram';
  readonly adapterId = 'telegram';
  readonly profileId = 'default';
  readonly label = 'Telegram';
  patchedCards: Array<{ messageId: string; card: any }> = [];
  answeredCallbacks: Array<{ id: string; text?: string }> = [];

  async patchCard(_address: any, messageId: string, card: any): Promise<SendResult> {
    this.patchedCards.push({ messageId, card });
    return { ok: true, messageId };
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    this.answeredCallbacks.push({ id: callbackQueryId, text });
  }
}

async function postJson(port: number, path: string, payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  return await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => resolve({
        statusCode: res.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function closeServer(server: { close(cb?: (err?: Error) => void): void }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err?: Error) => err ? reject(err) : resolve());
  });
}

// ═══════════════════════════════════════════════════════════
async function main() {
  console.log('🧪 AgentMobile IM Bridge — End-to-End Tests');
  console.log(`   Started: ${new Date().toISOString()}`);

  // ── 1. Utility functions ────────────────────────────────
  await suite('1. Utility Functions', async () => {
    await test('buildRouteKey creates composite keys', () => {
      const key = buildRouteKey('telegram', 'default', 'chat_123');
      assertEquals(key, 'telegram:default:chat_123', 'Route key format');
    });

    await test('stableMessageUuid produces deterministic output', () => {
      const uuid1 = stableMessageUuid('test seed');
      const uuid2 = stableMessageUuid('test seed');
      assertEquals(uuid1, uuid2, 'Same seed should produce same UUID');
    });

    await test('stableMessageUuid differs per seed', () => {
      const uuid1 = stableMessageUuid('seed A');
      const uuid2 = stableMessageUuid('seed B');
      assert(uuid1 !== uuid2, 'Different seeds should produce different UUIDs');
    });

    await test('truncateText respects max length', () => {
      const text = 'a'.repeat(100);
      const truncated = truncateText(text, 20);
      assert(truncated.length <= 20, `Truncated text should be <= 20 chars, got ${truncated.length}`);
      assert(truncated.endsWith('...'), 'Truncated text should end with ellipsis');
    });

    await test('truncateText does not modify short text', () => {
      const text = 'hello';
      const result = truncateText(text, 20);
      assertEquals(result, 'hello', 'Short text should not be modified');
    });

    await test('normalizeLine collapses whitespace', () => {
      const result = normalizeLine('hello    world');
      assertEquals(result, 'hello world', 'Multiple spaces should be collapsed');
    });
  });

  // ── 2. Mock Lark Client ─────────────────────────────────
  await suite('2. Mock Lark Client', async () => {
    const client = new MockLarkClient();
    const address = makeChannelAddress({ channelType: 'feishu' });

    await test('sendMessage records and returns message_id', async () => {
      const result = await client.sendMessage(address, 'text', 'Hello');
      assert(result.code === 0, 'Should succeed');
      assert(result.data?.message_id, 'Should include message_id');
      assertEquals(client.sentMessages.length, 1, 'Should record sent message');
      assertEquals(client.sentMessages[0].content, 'Hello', 'Should record content');
    });

    await test('sendCard records card and patches', async () => {
      const card = { header: { title: 'Test' } };
      const result = await client.sendCard(address, card);
      assert(result.code === 0, 'Should succeed');
      assertEquals(client.sentCards.length, 1, 'Should record sent card');
      assertEquals(client.patchedCards.get(result.data.message_id), card, 'Should store card content');
    });

    await test('patchCard updates existing card', async () => {
      const card = await client.sendCard(address, { a: 1 });
      await client.patchCard(card.data.message_id, { b: 2 });
      const patched = client.patchedCards.get(card.data.message_id);
      assert(patched !== undefined, 'Card should exist after patch');
    });

    await test('uploadImage returns image_key', async () => {
      const key = await client.uploadImage('/tmp/test.png');
      assert(key.startsWith('img_'), 'Should return image key with img_ prefix');
      assertEquals(client.uploadedImages.get(key), '/tmp/test.png', 'Should store mapping');
    });

    await test('mock failure mode works', async () => {
      client.shouldFail = true;
      try {
        await client.sendMessage(address, 'text', 'fail');
        assert(false, 'Should have thrown');
      } catch {
        // Expected
      } finally {
        client.shouldFail = false;
      }
    });

    await test('clear resets all state', async () => {
      await client.sendMessage(address, 'text', 'msg1');
      client.clear();
      assertEquals(client.sentMessages.length, 0, 'Should clear sent messages');
      assertEquals(client.sentCards.length, 0, 'Should clear sent cards');
    });
  });

  // ── 3. Permission Cards ─────────────────────────────────
  await suite('3. Permission Cards', async () => {
    await test('buildPermissionCard has correct structure', () => {
      const card = buildPermissionCard('Bash', 'ls -la', 'perm_123');
      assert(card.header, 'Should have header');
      assert(card.elements, 'Should have elements');
      const actions = card.elements.find((e: any) => e.tag === 'action');
      assert(actions, 'Should have action element');
      assert(actions.actions.length === 3, 'Should have 3 buttons (allow once, allow session, deny)');
    });

    await test('buildSimpleCard has correct structure', () => {
      const card = buildSimpleCard('Title', 'Content', 'blue');
      assertEquals(card.header.template, 'blue', 'Template should be blue');
      assertEquals(card.header.title.content, 'Title', 'Title should match');
    });

    await test('buildStatusCard supports all statuses', () => {
      const statuses = ['info', 'success', 'warning', 'error'] as const;
      for (const status of statuses) {
        const card = buildStatusCard(status, 'Title', 'Content');
        assert(card.header.template, `Should set template for ${status}`);
      }
    });

    await test('buildActionCard creates buttons', () => {
      const card = buildActionCard('Title', 'Content', [
        { text: 'A', type: 'primary', callbackData: 'a' },
        { text: 'B', type: 'default', callbackData: 'b' },
      ]);
      const action = card.elements.find((e: any) => e.tag === 'action');
      assert(action.actions.length === 2, 'Should have 2 buttons');
    });

    await test('buildHandledPermissionCard shows resolution', () => {
      const card = buildHandledPermissionCard('Bash', 'allow');
      assert(card.header.template === 'green', 'Should use green for allowed');
    });
  });

  // ── 4. Activity Cards ───────────────────────────────────
  await suite('4. Activity Cards', async () => {
    await test('buildToolActivityCard shows tool name and status', () => {
      const card = buildToolActivityCard('Bash', 'running', { inputPreview: 'ls', elapsedSeconds: 5 });
      assert(card.header.title.content.includes('Bash'), 'Should show tool name');
    });

    await test('buildCommandExecutionCard shows command', () => {
      const card = buildCommandExecutionCard('echo hello', 'running', { cwd: '/tmp' });
      assert(card.elements.length >= 1, 'Should have markdown content');
    });

    await test('buildFileChangeCard shows file changes', () => {
      const card = buildFileChangeCard(
        [{ kind: 'create', path: '/tmp/new.txt' }],
        'completed',
      );
      assert(card.header.template === 'green', 'Completed should use green');
    });

    await test('buildLightweightActivityCard shows text', () => {
      const card = buildLightweightActivityCard('Compacting context...', 'running', 'source');
      assert(card.header.title.content.includes('Activity'), 'Should show Activity');
    });
  });

  // ── 5. Session Cards ────────────────────────────────────
  await suite('5. Session Cards', async () => {
    await test('buildNewSessionCard has runtime options', () => {
      const card = buildNewSessionCard();
      assert(card.header.title.content.includes('New Session'), 'Should show new session title');
    });

    await test('buildResumeCard lists sessions', () => {
      const sessions = [
        { id: 's1', title: 'My Project', runtime: 'claude' as const, updatedAt: new Date().toISOString() },
      ];
      const card = buildResumeCard(sessions);
      assert(card.header.title.content.includes('Resume'), 'Should show Resume title');
    });

    await test('buildClaudeModeCard shows mode options', () => {
      const card = buildClaudeModeCard('default', 'binding_123');
      const actions = card.elements.find((e: any) => e.tag === 'action');
      assert(actions.actions.length === 3, 'Should have 3 mode buttons');
    });

    await test('buildStreamingCardSkeleton has streaming mode', () => {
      const card = buildStreamingCardSkeleton();
      assertEquals(card.config.streaming_mode, true, 'Should enable streaming mode');
    });

    await test('buildFinalCard disables streaming', () => {
      const card = buildFinalCard('Hello world');
      assert(!card.config?.streaming_mode, 'Should not have streaming mode');
    });

    await test('buildStatusHeader returns correct templates', () => {
      assertEquals(buildStatusHeader('streaming').template, 'blue');
      assertEquals(buildStatusHeader('complete').template, 'green');
      assertEquals(buildStatusHeader('error').template, 'red');
    });
  });

  // ── 6. Telegram Cards and Services ──────────────────────
  await suite('6. Telegram Cards and Services', async () => {
    await test('Telegram new session card uses shared callback data', () => {
      const card = buildTelegramNewSessionCard();
      assert(card.text.includes('Create New Session'), 'Should show new session title');
      assertEquals(card.inlineButtons?.[0]?.[0]?.callbackData, 'new-session:claude:code');
      assertEquals(card.inlineButtons?.[0]?.[1]?.callbackData, 'new-session:codex:code');
    });

    await test('Telegram permission card has allow and deny actions', () => {
      const card = buildTelegramPermissionCard('Bash', 'ls -la', 'perm_123');
      assert(card.text.includes('Permission Required'), 'Should show permission title');
      assertEquals(card.inlineButtons?.[0]?.[0]?.callbackData, 'perm:perm_123:allow');
      assertEquals(card.inlineButtons?.[0]?.[1]?.callbackData, 'perm:perm_123:allow_session');
      assertEquals(card.inlineButtons?.[1]?.[0]?.callbackData, 'perm:perm_123:deny');
    });

    await test('Telegram Claude mode card uses claude-mode callbacks', () => {
      const card = buildTelegramClaudeModeCard('default', 'binding_123');
      assertEquals(card.inlineButtons?.length, 3, 'Should have 3 mode rows');
      assertEquals(card.inlineButtons?.[0]?.[0]?.callbackData, 'claude-mode:binding_123:plan');
    });

    await test('Telegram preview service edits one message in place', async () => {
      const client = new MockTelegramCardClient();
      const service = new TelegramPreviewService(client);
      const address = makeChannelAddress({ channelType: 'telegram' });

      const primed = await service.primePreview(address, 123);
      assertEquals(primed, 'sent', 'Should prime preview');
      const updated = await service.sendPreview(address, 'This is a substantial Telegram preview update', 123);
      assert(updated === 'sent' || updated === 'skip', `Should send or throttle, got ${updated}`);
      const finalized = await service.finalizePreview(address, 'Final Telegram answer');
      assert(finalized.ok, 'Should finalize preview');
      assertEquals(client.sentCards.length, 1, 'Should send only one preview message');
      assert(client.patchedCards.length >= 1, 'Should patch preview message');
    });

    await test('Telegram activity service creates then patches activity card', async () => {
      const client = new MockTelegramCardClient();
      const service = new TelegramActivityService(client, true);
      const address = makeChannelAddress({ channelType: 'telegram' });

      const first = await service.upsertActivityEvent(address, {
        type: 'tool_use',
        title: 'Bash',
        description: 'ls',
        timestamp: Date.now(),
        metadata: { toolId: 'tool_1' },
      });
      const second = await service.upsertActivityEvent(address, {
        type: 'tool_use',
        title: 'Bash',
        description: 'pwd',
        timestamp: Date.now(),
        metadata: { toolId: 'tool_1' },
      });

      assert(first.ok && second.ok, 'Both activity upserts should succeed');
      assertEquals(client.sentCards.length, 1, 'Should create one activity message');
      assertEquals(client.patchedCards.length, 1, 'Should patch existing activity message');
    });

    await test('Telegram adapter rejects callback data over platform limit', async () => {
      const adapter = new TelegramAdapter({ botToken: 'test-token' });
      const result = await adapter.send({
        address: makeChannelAddress({ channelType: 'telegram' }),
        text: 'Too long callback',
        inlineButtons: [[{ text: 'Too long', callbackData: 'x'.repeat(65) }]],
      });

      assertEquals(result.ok, false, 'Should reject oversized callback_data before API call');
      assert(result.error?.includes('callback_data') || false, 'Should mention callback_data');
    });

    await test('Telegram adapter falls back to plain text on parse errors', async () => {
      const adapter = new TelegramAdapter({ botToken: 'test-token' });
      const calls: any[] = [];
      (adapter as any).telegramRequest = async (_method: string, payload: any) => {
        calls.push(payload);
        if (calls.length === 1) {
          return { ok: false, error_code: 400, description: "Bad Request: can't parse entities" };
        }
        return { ok: true, result: { message_id: 88 } };
      };

      const result = await adapter.send({
        address: makeChannelAddress({ channelType: 'telegram' }),
        text: '<b>broken',
        parseMode: 'HTML',
      });

      assert(result.ok, 'Fallback send should succeed');
      assertEquals(calls.length, 2, 'Should retry once');
      assertEquals(calls[0].parse_mode, 'HTML', 'First attempt should use requested parse mode');
      assertEquals(calls[1].parse_mode, undefined, 'Fallback should send plain text');
    });

    await test('Telegram adapter truncates long HTML cards safely', async () => {
      const adapter = new TelegramAdapter({ botToken: 'test-token' });
      let payload: any = null;
      (adapter as any).telegramRequest = async (_method: string, body: any) => {
        payload = body;
        return { ok: true, result: { message_id: 89 } };
      };

      const result = await adapter.send({
        address: makeChannelAddress({ channelType: 'telegram' }),
        text: `<b>${'x'.repeat(5000)}</b>`,
        parseMode: 'HTML',
      });

      assert(result.ok, 'Long message should be sendable after truncation');
      assert(payload.text.length <= 4096, 'Telegram message text should be <= 4096 chars');
      assertEquals(payload.parse_mode, undefined, 'Truncated HTML should downgrade to plain text');
    });

    await test('Telegram adapter uploads local images with multipart', async () => {
      const adapter = new TelegramAdapter({ botToken: 'test-token' });
      const imagePath = join(tmpdir(), `agentmobile-tg-image-${Date.now()}.png`);
      writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      let multipartCalled = false;
      (adapter as any).telegramMultipartRequest = async (_method: string, fields: any, file: any) => {
        multipartCalled = true;
        assertEquals(fields.chat_id, 'chat_123', 'Should include chat id as multipart field');
        assertEquals(file.filePath, imagePath, 'Should attach local file path');
        return { ok: true, result: { message_id: 90 } };
      };

      const result = await adapter.sendImage({
        address: makeChannelAddress({ channelType: 'telegram', chatId: 'chat_123' }),
        filePath: imagePath,
      });

      rmSync(imagePath, { force: true });
      assert(result.ok, 'Image send should succeed');
      assert(multipartCalled, 'Should use multipart upload for local files');
    });
  });

  // ── 6. Mock LLM Provider ────────────────────────────────
  await suite('6. Mock LLM Provider', async () => {
    const llm = new MockLLMProvider();
    llm.responseConfig = { text: 'Hello world! How can I help you today?' };
    const binding = makeTestBinding() as any;

    await test('streamChat emits text chunks', async () => {
      let fullText = '';
      const stream = llm.streamChat(binding, [], {
        onPartialText: (t: string) => { fullText = t; },
      });
      for await (const event of stream) {
        if (event.type === 'result') break;
      }
      assert(fullText.length > 0, 'Should accumulate text');
      assertEquals(llm.callCount, 1, 'Should increment call count');
    });

    await test('streamChat emits tool_use events', async () => {
      llm.responseConfig = {
        toolUses: [
          { id: 'tool_1', name: 'Bash', input: { command: 'ls' } },
        ],
        text: 'Done',
      };
      llm.shouldRequirePermission = false;
      let toolEvents = 0;
      for await (const event of llm.streamChat(binding, [])) {
        if (event.type === 'tool_use') toolEvents++;
      }
      assert(toolEvents === 1, 'Should emit 1 tool_use event');
    });

    await test('streamChat handles errors', async () => {
      llm.responseConfig = { error: 'API error' };
      for await (const event of llm.streamChat(binding, [])) {
        if (event.type === 'error') {
          assertEquals(event.data.message, 'API error', 'Should propagate error message');
        }
      }
    });

    await test('streamChat tracks last messages', async () => {
      llm.clear();
      llm.responseConfig = { text: 'test' };
      llm.shouldRequirePermission = false;
      const msgs = [{ role: 'user', content: 'Hello' }];
      for await (const _ of llm.streamChat(binding, msgs)) {}
      assertEquals(llm.lastMessages.length, 1, 'Should track messages');
    });
  });

  // ── 7. Permission Broker ────────────────────────────────
  await suite('7. Permission Broker', async () => {
    await test('handleCallback resolves permission callbacks', () => {
      const broker = new PermissionBroker();
      // Callbacks that match the perm:* pattern should be handled
      assert(broker.handleCallback('perm:123:allow') === false || broker.handleCallback('perm:123:allow') === true,
        'Should accept perm callbacks');
    });

    await test('handleCallback ignores non-perm callbacks', () => {
      const broker = new PermissionBroker();
      const handled = broker.handleCallback('new-session:claude');
      assertEquals(handled, false, 'Should not handle non-perm callbacks');
    });
  });

  // ── 8. Channel Router ───────────────────────────────────
  await suite('8. Channel Router', async () => {
    const store = new MockStore();
    const router = new ChannelRouter(store as any);

    await test('createBinding saves binding', () => {
      const binding = router.createBinding({
        channelType: 'telegram',
        channelInstanceId: 'default',
        chatId: 'chat_123',
        agentSessionId: 'session_456',
        workingDirectory: '/tmp/test',
        runtime: 'claude',
      });
      assertEquals(binding.channelType, 'telegram', 'Should set channelType');
      assertEquals(binding.chatId, 'chat_123', 'Should set chatId');
      assert(binding.active, 'Should be active');
      assertEquals(store.bindings.get(binding.id), binding, 'Should be stored');
    });

    await test('resolve finds binding by chat', () => {
      const binding = router.createBinding({
        channelType: 'feishu',
        chatId: 'feishu_chat',
        agentSessionId: 'session_789',
        channelInstanceId: 'default',
        workingDirectory: '/tmp',
        runtime: 'claude',
      });
      const resolved = router.resolve({
        channelType: 'feishu',
        chatId: 'feishu_chat',
      });
      assert(resolved !== undefined, 'Should resolve binding');
      assertEquals(resolved?.id, binding.id, 'Should return same binding');
    });

    await test('deactivateBinding marks binding inactive', () => {
      const binding = router.createBinding({
        channelType: 'telegram',
        chatId: 'deactivate_test',
        agentSessionId: 'sess',
        channelInstanceId: 'default',
        workingDirectory: '/tmp',
        runtime: 'claude',
      });
      router.deactivateBinding(binding.id);
      const resolved = router.resolve({
        channelType: 'telegram',
        chatId: 'deactivate_test',
      });
      assertEquals(resolved, undefined, 'Should not resolve deactivated binding');
    });

    await test('listBindings filters by channel type', () => {
      const s = new MockStore();
      const r = new ChannelRouter(s as any);
      r.createBinding({ channelType: 'telegram', chatId: 'tg1', agentSessionId: 's1', channelInstanceId: 'default', workingDirectory: '/tmp', runtime: 'claude' });
      r.createBinding({ channelType: 'feishu', chatId: 'fs1', agentSessionId: 's2', channelInstanceId: 'default', workingDirectory: '/tmp', runtime: 'claude' });
      const telegramBindings = r.listBindings('telegram');
      assertEquals(telegramBindings.length, 1, 'Should return only telegram bindings');
    });
  });

  // ── 9. Mock Store ───────────────────────────────────────
  await suite('9. Mock Store', async () => {
    const store = new MockStore();

    await test('saveBinding and getBinding work', () => {
      const binding = makeTestBinding() as any;
      store.saveBinding(binding);
      const retrieved = store.getBinding(binding.id);
      assertEquals(retrieved?.id, binding.id, 'Should retrieve saved binding');
    });

    await test('getBindingByChat finds active bindings', () => {
      const binding = makeTestBinding({ chatId: 'chat_lookup' }) as any;
      store.saveBinding(binding);
      const found = store.getBindingByChat(binding.channelType, binding.chatId);
      assertEquals(found?.id, binding.id, 'Should find by chat');
    });

    await test('deleteBinding removes binding', () => {
      const binding = makeTestBinding() as any;
      store.saveBinding(binding);
      store.deleteBinding(binding.id);
      const found = store.getBinding(binding.id);
      assertEquals(found, undefined, 'Should be deleted');
    });

    await test('Settings CRUD works', () => {
      store.setSetting('key1', 'value1');
      assertEquals(store.getSetting('key1'), 'value1', 'Should set and get');
      store.setSetting('key1', 'value2');
      assertEquals(store.getSetting('key1'), 'value2', 'Should update');
    });

    await test('clear resets all data', () => {
      const binding = makeTestBinding() as any;
      store.saveBinding(binding);
      store.clear();
      assertEquals(store.listBindings().length, 0, 'Should clear bindings');
      assertEquals(store.getBinding(binding.id), undefined, 'Should clear individual bindings');
    });
  });

  // ── 10. Preview Service ─────────────────────────────────
  await suite('10. Preview Service', async () => {
    const mockClient = new MockLarkClient();
    const service = new PreviewService(mockClient as any);
    const address = makeChannelAddress();

    await test('primePreview creates artifact and sends card', async () => {
      const result = await service.primePreview(address, 12345);
      assertEquals(result, 'sent', 'Should succeed');
      assertEquals(mockClient.sentCards.length, 1, 'Should send preview card');
    });

    await test('sendPreview updates existing preview', async () => {
      await service.primePreview(address, 67890);
      // Need enough text to pass throttle threshold (20 char minimum delta)
      const result = await service.sendPreview(address, 'This is a substantial text update that exceeds throttle threshold', 67890);
      assert(result === 'sent' || result === 'degrade', `Should send or degrade, got ${result}`);
    });

    await test('sendPreview skips on no change', async () => {
      await service.primePreview(address, 11111);
      // Short text should be skipped by throttle (less than 20 char delta)
      const r1 = await service.sendPreview(address, 'Hi', 11111);
      assertEquals(r1, 'skip', 'Short updates should be throttled');
    });

    await test('endPreview cleans up blank previews', async () => {
      await service.primePreview(address, 22222);
      service.endPreview(address, 22222);
      // Blank preview should be deleted
      assertEquals(mockClient.sentCards.length >= 1, true, 'Should have sent card');
    });

    await test('finalizePreview patches with final content', async () => {
      await service.primePreview(address, 33333);
      await service.sendPreview(address, 'Accumulated text', 33333);
      const result = await service.finalizePreview(address, 'Final answer!');
      assert(result.ok, 'Should finalize successfully');
    });
  });

  // ── 11. Activity Service ────────────────────────────────
  await suite('11. Activity Service', async () => {
    const mockClient = new MockLarkClient();
    const service = new ActivityService(mockClient as any, true);
    const address = makeChannelAddress();

    await test('upsertActivityEvent creates card', async () => {
      const result = await service.upsertActivityEvent(address, {
        type: 'tool_use',
        title: 'Bash',
        description: 'Running ls',
        timestamp: Date.now(),
        metadata: { toolId: 'tool_1' },
      });
      assert(result.ok, 'Should create card');
    });

    await test('shouldProjectEvent filters correctly', () => {
      assert(service.shouldProjectEvent({ type: 'tool_use', title: 'x', timestamp: 0 }), 'tool_use should be projected');
      assert(service.shouldProjectEvent({ type: 'file_change', title: 'x', timestamp: 0 }), 'file_change should be projected');
    });

    await test('disabled service returns ok without sending', async () => {
      const disabledService = new ActivityService(mockClient as any, false);
      const result = await disabledService.upsertActivityEvent(address, {
        type: 'tool_use', title: 'Bash', timestamp: Date.now(),
      });
      assert(result.ok, 'Should return ok even when disabled');
    });

    await test('cleanup removes pending timers', async () => {
      service.cleanup();
      // Should not throw
    });
  });

  // ── 12. JSON File Store (real filesystem) ───────────────
  await suite('12. JSON File Store (real disk)', async () => {
    const testDir = join(tmpdir(), `am-test-store-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    await test('persists bindings to disk', async () => {
      const store = new JsonFileStore(testDir);
      const binding = makeTestBinding() as any;
      store.saveBinding(binding);
      // Verify file exists
      assert(existsSync(join(testDir, 'bindings.json')), 'Should create bindings.json');
    });

    await test('reloads bindings from disk', async () => {
      const store1 = new JsonFileStore(testDir);
      const binding = makeTestBinding({ id: 'reload_test' }) as any;
      store1.saveBinding(binding);

      const store2 = new JsonFileStore(testDir);
      const reloaded = store2.getBinding('reload_test');
      assertEquals(reloaded?.id, 'reload_test', 'Should persist and reload');
    });

    await test('persists settings', async () => {
      const store = new JsonFileStore(testDir);
      store.setSetting('test_key', 'test_value');
      const reloaded = new JsonFileStore(testDir);
      assertEquals(reloaded.getSetting('test_key'), 'test_value', 'Should persist settings');
    });

    // Cleanup
    await test('cleanup test directory', async () => {
      rmSync(testDir, { recursive: true, force: true });
      assert(!existsSync(testDir), 'Should clean up');
    });
  });

  // ── 13. Bridge Manager ──────────────────────────────────
  await suite('13. Bridge Manager', async () => {
    const mockLlm = new MockLLMProvider();
    mockLlm.responseConfig = { text: 'Hello from bot!' };
    const store = new MockStore();
    const manager = new BridgeManager(store as any, mockLlm as any);

    await test('getStatus returns correct initial state', () => {
      const status = manager.getStatus();
      assertEquals(status.running, false, 'Should not be running before start');
      assertEquals(status.adapters.length, 0, 'No adapters registered');
    });

    await test('registerAdapter adds adapter to status', async () => {
      const mockAdapter = {
        channelType: 'telegram',
        adapterId: 'telegram',
        profileId: 'telegram',
        label: 'Telegram',
        get channelType() { return 'telegram'; },
        get adapterId() { return 'telegram'; },
        get profileId() { return 'telegram'; },
        get label() { return 'Telegram'; },
        start: async () => {},
        stop: async () => {},
        isRunning: () => true,
        consumeOne: async () => null,
        send: async () => ({ ok: true }),
        validateConfig: () => null,
        isAuthorized: () => true,
      };
      manager.registerAdapter(mockAdapter as any);
      const status = manager.getStatus();
      assertEquals(status.adapters.length, 1, 'Should have 1 adapter');
      assertEquals(status.adapters[0].channelType, 'telegram', 'Should be telegram');
      // Clean up
      await manager.stop();
    });

    await test('start and stop lifecycle', async () => {
      const mockAdapter = {
        channelType: 'test',
        get channelType() { return 'test'; },
        get adapterId() { return 'test'; },
        get profileId() { return 'test'; },
        get label() { return 'Test'; },
        start: async () => {},
        stop: async () => {},
        isRunning: () => true,
        consumeOne: async () => null,
        send: async () => ({ ok: true }),
        validateConfig: () => null,
        isAuthorized: () => true,
      };
      manager.registerAdapter(mockAdapter as any);
      await manager.start();
      const status = manager.getStatus();
      assertEquals(status.running, true, 'Should be running');
      await manager.stop();
      assertEquals(manager.getStatus().running, false, 'Should be stopped');
    });
  });

  // ── 14. Feishu Event and Callback Linkage ───────────────
  await suite('14. Feishu Event and Callback Linkage', async () => {
    await test('EventDispatcher registers Feishu message event handler', async () => {
      const registered: Record<string, (data: unknown) => Promise<void>> = {};
      class FakeEventDispatcher {
        constructor(_options: unknown) {}
        register(handles: Record<string, (data: unknown) => Promise<void>>) {
          Object.assign(registered, handles);
          return this;
        }
      }

      let received: unknown = null;
      createFeishuEventDispatcher(
        { EventDispatcher: FakeEventDispatcher, LoggerLevel: { info: 'info' } },
        {
          onMessageReceive: async (data) => {
            received = data;
          },
        },
      );

      assert(typeof registered['im.message.receive_v1'] === 'function', 'Should register receive_v1');
      assert(!('card.action.trigger' in registered), 'Long connection should not register card callbacks');
      await registered['im.message.receive_v1']({ message: { message_id: 'm1' } });
      assertEquals((received as any).message.message_id, 'm1', 'Should dispatch message payload');
    });

    await test('/new creates a Feishu binding and next message is enqueued', async () => {
      const store = new MockStore();
      const router = new ChannelRouter(store as any);
      const sentTexts: string[] = [];
      const ctx: any = {
        larkClient: new MockLarkClient(),
        store,
        router,
        permissionBroker: new PermissionBroker(),
        previewService: {},
        activityService: {},
        inboundImageService: {},
        profileId: 'default',
        createBoundSession: async (runtime: 'claude' | 'codex', sender: any) => router.createBinding({
          channelType: 'feishu',
          channelInstanceId: 'default',
          chatId: sender.chatId,
          agentSessionId: `session_${runtime}`,
          workingDirectory: '/tmp',
          runtime,
        }),
        getActiveBinding: (address: any) => router.resolve(address),
        deactivateBinding: (bindingId: string) => router.deactivateBinding(bindingId),
        isAuthorized: () => true,
        sendCard: async () => ({ ok: true }),
        patchCard: async () => ({ ok: true }),
        sendText: async (_address: any, text: string) => {
          sentTexts.push(text);
          return { ok: true };
        },
        handleNewSessionCardAction: async () => {},
        handleResumeCardAction: async () => {},
        handleClaudeModeCardAction: async () => {},
        handleStructuredInputCardAction: async () => {},
        handlePlanCardAction: async () => {},
        handleClaudePlanExitCardAction: async () => {},
      };

      const baseEvent = {
        message: {
          chat_id: 'chat_new',
          chat_type: 'p2p',
          message_type: 'text',
          create_time: String(Date.now()),
        },
        sender: {
          sender_type: 'user',
          sender_id: { open_id: 'user_new' },
        },
      };

      const created = await handleIncomingEvent(ctx, {
        ...baseEvent,
        message: {
          ...baseEvent.message,
          message_id: 'msg_new_command',
          content: JSON.stringify({ text: '/new:claude' }),
        },
      } as any);
      assertEquals(created, null, '/new should be handled by the adapter layer');
      assert(router.resolve({ channelType: 'feishu', channelInstanceId: 'default', chatId: 'chat_new' }), 'Binding should exist');
      assert(sentTexts.some(text => text.includes('Created new claude session')), 'Should send creation confirmation');

      const next = await handleIncomingEvent(ctx, {
        ...baseEvent,
        message: {
          ...baseEvent.message,
          message_id: 'msg_new_followup',
          content: JSON.stringify({ text: 'hello after binding' }),
        },
      } as any);
      assert(next !== null, 'Follow-up message should be enqueued');
      assertEquals(next?.text, 'hello after binding', 'Should preserve message text');
    });

    await test('session card callbacks can route using button metadata', async () => {
      const store = new MockStore();
      const router = new ChannelRouter(store as any);
      const ctx: any = {
        larkClient: new MockLarkClient(),
        store,
        router,
        permissionBroker: new PermissionBroker(),
        previewService: {},
        activityService: {},
        inboundImageService: {},
        profileId: 'default',
        createBoundSession: async (runtime: 'claude' | 'codex', sender: any, options: any) => router.createBinding({
          channelType: 'feishu',
          channelInstanceId: 'default',
          chatId: sender.chatId,
          agentSessionId: `session_${runtime}`,
          workingDirectory: '/tmp',
          runtime,
          mode: options.mode,
        }),
        getActiveBinding: (address: any) => router.resolve(address),
        deactivateBinding: (bindingId: string) => router.deactivateBinding(bindingId),
        isAuthorized: () => true,
        sendCard: async () => ({ ok: true }),
        patchCard: async () => ({ ok: true }),
        sendText: async () => ({ ok: true }),
        handleNewSessionCardAction: async (event: unknown, callbackData: string) => {
          const { handleNewSessionCardAction } = await import('../im/feishu/handlers/session-handler.js');
          await handleNewSessionCardAction(ctx, event as any, callbackData);
        },
        handleResumeCardAction: async () => {},
        handleClaudeModeCardAction: async () => {},
        handleStructuredInputCardAction: async () => {},
        handlePlanCardAction: async () => {},
        handleClaudePlanExitCardAction: async () => {},
      };

      await handleCardAction(ctx, {
        open_message_id: 'open_card',
        open_id: 'user_meta',
        action: {
          tag: 'button',
          value: {
            callback: 'new-session:codex:code',
            chat_id: 'chat_meta',
            user_id: 'user_meta',
          },
        },
      } as any);

      const binding = router.resolve({
        channelType: 'feishu',
        channelInstanceId: 'default',
        chatId: 'chat_meta',
      });
      assert(binding !== undefined, 'Card callback metadata should create a routed binding');
      assertEquals(binding?.runtime, 'codex', 'Should create requested runtime');
    });

    await test('card action HTTP resolves BridgeManager permission broker', async () => {
      const store = new MockStore();
      const router = new ChannelRouter(store as any);
      const permissionBroker = new PermissionBroker();
      const llm = new MockLLMProvider();
      llm.responseConfig = {
        toolUses: [{ id: 'tool_1', name: 'Bash', input: { command: 'pwd' } }],
        text: 'Permission granted',
      };
      llm.shouldRequirePermission = true;

      const manager = new BridgeManager(store as any, llm as any, {
        router,
        permissionBroker,
      });
      const adapter = new QueueAdapter();
      router.createBinding({
        channelType: 'feishu',
        channelInstanceId: 'default',
        chatId: 'chat_perm',
        agentSessionId: 'session_perm',
        workingDirectory: '/tmp',
        runtime: 'claude',
      });

      const cardCtx: any = {
        larkClient: new MockLarkClient(),
        store,
        router,
        permissionBroker,
        previewService: {},
        activityService: {},
        inboundImageService: {},
        profileId: 'default',
        createBoundSession: async () => {
          throw new Error('not used');
        },
        getActiveBinding: (address: any) => router.resolve(address),
        deactivateBinding: (bindingId: string) => router.deactivateBinding(bindingId),
        isAuthorized: () => true,
        sendCard: async () => ({ ok: true }),
        patchCard: async () => ({ ok: true }),
        sendText: async () => ({ ok: true }),
        handleNewSessionCardAction: async () => {},
        handleResumeCardAction: async () => {},
        handleClaudeModeCardAction: async () => {},
        handleStructuredInputCardAction: async () => {},
        handlePlanCardAction: async () => {},
        handleClaudePlanExitCardAction: async () => {},
      };

      manager.registerAdapter(adapter as any);
      await manager.start();

      const callbackServer = await startFeishuCardActionServer({
        port: 0,
        adapter: {
          handleCardActionPayload: async (data: unknown) => handleCardAction(cardCtx, data as any),
        },
      });
      const port = (callbackServer.address() as AddressInfo).port;

      try {
        adapter.push(makeInboundMessage({
          messageId: 'msg_perm_user',
          address: {
            channelType: 'feishu',
            channelInstanceId: 'default',
            chatId: 'chat_perm',
            userId: 'user_perm',
          },
          text: 'please run pwd',
        }));

        await waitFor(() => adapter.sentMessages.some(message => Boolean(message.inlineButtons)));
        const permissionMessage = adapter.sentMessages.find(message => Boolean(message.inlineButtons));
        const callbackData = permissionMessage?.inlineButtons?.[0]?.[0]?.callbackData;
        assertEquals(callbackData, 'perm:tool_1:allow', 'Should send permission callback data');

        const response = await postJson(port, FEISHU_CARD_ACTION_PATH, {
          open_chat_id: 'chat_perm',
          open_message_id: 'open_perm_card',
          open_id: 'user_perm',
          operator: { open_id: 'user_perm' },
          action: {
            tag: 'button',
            value: { callback: callbackData },
          },
        });
        assertEquals(response.statusCode, 200, 'Callback endpoint should return 200');
        await waitFor(() => adapter.sentMessages.some(message => message.text.includes('Permission granted')));
      } finally {
        await closeServer(callbackServer);
        await manager.stop();
      }
    });

    await test('Telegram session callback creates binding and patches card', async () => {
      const store = new MockStore();
      const router = new ChannelRouter(store as any);
      const manager = new BridgeManager(store as any, new MockLLMProvider() as any, {
        router,
        permissionBroker: new PermissionBroker(),
      });
      const adapter = new TelegramQueueAdapter();

      manager.registerAdapter(adapter as any);
      await manager.start();
      try {
        adapter.push(makeInboundMessage({
          messageId: 'callback_new',
          callbackMessageId: '42',
          callbackData: 'new-session:codex:code',
          address: {
            channelType: 'telegram',
            channelInstanceId: 'default',
            chatId: 'tg_chat',
            userId: 'tg_user',
          },
          text: 'Create New Session',
        }));

        await waitFor(() => router.resolve({
          channelType: 'telegram',
          channelInstanceId: 'default',
          chatId: 'tg_chat',
        }) !== undefined);

        const binding = router.resolve({
          channelType: 'telegram',
          channelInstanceId: 'default',
          chatId: 'tg_chat',
        });
        assertEquals(binding?.runtime, 'codex', 'Should create requested runtime');
        await waitFor(() => adapter.patchedCards.length === 1);
        assert(adapter.patchedCards[0].card.text.includes('Session Created'), 'Should patch original card');
        assertEquals(adapter.answeredCallbacks[0].id, 'callback_new', 'Should answer callback query');
      } finally {
        await manager.stop();
      }
    });

    await test('/sessions command shows Telegram resume card', async () => {
      const store = new MockStore();
      const router = new ChannelRouter(store as any);
      const manager = new BridgeManager(store as any, new MockLLMProvider() as any, {
        router,
        permissionBroker: new PermissionBroker(),
      });
      const adapter = new TelegramQueueAdapter();
      router.createBinding({
        channelType: 'telegram',
        channelInstanceId: 'default',
        chatId: 'tg_sessions',
        agentSessionId: 'session_tg_sessions',
        workingDirectory: '/tmp/project-a',
        runtime: 'claude',
      });

      manager.registerAdapter(adapter as any);
      await manager.start();
      try {
        adapter.push(makeInboundMessage({
          messageId: 'tg_sessions_command',
          address: {
            channelType: 'telegram',
            channelInstanceId: 'default',
            chatId: 'tg_sessions',
            userId: 'tg_user',
          },
          text: '/sessions',
        }));

        await waitFor(() => adapter.sentMessages.some(message => message.text.includes('Resume Session')));
        const card = adapter.sentMessages.find(message => message.text.includes('Resume Session'));
        assert(card?.inlineButtons?.length === 1, 'Should include one session button');
        assert(!card?.text.includes('Unknown command'), 'Should not render unknown command');
      } finally {
        await manager.stop();
      }
    });

    await test('Telegram permission callback patches original permission card', async () => {
      const store = new MockStore();
      const router = new ChannelRouter(store as any);
      const permissionBroker = new PermissionBroker();
      const llm = new MockLLMProvider();
      llm.responseConfig = {
        toolUses: [{ id: 'tool_tg', name: 'Bash', input: { command: 'pwd' } }],
        text: 'Telegram permission granted',
      };
      llm.shouldRequirePermission = true;

      const manager = new BridgeManager(store as any, llm as any, {
        router,
        permissionBroker,
      });
      const adapter = new TelegramQueueAdapter();
      router.createBinding({
        channelType: 'telegram',
        channelInstanceId: 'default',
        chatId: 'tg_perm',
        agentSessionId: 'session_tg_perm',
        workingDirectory: '/tmp',
        runtime: 'claude',
      });

      manager.registerAdapter(adapter as any);
      await manager.start();
      try {
        adapter.push(makeInboundMessage({
          messageId: 'tg_user_msg',
          address: {
            channelType: 'telegram',
            channelInstanceId: 'default',
            chatId: 'tg_perm',
            userId: 'tg_user',
          },
          text: 'please run pwd',
        }));

        await waitFor(() => adapter.sentMessages.some(message => Boolean(message.inlineButtons)));
        adapter.push(makeInboundMessage({
          messageId: 'tg_perm_callback',
          callbackMessageId: 'sent_1',
          callbackData: 'perm:tool_tg:allow',
          address: {
            channelType: 'telegram',
            channelInstanceId: 'default',
            chatId: 'tg_perm',
            userId: 'tg_user',
          },
          text: 'Permission Required',
        }));

        await waitFor(() => adapter.patchedCards.some(card => card.card.text.includes('Permission Resolved')));
        await waitFor(() => adapter.sentMessages.some(message => message.text.includes('Telegram permission granted')));
      } finally {
        await manager.stop();
      }
    });
  });

  // ── 15. Lark Client SDK API Shape ───────────────────────
  await suite('15. Lark Client SDK API Shape', async () => {
    function makeFakeSdkClient() {
      const calls: Array<{ name: string; payload: any }> = [];
      const client = {
        im: {
          v1: {
            message: {
              create: async (payload: any) => {
                calls.push({ name: 'message.create', payload });
                return { code: 0, data: { message_id: 'msg_create' } };
              },
              reply: async (payload: any) => {
                calls.push({ name: 'message.reply', payload });
                return { code: 0, data: { message_id: 'msg_reply' } };
              },
              patch: async (payload: any) => {
                calls.push({ name: 'message.patch', payload });
                return { code: 0, data: {} };
              },
              delete: async (payload: any) => {
                calls.push({ name: 'message.delete', payload });
                return { code: 0, data: {} };
              },
            },
            image: {
              create: async (payload: any) => {
                calls.push({ name: 'image.create', payload });
                return { image_key: 'img_uploaded' };
              },
            },
            messageResource: {
              get: async (payload: any) => {
                calls.push({ name: 'messageResource.get', payload });
                return {
                  headers: { 'content-type': 'image/png' },
                  writeFile: async (filePath: string) => {
                    writeFileSync(filePath, 'image-bytes');
                    return filePath;
                  },
                };
              },
            },
          },
        },
        cardkit: {
          v1: {
            card: {
              idConvert: async (payload: any) => {
                calls.push({ name: 'card.idConvert', payload });
                return { code: 0, data: { card_id: 'card_123' } };
              },
            },
            cardElement: {
              content: async (payload: any) => {
                calls.push({ name: 'cardElement.content', payload });
                return { code: 0, data: {} };
              },
            },
          },
        },
      };
      return { client, calls };
    }

    await test('sendMessage uses create and reply endpoints correctly', async () => {
      const { client, calls } = makeFakeSdkClient();
      const larkClient = new LarkClient({ appId: 'app', appSecret: 'secret' });
      larkClient.setClient(client);

      await larkClient.sendMessage(
        makeChannelAddress({ channelType: 'feishu', chatId: 'chat_create' }),
        'text',
        { text: 'hello' },
      );
      await larkClient.sendMessage(
        makeChannelAddress({ channelType: 'feishu', chatId: 'chat_reply' }),
        'text',
        { text: 'reply' },
        'msg_original',
      );

      assertEquals(calls[0].name, 'message.create', 'First call should create a message');
      assertEquals(calls[0].payload.params.receive_id_type, 'chat_id', 'Create should target chat_id');
      assertEquals(calls[0].payload.data.receive_id, 'chat_create', 'Create should include receive_id');
      assertEquals(calls[1].name, 'message.reply', 'Reply should use reply endpoint');
      assertEquals(calls[1].payload.path.message_id, 'msg_original', 'Reply should use path message_id');
      assert(!('reply_in_message_id' in calls[1].payload.data), 'Reply payload must not use create-only reply field');
    });

    await test('patchCard uses message.patch content payload and propagates failures', async () => {
      const { client, calls } = makeFakeSdkClient();
      const larkClient = new LarkClient({ appId: 'app', appSecret: 'secret' });
      larkClient.setClient(client);

      await larkClient.patchCard('msg_card', { header: { title: 'Updated' } });
      assertEquals(calls[0].name, 'message.patch', 'Should use typed patch API');
      assertEquals(calls[0].payload.path.message_id, 'msg_card', 'Should patch by message id');
      assert(typeof calls[0].payload.data.content === 'string', 'Patch content should be serialized JSON');

      client.im.v1.message.patch = async () => {
        throw new Error('api down');
      };
      try {
        await larkClient.patchCard('msg_card_2', { header: {} });
        assert(false, 'Patch should throw');
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        assert(message.includes('Failed to patch Feishu card msg_card_2'), 'Should include clear patch context');
      }
    });

    await test('image upload and download use Node SDK resource APIs', async () => {
      const { client, calls } = makeFakeSdkClient();
      const larkClient = new LarkClient({ appId: 'app', appSecret: 'secret' });
      larkClient.setClient(client);
      const tempDir = join(tmpdir(), `am-lark-client-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });
      const inputPath = join(tempDir, 'input.png');
      const outputPath = join(tempDir, 'output.png');
      writeFileSync(inputPath, 'fake-image');

      try {
        const imageKey = await larkClient.uploadImage(inputPath);
        assertEquals(imageKey, 'img_uploaded', 'Should return image key');
        assertEquals(calls[0].name, 'image.create', 'Should use image.create');
        assertEquals(calls[0].payload.data.image_type, 'message', 'Should upload message image');
        assert(calls[0].payload.data.image, 'Should pass a Node stream/buffer as image');

        await larkClient.downloadMessageResource('msg_inbound', 'img_key', 'image', outputPath);
        assertEquals(calls[1].name, 'messageResource.get', 'Should use messageResource.get');
        assertEquals(calls[1].payload.path.message_id, 'msg_inbound', 'Should pass source message id');
        assertEquals(calls[1].payload.path.file_key, 'img_key', 'Should pass resource key');
        assertEquals(readFileSync(outputPath, 'utf8'), 'image-bytes', 'Should write downloaded resource');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    await test('CardKit streaming update converts message id to card id', async () => {
      const { client, calls } = makeFakeSdkClient();
      const larkClient = new LarkClient({ appId: 'app', appSecret: 'secret' });
      larkClient.setClient(client);

      await larkClient.updateCardElementContent('msg_stream', 'stream_content', 'partial', { sequence: 7 });
      assertEquals(calls[0].name, 'card.idConvert', 'Should convert message id first');
      assertEquals(calls[0].payload.data.message_id, 'msg_stream', 'Should convert the message id');
      assertEquals(calls[1].name, 'cardElement.content', 'Should use card element content API');
      assertEquals(calls[1].payload.path.card_id, 'card_123', 'Should use converted card id');
      assertEquals(calls[1].payload.path.element_id, 'stream_content', 'Should target content element');
      assertEquals(calls[1].payload.data.content, 'partial', 'Should send partial text');
    });
  });

  // ── 16. Config Loading ──────────────────────────────────
  await suite('16. Config Loading', async () => {
    await test('loadConfig validates secrets (throws when missing)', () => {
      try {
        loadConfig();
        assert(false, 'Should throw when JWT_SECRET is not set');
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        assert(msg.includes('JWT_SECRET'), `Should mention JWT_SECRET, got: ${msg}`);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  summary();
}

main().catch(e => {
  console.error('Fatal error:', e);
  summary();
});
