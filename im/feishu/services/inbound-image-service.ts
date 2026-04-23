/**
 * Inbound Image Service for Feishu.
 *
 * Downloads and caches images from inbound Feishu messages.
 * Supports deduplication via message_id and image_key.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'node:crypto';
import { LarkClient } from '../lark-client.js';
import { info, error, debug } from '../../config/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');
const defaultCacheDir = join(rootDir, 'im-data', 'cache', 'images');

interface ImageCacheEntry {
  imageKey: string;
  localPath: string;
  mimeType: string;
  fileSize: number;
  downloadedAt: number;
}

export class InboundImageService {
  private larkClient: LarkClient;
  private cacheDir: string;
  private memoryCache: Map<string, ImageCacheEntry> = new Map();

  constructor(larkClient: LarkClient, cacheDir?: string) {
    this.larkClient = larkClient;
    this.cacheDir = cacheDir || defaultCacheDir;

    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Download an image by image_key and cache it locally.
   */
  async downloadImage(imageKey: string, messageId?: string): Promise<ImageCacheEntry | null> {
    // Check memory cache
    const cacheKey = messageId || imageKey;
    const cached = this.memoryCache.get(cacheKey);
    if (cached) {
      debug('inbound-image', `Using cached image: ${cacheKey}`);
      return cached;
    }

    // Check disk cache
    const diskPath = this.getDiskPath(imageKey);
    if (existsSync(diskPath)) {
      try {
        const content = readFileSync(diskPath);
        const entry: ImageCacheEntry = {
          imageKey,
          localPath: diskPath,
          mimeType: 'image/png', // Default, could be improved
          fileSize: content.length,
          downloadedAt: Date.now(),
        };
        this.memoryCache.set(cacheKey, entry);
        debug('inbound-image', `Loaded from disk cache: ${imageKey}`);
        return entry;
      } catch {
        // Ignore corrupted cache
      }
    }

    // Download from Feishu
    try {
      const client = await this.larkClient.getClient();
      if (!client) throw new Error('Lark client not initialized');

      const result = await client.request(
        'GET',
        `/open-apis/im/v1/images/${imageKey}`,
        {},
      );

      // The response contains binary data
      const content = result;
      const localPath = diskPath;

      writeFileSync(localPath, content);

      const entry: ImageCacheEntry = {
        imageKey,
        localPath,
        mimeType: 'image/png',
        fileSize: content.length || 0,
        downloadedAt: Date.now(),
      };

      this.memoryCache.set(cacheKey, entry);
      debug('inbound-image', `Downloaded image: ${imageKey} -> ${localPath}`);
      return entry;
    } catch (e) {
      error('inbound-image', `Failed to download image: ${e}`);
      return null;
    }
  }

  /**
   * Get the local disk path for an image_key.
   */
  private getDiskPath(imageKey: string): string {
    const hash = createHash('md5').update(imageKey).digest('hex').slice(0, 8);
    return join(this.cacheDir, `${hash}.png`);
  }

  /**
   * Get a cached image entry without downloading.
   */
  getCached(imageKey: string, messageId?: string): ImageCacheEntry | undefined {
    return this.memoryCache.get(messageId || imageKey);
  }

  /**
   * Clear the memory cache.
   */
  clearMemory(): void {
    this.memoryCache.clear();
  }
}
