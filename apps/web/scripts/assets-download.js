#!/usr/bin/env node

/**
 * Mirrors Table Slayer's static assets (illustrations, LUTs, default maps, edge
 * textures) from the public CDN into local file storage for self-hosted installs.
 * Existing files are skipped, so it is safe to run on every start.
 *
 *   node scripts/assets-download.js            # uses LOCAL_STORAGE_PATH or ./data/files
 *   FORCE_DOWNLOAD=true node scripts/assets-download.js
 */

import { config } from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Referenced by the app but not listed in the upstream manifest
const EXTRA_FILES = [
  'edgetextures/clouds-01.webp',
  'edgetextures/forrest-01.webp',
  'edgetextures/ice-01.webp',
  'edgetextures/ice-02.webp',
  'edgetextures/stars-01.webp',
  'edgetextures/stars-02.webp',
  'edgetextures/stone-01.webp',
  'edgetextures/stone-02.webp'
];

const exists = async (file) => {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
};

export const downloadStaticAssets = async ({ root, force = false, log = console.log } = {}) => {
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'static-assets.json'), 'utf-8'));
  const source = process.env.ASSETS_SOURCE_URL || manifest.source;
  const files = [...new Set([...manifest.files, ...EXTRA_FILES])].filter((file) => !file.endsWith('.ts'));
  const storageRoot = path.resolve(root);

  let downloaded = 0;
  const failed = [];
  const queue = [...files];

  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const target = path.join(storageRoot, file);
      if (!force && (await exists(target))) continue;
      try {
        const response = await fetch(`${source}/${file}`, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = Buffer.from(await response.arrayBuffer());
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(`${target}.tmp`, data);
        await fs.rename(`${target}.tmp`, target);
        downloaded++;
        log(`  ✓ ${file} (${(data.length / 1024).toFixed(0)} KB)`);
      } catch (error) {
        failed.push(file);
        log(`  ✗ ${file}: ${error.message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: 4 }, worker));
  return { total: files.length, downloaded, failed };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  config({ path: path.resolve(process.cwd(), '.env'), override: false });
  const root = process.env.LOCAL_STORAGE_PATH || './data/files';
  console.log(`Downloading static assets into ${path.resolve(root)}`);
  const result = await downloadStaticAssets({ root, force: process.env.FORCE_DOWNLOAD === 'true' });
  console.log(
    `Done: ${result.downloaded} downloaded, ${result.total - result.downloaded - result.failed.length} already present, ${result.failed.length} failed`
  );
  process.exit(result.failed.length > 0 ? 1 : 0);
}
