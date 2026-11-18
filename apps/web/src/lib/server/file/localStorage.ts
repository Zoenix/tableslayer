import { createHash, createHmac, timingSafeEqual } from 'crypto';
import fs from 'fs/promises';
import mime from 'mime';
import path from 'path';

// Filesystem-backed replacement for R2 (self-hosting). Objects live under
// LOCAL_STORAGE_PATH with the same keys R2 would use, and are served by
// /files/[...path] together with a Cloudflare-compatible /cdn-cgi/image resizer.

export const isLocalStorage = () =>
  (process.env.STORAGE_DRIVER ?? (process.env.CLOUDFLARE_R2_ACCESS_KEY ? 's3' : 'local')) === 'local';

export const localStorageRoot = () => path.resolve(process.env.LOCAL_STORAGE_PATH || './data/files');

const cacheRoot = () => path.join(localStorageRoot(), '.cache');

const baseUrl = () => (process.env.BASE_URL || 'http://localhost:5174').replace(/\/+$/, '');

export const getBucketUrl = () =>
  process.env.CLOUDFLARE_R2_BUCKET_URL || (isLocalStorage() ? `${baseUrl()}/files` : 'https://files.tableslayer.com');

export const resolveObjectPath = (key: string) => {
  const root = localStorageRoot();
  const cleanKey = decodeURIComponent(key.split('?')[0]).replace(/^\/+/, '');
  const resolved = path.resolve(root, cleanKey);
  if (!cleanKey || cleanKey.startsWith('.cache') || !resolved.startsWith(root + path.sep)) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return resolved;
};

const MAGIC_TYPES: [string, (header: Buffer) => boolean][] = [
  ['image/png', (h) => h.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))],
  ['image/jpeg', (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff],
  ['image/gif', (h) => h.subarray(0, 4).toString('latin1') === 'GIF8'],
  [
    'image/webp',
    (h) => h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP'
  ],
  ['image/avif', (h) => h.subarray(4, 12).toString('latin1') === 'ftypavif'],
  ['video/mp4', (h) => h.subarray(4, 8).toString('latin1') === 'ftyp'],
  ['video/webm', (h) => h.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))]
];

// R2 keeps each upload's Content-Type; on disk we infer it from the extension and
// fall back to sniffing for extensionless keys (e.g. avatars fetched from Gravatar)
export const contentTypeForKey = async (key: string) => {
  const fromExtension = mime.getType(key.split('?')[0]);
  if (fromExtension) return fromExtension;
  try {
    const handle = await fs.open(resolveObjectPath(key), 'r');
    try {
      const header = Buffer.alloc(16);
      await handle.read(header, 0, 16, 0);
      return MAGIC_TYPES.find(([, matches]) => matches(header))?.[0] ?? 'application/octet-stream';
    } finally {
      await handle.close();
    }
  } catch {
    return 'application/octet-stream';
  }
};

export const putLocalObject = async (key: string, body: Buffer | Uint8Array) => {
  const target = resolveObjectPath(key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, body);
  await fs.rename(temp, target);
  return key;
};

export const copyLocalObject = async (sourceKey: string, destinationKey: string) => {
  const destination = resolveObjectPath(destinationKey);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(resolveObjectPath(sourceKey), destination);
  return destinationKey;
};

