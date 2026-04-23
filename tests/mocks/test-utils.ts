/**
 * Test utilities for IM bridge tests.
 */

import type { ChannelAddress, InboundMessage } from '../../im/bridge/types.js';

/**
 * Create a test inbound message.
 */
export function makeInboundMessage(
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  return {
    messageId: `msg_${Date.now()}`,
    address: {
      channelType: 'telegram',
      chatId: 'chat_123',
      userId: 'user_456',
      displayName: 'Test User',
    },
    text: 'Hello world',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Create a test channel address.
 */
export function makeChannelAddress(
  overrides: Partial<ChannelAddress> = {},
): ChannelAddress {
  return {
    channelType: 'telegram',
    chatId: 'chat_123',
    userId: 'user_456',
    displayName: 'Test User',
    ...overrides,
  };
}

/**
 * Create a test binding.
 */
export function makeTestBinding(
  overrides: Partial<any> = {},
) {
  const id = overrides.id || `binding_${Date.now()}`;
  return {
    id,
    channelType: overrides.channelType || 'telegram',
    channelInstanceId: 'default',
    chatId: overrides.chatId || 'chat_123',
    agentSessionId: overrides.agentSessionId || 'session_789',
    sdkSessionId: '',
    workingDirectory: overrides.workingDirectory || '/tmp/test',
    model: 'default',
    mode: (overrides.mode || 'code') as 'code' | 'plan' | 'ask',
    runtime: (overrides.runtime || 'claude') as 'claude' | 'codex',
    claudePermissionMode: 'default',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Wait for a condition to be true with timeout.
 */
export async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 5000,
  intervalMs: number = 50,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/**
 * Simple assertion helpers.
 */
export function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export function assertEquals(actual: any, expected: any, message: string = ''): void {
  if (actual !== expected) {
    throw new Error(`assertEquals failed: ${message}\n  Actual: ${actual}\n  Expected: ${expected}`);
  }
}

export function assertContains(actual: any[], expected: any, message: string = ''): void {
  if (!actual.includes(expected)) {
    throw new Error(`assertContains failed: ${message}\n  Actual: ${JSON.stringify(actual)}\n  Expected: ${expected}`);
  }
}

/**
 * Create a temporary directory for test data.
 */
export function createTempDir(): string {
  import('node:os').then(os => os.tmpdir());
  const { tmpdir } = require('os');
  const { join } = require('path');
  return join(tmpdir(), `agent-mobile-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}
