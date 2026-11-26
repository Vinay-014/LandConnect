import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface StorageSaveResult {
  url: string;
  key: string;
  bytes: number;
}

export interface StorageProvider {
  saveBuffer(params: {
    subdir?: string;
    prefix: string;
    ext: string;
    buffer: Buffer;
  }): Promise<StorageSaveResult>;
}

/**
 * LocalDiskStorageProvider persists validated binary assets under a confined
 * directory tree and optionally rewrites the returned URL through
 * STORAGE_PUBLIC_BASE_URL (e.g., an edge CDN or S3/GCS bucket domain).
 */
export class LocalDiskStorageProvider implements StorageProvider {
  private readonly baseDir: string;
  private readonly publicBaseUrl: string;

  constructor(baseDir: string, publicBaseUrl = process.env.STORAGE_PUBLIC_BASE_URL || '') {
    this.baseDir = path.resolve(baseDir);
    this.publicBaseUrl = publicBaseUrl.trim().replace(/\/+$/, '');
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  async saveBuffer(params: {
    subdir?: string;
    prefix: string;
    ext: string;
    buffer: Buffer;
  }): Promise<StorageSaveResult> {
    const cleanSubdir = (params.subdir || '')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .trim();
    const cleanPrefix = params.prefix.replace(/[^a-zA-Z0-9_-]/g, '') || 'file';
    const cleanExt = params.ext.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const filename = `${cleanPrefix}_${crypto.randomBytes(6).toString('hex')}.${cleanExt}`;

    const targetDir = cleanSubdir
      ? path.resolve(this.baseDir, cleanSubdir)
      : this.baseDir;
    if (
      cleanSubdir &&
      !targetDir.startsWith(this.baseDir + path.sep)
    ) {
      throw new Error('Invalid storage subdirectory');
    }

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const targetPath = path.resolve(targetDir, filename);
    if (!targetPath.startsWith(this.baseDir + path.sep)) {
      throw new Error('Invalid storage target path');
    }

    await fs.promises.writeFile(targetPath, params.buffer);

    const relativeKey = cleanSubdir ? `${cleanSubdir}/${filename}` : filename;
    const relativeUrl = `/uploads/${relativeKey}`;
    const url = this.publicBaseUrl ? `${this.publicBaseUrl}${relativeUrl}` : relativeUrl;

    return {
      url,
      key: relativeKey,
      bytes: params.buffer.length,
    };
  }
}
