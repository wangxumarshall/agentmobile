/**
 * IM Bridge Server Entry Point.
 * Starts the bridge manager, registers channel adapters.
 */

import type { Server } from 'node:http';
import { loadConfig } from './config/config.js';
import { setupLogger, info, error } from './config/logger.js';
import { JsonFileStore } from './infra/store.js';
import { BridgeManager } from './bridge/bridge-manager.js';
import { MultiplexLLMProvider } from './providers/multiplex.js';
import { initBridgeContext, getBridgeContext } from './bridge/context.js';
import { PermissionBroker } from './bridge/permission-broker.js';
import { ChannelRouter } from './bridge/channel-router.js';
import { startFeishuCardActionServer, FEISHU_CARD_ACTION_PATH } from './feishu/card-action-server.js';

async function main(): Promise<void> {
  setupLogger();
  info('im-server', 'Starting IM Bridge Server...');

  const config = loadConfig();

  if (!config.im.enabled) {
    info('im-server', 'IM Bridge is not enabled. Set IM_BRIDGE_ENABLED=true to enable.');
    process.exit(0);
    return;
  }

  // Initialize core dependencies
  const store = new JsonFileStore();
  const llm = new MultiplexLLMProvider(config.im.claudeExecutable);
  const permissionBroker = new PermissionBroker();
  const channelRouter = new ChannelRouter(store);
  let feishuCallbackServer: Server | null = null;

  // Initialize bridge context (DI container)
  initBridgeContext({
    store,
    llm,
    permissions: {
      resolvePendingPermission: (id, resolution) => permissionBroker.handleCallback(`perm:${id}:${resolution.resolution}`),
    },
    lifecycle: {
      onBridgeStart: () => info('im-server', 'Bridge lifecycle: started'),
      onBridgeStop: () => info('im-server', 'Bridge lifecycle: stopped'),
    },
  });

  // Create bridge manager
  const bridgeManager = new BridgeManager(store, llm, {
    router: channelRouter,
    permissionBroker,
  });

  // Register Telegram adapter
  if (config.im.telegram.botToken) {
    info('im-server', 'Registering Telegram adapter...');
    const { TelegramAdapter } = await import('./adapters/telegram-adapter.js');
    const telegramAdapter = new TelegramAdapter({
      botToken: config.im.telegram.botToken,
      webhookSecret: config.im.telegram.webhookSecret,
      allowedUsers: [],
      defaultSession: config.im.telegram.defaultSession,
    });
    bridgeManager.registerAdapter(telegramAdapter);
  }

  // Register Feishu adapter
  if (config.im.feishu.appId && config.im.feishu.appSecret) {
    info('im-server', 'Registering Feishu adapter...');
    try {
      const { FeishuAdapter } = await import('./adapters/feishu-adapter.js');
      const feishuAdapter = new FeishuAdapter({
        appId: config.im.feishu.appId!,
        appSecret: config.im.feishu.appSecret!,
        domain: config.im.feishu.domain,
        allowedUsers: config.im.feishu.allowedUsers,
        store,
        router: channelRouter,
        permissionBroker,
        defaultWorkDir: config.im.defaultWorkDir,
        showToolCallCards: config.im.feishu.showToolCallCards,
      });
      bridgeManager.registerAdapter(feishuAdapter);

      if (config.im.feishu.callbackPort) {
        feishuCallbackServer = await startFeishuCardActionServer({
          port: config.im.feishu.callbackPort,
          adapter: feishuAdapter,
          verificationToken: config.im.feishu.verificationToken,
          encryptKey: config.im.feishu.encryptKey,
        });
      } else {
        info(
          'im-server',
          `Feishu card actions disabled. Set CTI_FEISHU_CALLBACK_PORT and configure ${FEISHU_CARD_ACTION_PATH} as the Feishu card callback URL to enable buttons.`,
        );
      }
    } catch (e) {
      error('im-server', `Failed to load Feishu adapter: ${e}`);
    }
  }

  // Start graceful shutdown handling
  const shutdown = (signal: string) => {
    info('im-server', `Received ${signal}, shutting down...`);
    bridgeManager.stop().then(async () => {
      if (feishuCallbackServer) {
        await new Promise<void>((resolve) => {
          feishuCallbackServer?.close(() => resolve());
        });
        feishuCallbackServer = null;
      }
      info('im-server', 'Shutdown complete');
      process.exit(0);
    }).catch(e => {
      error('im-server', `Shutdown error: ${e}`);
      process.exit(1);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start bridge
  try {
    await bridgeManager.start();
    info('im-server', 'IM Bridge started successfully');

    // Keep alive heartbeat
    setInterval(() => {
      const status = bridgeManager.getStatus();
      info('im-server', `Bridge status: running=${status.running}, adapters=${status.adapters.length}`);
    }, 60_000);
  } catch (e) {
    error('im-server', `Failed to start bridge: ${e}`);
    process.exit(1);
  }
}

main().catch(e => {
  error('im-server', `Fatal: ${e}`);
  process.exit(1);
});