export const statLocalObject = async (key: string) => {
  try {
    const stats = await fs.stat(resolveObjectPath(key));
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
};

// ---------- Signed upload URLs (stand-in for R2 presigned PUTs) ----------

const signingSecret = () =>
  process.env.STORAGE_SIGNING_SECRET || process.env.INTERNAL_API_TOKEN || 'dev-internal-token';

const sign = (key: string, contentType: string, expires: number) =>
  createHmac('sha256', signingSecret()).update(`PUT\n${key}\n${contentType}\n${expires}`).digest('hex');

export const generateLocalSignedWriteUrl = (key: string, contentType: string, expiresInSeconds = 3600) => {
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const params = new URLSearchParams({
    expires: String(expires),
    ct: contentType,
    sig: sign(key, contentType, expires)
  });
  return `${getBucketUrl()}/${key}?${params}`;
};

export const verifyLocalSignedWrite = (key: string, params: URLSearchParams) => {
  const expires = Number(params.get('expires'));
  const contentType = params.get('ct') ?? '';
  const signature = params.get('sig') ?? '';
  if (!expires || expires < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(key, contentType, expires));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
};

// ---------- Cloudflare-compatible image transformations ----------

export type ImageTransformOptions = {
  width?: number;
  height?: number;
  fit: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
  gravity: string;
  quality?: number;
  json: boolean;
};

const MAX_DIMENSION = 6000;

export const parseTransformOptions = (raw: string): ImageTransformOptions => {
  const options: ImageTransformOptions = { fit: 'scale-down', gravity: 'center', json: false };
  for (const part of raw.split(',')) {
    const [name, value] = part.split('=');
    const number = Math.min(Math.max(Math.round(Number(value)), 1), MAX_DIMENSION);
    switch (name) {
      case 'w':
      case 'width':
        if (Number.isFinite(number)) options.width = number;
        break;
      case 'h':
      case 'height':
        if (Number.isFinite(number)) options.height = number;
        break;
      case 'q':
      case 'quality':
        if (Number.isFinite(number)) options.quality = Math.min(number, 100);
        break;
      case 'fit':
        if (['scale-down', 'contain', 'cover', 'crop', 'pad'].includes(value)) {
          options.fit = value as ImageTransformOptions['fit'];
        }
        break;
      case 'gravity':
        options.gravity = value;
        break;
      case 'format':
        options.json = value === 'json';
        break;
    }
  }
  return options;
};

const SHARP_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff']);

const sharpPosition = async (gravity: string) => {
  const { default: sharp } = await import('sharp');
  if (gravity === 'auto') return sharp.strategy.attention;
  const map: Record<string, string> = {
    center: 'centre',
    north: 'north',
    south: 'south',
    east: 'east',
    west: 'west',
    top: 'north',
    bottom: 'south',
    left: 'west',
    right: 'east'
  };
  return map[gravity] ?? 'centre';
};

const resizeImage = async (source: string, options: ImageTransformOptions) => {
  const { default: sharp } = await import('sharp');
  const image = sharp(source, { animated: true, limitInputPixels: false });
  const metadata = await image.metadata();
  const format = metadata.format && SHARP_FORMATS.has(metadata.format) ? metadata.format : 'jpeg';

  const fitMap = {
    'scale-down': { fit: 'inside', withoutEnlargement: true },
    contain: { fit: 'inside', withoutEnlargement: false },
    cover: { fit: 'cover', withoutEnlargement: false },
    crop: { fit: 'cover', withoutEnlargement: true },
    pad: { fit: 'contain', withoutEnlargement: false }
  } as const;

  let pipeline = image.rotate();
  if (options.width || options.height) {
    pipeline = pipeline.resize({
      width: options.width,
      height: options.height,
      ...fitMap[options.fit],
      position: await sharpPosition(options.gravity),
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    });
  }
  const quality = options.quality ?? 85;
  pipeline = pipeline.toFormat(format as 'jpeg', format === 'png' || format === 'gif' ? {} : { quality });

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  const fileSize = (await fs.stat(source)).size;
  return {
    data,
    contentType: mime.getType(format) ?? 'application/octet-stream',
    details: {
      width: info.width,
      height: info.pageHeight ?? info.height,
      original: {
        width: metadata.width ?? 0,
        height: metadata.pageHeight ?? metadata.height ?? 0,
        file_size: fileSize,
        format: mime.getType(metadata.format ?? '') ?? `image/${metadata.format}`
      }
    }
  };
};

export type TransformResult = { data: Buffer; contentType: string };

/**
 * Resizes (or describes, with format=json) a stored image. Results are cached on
 * disk keyed by options + source mtime, so each variant is only rendered once.
 */
export const transformLocalImage = async (key: string, rawOptions: string): Promise<TransformResult | null> => {
  const stats = await statLocalObject(key);
  if (!stats) return null;
  const source = resolveObjectPath(key);
  const options = parseTransformOptions(rawOptions);

  const cacheKey = createHash('sha256').update(`${key}|${rawOptions}|${stats.mtimeMs}|${stats.size}`).digest('hex');
  const cacheFile = path.join(cacheRoot(), cacheKey.slice(0, 2), cacheKey);

  try {
    const [data, contentType] = await Promise.all([fs.readFile(cacheFile), fs.readFile(`${cacheFile}.type`, 'utf-8')]);
    return { data, contentType };
  } catch {
    // Not cached yet
  }

  let result: TransformResult;
  const contentType = await contentTypeForKey(key);
  if (!contentType.startsWith('image/') || contentType === 'image/svg+xml') {
    // Not something we can resize: serve the original untouched
    if (options.json) return null;
    result = { data: await fs.readFile(source), contentType };
  } else {
    const resized = await resizeImage(source, options);
    result = options.json
      ? { data: Buffer.from(JSON.stringify(resized.details)), contentType: 'application/json' }
      : { data: resized.data, contentType: resized.contentType };
  }

  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await Promise.all([fs.writeFile(cacheFile, result.data), fs.writeFile(`${cacheFile}.type`, result.contentType)]);
  return result;
};

export const getLocalImageDetails = async (key: string, rawOptions: string) => {
  const result = await transformLocalImage(key, `format=json,${rawOptions}`);
  if (!result) throw new Error(`Image not found: ${key}`);
  return JSON.parse(result.data.toString('utf-8'));
};
