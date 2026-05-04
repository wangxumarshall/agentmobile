/**
 * JSON file-based state store for IM bridge.
 * Persists sessions, bindings, and settings.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ChannelBinding, ConversationSession, PlanWorkflow } from '../bridge/types.js';
import { info, error } from '../config/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');
const imDataDir = process.env.CTI_HOME || join(rootDir, 'im-data');

interface StoreState {
  bindings: Record<string, ChannelBinding>;
  sessions: Record<string, ConversationSession>;
  planWorkflows: Record<string, PlanWorkflow>;
  settings: Record<string, string>;
}

export class JsonFileStore {
  private dataDir: string;
  private state: StoreState;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || imDataDir;
    this.state = { bindings: {}, sessions: {}, planWorkflows: {}, settings: {} };
    this.ensureDirs();
    this.load();
  }

  private ensureDirs(): void {
    mkdirSync(join(this.dataDir, 'messages'), { recursive: true });
    mkdirSync(join(this.dataDir, 'runtime'), { recursive: true });
  }

  private load(): void {
    try {
      const bindingsPath = join(this.dataDir, 'bindings.json');
      const sessionsPath = join(this.dataDir, 'sessions.json');
      const planWorkflowsPath = join(this.dataDir, 'plan-workflows.json');
      const settingsPath = join(this.dataDir, 'settings.json');

      if (existsSync(bindingsPath)) {
        this.state.bindings = JSON.parse(readFileSync(bindingsPath, 'utf8'));
      }
      if (existsSync(sessionsPath)) {
        this.state.sessions = JSON.parse(readFileSync(sessionsPath, 'utf8'));
      }
      if (existsSync(planWorkflowsPath)) {
        this.state.planWorkflows = JSON.parse(readFileSync(planWorkflowsPath, 'utf8'));
      }
      if (existsSync(settingsPath)) {
        this.state.settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      }

      info(
        'store',
        `Loaded ${Object.keys(this.state.bindings).length} bindings, ` +
          `${Object.keys(this.state.sessions).length} sessions, ` +
          `${Object.keys(this.state.planWorkflows).length} plan workflows`,
      );
    } catch (e) {
      error('store', `Failed to load state: ${e}`);
    }
  }

  private save(): void {
    try {
      writeFileSync(
        join(this.dataDir, 'bindings.json'),
        JSON.stringify(this.state.bindings, null, 2),
        'utf8'
      );
      writeFileSync(
        join(this.dataDir, 'sessions.json'),
        JSON.stringify(this.state.sessions, null, 2),
        'utf8'
      );
      writeFileSync(
        join(this.dataDir, 'settings.json'),
        JSON.stringify(this.state.settings, null, 2),
        'utf8'
      );
      writeFileSync(
        join(this.dataDir, 'plan-workflows.json'),
        JSON.stringify(this.state.planWorkflows, null, 2),
        'utf8'
      );
    } catch (e) {
      error('store', `Failed to save state: ${e}`);
    }
  }

  // ── Bindings ──────────────────────────────────────────────

  getBinding(id: string): ChannelBinding | undefined {
    return this.state.bindings[id];
  }

  getBindingByChat(channelType: string, chatId: string, channelInstanceId?: string): ChannelBinding | undefined {
    return Object.values(this.state.bindings).find(
      b =>
        b.channelType === channelType &&
        b.chatId === chatId &&
        b.active &&
        (!channelInstanceId || b.channelInstanceId === channelInstanceId)
    );
  }

  saveBinding(binding: ChannelBinding): void {
    this.state.bindings[binding.id] = binding;
    this.save();
  }

  deleteBinding(id: string): void {
    delete this.state.bindings[id];
    this.save();
  }

  listBindings(): ChannelBinding[] {
    return Object.values(this.state.bindings);
  }

  // ── Sessions ──────────────────────────────────────────────

  getSession(id: string): ConversationSession | undefined {
    return this.state.sessions[id];
  }

  saveSession(session: ConversationSession): void {
    this.state.sessions[session.id] = session;
    this.save();
  }

  deleteSession(id: string): void {
    delete this.state.sessions[id];
    this.save();
  }

  // ── Plan Workflows ───────────────────────────────────────

  getPlanWorkflow(id: string): PlanWorkflow | undefined {
    return this.state.planWorkflows[id];
  }

  getActivePlanWorkflowByBinding(bindingId: string): PlanWorkflow | undefined {
    return Object.values(this.state.planWorkflows)
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
    this.state.planWorkflows[workflow.id] = workflow;
    this.save();
  }

  deletePlanWorkflow(id: string): void {
    delete this.state.planWorkflows[id];
    this.save();
  }

  listPlanWorkflows(): PlanWorkflow[] {
    return Object.values(this.state.planWorkflows);
  }

  // ── Settings ──────────────────────────────────────────────

  getSetting(key: string): string | undefined {
    return this.state.settings[key];
  }

  setSetting(key: string, value: string): void {
    this.state.settings[key] = value;
    this.save();
  }
}
