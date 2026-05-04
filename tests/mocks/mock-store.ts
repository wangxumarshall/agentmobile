/**
 * In-memory mock store for testing.
 * 
 * Provides the same interface as JsonFileStore but uses in-memory
 * storage for speed and test isolation.
 */

import type { ChannelBinding, ConversationSession, PlanWorkflow } from '../../im/bridge/types.js';

export class MockStore {
  private _bindings: Map<string, ChannelBinding> = new Map();
  private _sessions: Map<string, ConversationSession> = new Map();
  private _planWorkflows: Map<string, PlanWorkflow> = new Map();
  private _settings: Map<string, string> = new Map();

  get bindings() { return new Map(this._bindings); }
  get sessions() { return new Map(this._sessions); }
  get planWorkflows() { return new Map(this._planWorkflows); }
  get settings() { return new Map(this._settings); }

  // Bindings
  getBinding(id: string): ChannelBinding | undefined {
    return this._bindings.get(id);
  }

  getBindingByChat(channelType: string, chatId: string): ChannelBinding | undefined {
    for (const b of this._bindings.values()) {
      if (b.channelType === channelType && b.chatId === chatId && b.active) {
        return b;
      }
    }
    return undefined;
  }

  saveBinding(binding: ChannelBinding): void {
    this._bindings.set(binding.id, binding);
  }

  deleteBinding(id: string): void {
    this._bindings.delete(id);
  }

  listBindings(): ChannelBinding[] {
    return Array.from(this._bindings.values());
  }

  // Sessions
  getSession(id: string): ConversationSession | undefined {
    return this._sessions.get(id);
  }

  saveSession(session: ConversationSession): void {
    this._sessions.set(session.id, session);
  }

  deleteSession(id: string): void {
    this._sessions.delete(id);
  }

  deleteSessionState(bindingId: string): void {
    this._bindings.delete(bindingId);
    this._sessions.delete(bindingId);
    const now = new Date().toISOString();
    for (const workflow of this._planWorkflows.values()) {
      if (
        workflow.bindingId === bindingId &&
        (
          workflow.status === 'drafting' ||
          workflow.status === 'awaiting_decision' ||
          workflow.status === 'revising' ||
          workflow.status === 'executing'
        )
      ) {
        workflow.status = 'cancelled';
        workflow.updatedAt = now;
      }
    }
  }

  // Plan workflows
  getPlanWorkflow(id: string): PlanWorkflow | undefined {
    return this._planWorkflows.get(id);
  }

  getActivePlanWorkflowByBinding(bindingId: string): PlanWorkflow | undefined {
    return Array.from(this._planWorkflows.values())
      .filter(workflow =>
        workflow.bindingId === bindingId &&
        (
          workflow.status === 'drafting' ||
          workflow.status === 'awaiting_decision' ||
          workflow.status === 'revising' ||
          workflow.status === 'executing'
        ),
      )
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  }

  savePlanWorkflow(workflow: PlanWorkflow): void {
    this._planWorkflows.set(workflow.id, workflow);
  }

  deletePlanWorkflow(id: string): void {
    this._planWorkflows.delete(id);
  }

  listPlanWorkflows(): PlanWorkflow[] {
    return Array.from(this._planWorkflows.values());
  }

  // Settings
  getSetting(key: string): string | undefined {
    return this._settings.get(key);
  }

  setSetting(key: string, value: string): void {
    this._settings.set(key, value);
  }

  clear(): void {
    this._bindings.clear();
    this._sessions.clear();
    this._planWorkflows.clear();
    this._settings.clear();
  }
}
