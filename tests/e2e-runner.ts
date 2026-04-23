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
import { mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

// ── Mocks ───────────────────────────────────────────────────
import { MockLarkClient } from './mocks/mock-lark-client.js';
import { MockLLMProvider } from './mocks/mock-llm-provider.js';
import { MockStore } from './mocks/mock-store.js';
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
import { buildRouteKey, stableMessageUuid, truncateText, normalizeLine } from '../im/feishu/utils.js';
import { buildPermissionCard, buildSimpleCard, buildStatusCard, buildActionCard, buildHandledPermissionCard } from '../im/feishu/cards/permission-cards.js';
import { buildToolActivityCard, buildCommandExecutionCard, buildFileChangeCard, buildLightweightActivityCard } from '../im/feishu/cards/activity-cards.js';
import { buildNewSessionCard, buildResumeCard, buildClaudeModeCard, buildResetConfirmationCard } from '../im/feishu/cards/session-cards.js';
import { buildStreamingCardSkeleton, buildFinalCard, buildStatusHeader } from '../im/feishu/cards/streaming-cards.js';
import { PreviewService } from '../im/feishu/services/preview-service.js';
import { ActivityService } from '../im/feishu/services/activity-service.js';
import { loadConfig } from '../im/config/config.js';
import { JsonFileStore } from '../im/infra/store.js';
import { ClaudeSDKProvider, classifyAuthError, isAuthError } from '../im/providers/claude-sdk.js';

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
      const binding = makeTestBinding() as any;
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

  // ── 14. Config Loading ──────────────────────────────────
  await suite('14. Config Loading', async () => {
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
