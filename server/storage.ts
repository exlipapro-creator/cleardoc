/**
 * ClearDoc Secure Temporary Storage Abstraction
 * Enforces session isolation, random UUID storage keys, and magic-byte inspection.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from './config.js';

export interface StoragePaths {
  sessionDir: string;
  originalDir: string;
  workingDir: string;
  outputDir: string;
  previewsDir: string;
}

export interface StoredFile {
  fileId: string;
  sessionId: string;
  originalFilename: string;
  sanitizedFilename: string;
  filePath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export class StorageService {
  constructor() {
    this.ensureBaseDir();
  }

  private ensureBaseDir(): void {
    if (!fs.existsSync(CONFIG.BASE_STORAGE_DIR)) {
      fs.mkdirSync(CONFIG.BASE_STORAGE_DIR, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Initializes isolated temporary session folders
   */
  public getSessionPaths(sessionId: string): StoragePaths {
    // Validate session ID to prevent directory traversal
    if (!/^[a-zA-Z0-9_-]{10,64}$/.test(sessionId)) {
      throw new Error('INVALID_SESSION_IDENTIFIER');
    }

    const sessionDir = path.join(CONFIG.BASE_STORAGE_DIR, sessionId);
    const originalDir = path.join(sessionDir, 'original');
    const workingDir = path.join(sessionDir, 'working');
    const outputDir = path.join(sessionDir, 'output');
    const previewsDir = path.join(sessionDir, 'previews');

    return { sessionDir, originalDir, workingDir, outputDir, previewsDir };
  }

  public initSession(sessionId: string): StoragePaths {
    const paths = this.getSessionPaths(sessionId);
    for (const dir of Object.values(paths)) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
    }
    return paths;
  }

  /**
   * Validates magic bytes/signatures against declared MIME types
   */
  public validateMagicBytes(buffer: Buffer): { isValid: boolean; detectedMime: string } {
    if (buffer.length < 8) {
      return { isValid: false, detectedMime: 'unknown' };
    }

    // PDF check: starts with %PDF-
    if (
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46 &&
      buffer[4] === 0x2d
    ) {
      return { isValid: true, detectedMime: 'application/pdf' };
    }

    // PNG check: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return { isValid: true, detectedMime: 'image/png' };
    }

    // JPEG check: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { isValid: true, detectedMime: 'image/jpeg' };
    }

    // WEBP check: RIFF .... WEBP
    if (
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return { isValid: true, detectedMime: 'image/webp' };
    }

    // TIFF check: II*. (0x49 0x49 0x2A 0x00) or MM.* (0x4D 0x4D 0x00 0x2A)
    if (
      (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
    ) {
      return { isValid: true, detectedMime: 'image/tiff' };
    }

    return { isValid: false, detectedMime: 'unknown' };
  }

  /**
   * Stores an incoming upload securely with randomized UUID filename
   */
  public async storeUpload(
    sessionId: string,
    originalFilename: string,
    buffer: Buffer
  ): Promise<StoredFile> {
    if (buffer.length > CONFIG.MAX_FILE_SIZE_BYTES) {
      throw new Error('FILE_TOO_LARGE');
    }

    const { isValid, detectedMime } = this.validateMagicBytes(buffer);
    if (!isValid || !CONFIG.SUPPORTED_MIME_TYPES.includes(detectedMime)) {
      throw new Error('UNSUPPORTED_FORMAT');
    }

    const paths = this.initSession(sessionId);
    const fileId = uuidv4();
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    // Extension determined strictly by validated MIME, not user input
    const extMap: Record<string, string> = {
      'application/pdf': '.pdf',
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/tiff': '.tiff',
    };
    const ext = extMap[detectedMime] || '.bin';
    const sanitizedFilename = `${fileId}${ext}`;
    const filePath = path.join(paths.originalDir, sanitizedFilename);

    await fs.promises.writeFile(filePath, buffer, { mode: 0o600 });

    return {
      fileId,
      sessionId,
      originalFilename,
      sanitizedFilename,
      filePath,
      mimeType: detectedMime,
      sizeBytes: buffer.length,
      sha256,
    };
  }

  /**
   * Cleans an entire session folder
   */
  public async deleteSession(sessionId: string): Promise<void> {
    try {
      const paths = this.getSessionPaths(sessionId);
      if (fs.existsSync(paths.sessionDir)) {
        await fs.promises.rm(paths.sessionDir, { recursive: true, force: true });
      }
    } catch {
      // Ignored for idempotency
    }
  }

  /**
   * Cleans all sessions older than retention policy
   */
  public async cleanupExpiredSessions(retentionMs = CONFIG.RETENTION_MS): Promise<number> {
    let cleaned = 0;
    try {
      if (!fs.existsSync(CONFIG.BASE_STORAGE_DIR)) return 0;
      const entries = await fs.promises.readdir(CONFIG.BASE_STORAGE_DIR, { withFileTypes: true });
      const now = Date.now();

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(CONFIG.BASE_STORAGE_DIR, entry.name);
          const stat = await fs.promises.stat(dirPath);
          if (now - stat.mtimeMs > retentionMs) {
            await fs.promises.rm(dirPath, { recursive: true, force: true });
            cleaned++;
          }
        }
      }
    } catch (err) {
      console.error('[StorageService] Cleanup error:', err);
    }
    return cleaned;
  }
}

export const storageService = new StorageService();
