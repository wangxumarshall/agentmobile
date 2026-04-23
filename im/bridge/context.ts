/**
 * Bridge context (dependency injection container).
 * Shared access to store, LLM provider, permissions gateway, and lifecycle hooks.
 */

import type { ChannelBinding } from '../bridge/types.js';
import type { JsonFileStore } from '../infra/store.js';

export interface LLMProvider {
  streamChat(
    binding: ChannelBinding,
    messages: Array<{ role: string; content: string }>,
    options?: {
      onPermissionRequest?: (req: PermissionRequestInfo) => Promise<PermissionResolution>;
      onPartialText?: (text: string) => void;
      onActivityEvent?: (event: ActivityEventInfo) => void;
      abortSignal?: AbortSignal;
    }
  ): AsyncIterable<SSEEvent>;
}

export interface PermissionRequestInfo {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  prompt: string;
}

export interface PermissionResolution {
  resolution: 'allow' | 'deny' | 'allow_session';
}

export interface ActivityEventInfo {
  type: 'command' | 'file_change' | 'tool_use' | 'progress';
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface SSEEvent {
  type: 'text' | 'text_segment' | 'tool_use' | 'tool_result' | 'permission_request' | 'activity_event' | 'status' | 'result' | 'error';
  data?: Record<string, unknown>;
  text?: string;
}

export interface PermissionsGateway {
  resolvePendingPermission(id: string, resolution: PermissionResolution): boolean;
}

export interface LifecycleHooks {
  onBridgeStart?: () => void;
  onBridgeStop?: () => void;
}

export interface BridgeContext {
  store: JsonFileStore;
  llm: LLMProvider;
  permissions: PermissionsGateway;
  lifecycle?: LifecycleHooks;
}

let context: BridgeContext | null = null;

export function initBridgeContext(ctx: BridgeContext): void {
  context = ctx;
}

export function getBridgeContext(): BridgeContext {
  if (!context) {
    throw new Error('Bridge context not initialized');
  }
  return context;
}
