/**
 * Channel router — resolves ChannelAddress to ChannelBinding.
 * Manages the mapping between IM chats and agent sessions.
 */

import type { ChannelAddress, ChannelBinding, ChannelType } from './types.js';
import type { JsonFileStore } from '../infra/store.js';

export class ChannelRouter {
  private store: JsonFileStore;

  constructor(store: JsonFileStore) {
    this.store = store;
  }

  /**
   * Resolve a channel address to its binding.
   * Returns undefined if no binding exists.
   */
  resolve(address: ChannelAddress): ChannelBinding | undefined {
    return this.store.getBindingByChat(address.channelType, address.chatId);
  }

  /**
   * Create a new binding.
   */
  createBinding(options: {
    channelType: ChannelType;
    channelInstanceId: string;
    chatId: string;
    agentSessionId: string;
    workingDirectory: string;
    runtime: 'claude' | 'codex';
    model?: string;
    mode?: 'code' | 'plan' | 'ask';
  }): ChannelBinding {
    const now = new Date().toISOString();
    const binding: ChannelBinding = {
      id: `binding_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      channelType: options.channelType,
      channelInstanceId: options.channelInstanceId,
      chatId: options.chatId,
      agentSessionId: options.agentSessionId,
      sdkSessionId: '',
      workingDirectory: options.workingDirectory,
      model: options.model || 'default',
      mode: options.mode || 'code',
      runtime: options.runtime,
      claudePermissionMode: 'default',
      active: true,
      createdAt: now,
      updatedAt: now,
    };

    this.store.saveBinding(binding);
    return binding;
  }

  /**
   * Deactivate a binding.
   */
  deactivateBinding(bindingId: string): void {
    const binding = this.store.getBinding(bindingId);
    if (binding) {
      binding.active = false;
      binding.updatedAt = new Date().toISOString();
      this.store.saveBinding(binding);
    }
  }

  /**
   * List all active bindings for a channel type.
   */
  listBindings(channelType?: ChannelType): ChannelBinding[] {
    const bindings = this.store.listBindings();
    if (!channelType) return bindings.filter(b => b.active);
    return bindings.filter(b => b.active && b.channelType === channelType);
  }
}
