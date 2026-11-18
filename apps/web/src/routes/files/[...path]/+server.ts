import {
  contentTypeForKey,
  isLocalStorage,
  putLocalObject,
  resolveObjectPath,
  statLocalObject,
  transformLocalImage,
  verifyLocalSignedWrite
} from '#lib/server/file/localStorage.js';
import { error, type RequestHandler } from '@sveltejs/kit';
import { createReadStream } from 'fs';
import { Readable } from 'stream';

// Self-hosted stand-in for the R2 bucket + Cloudflare image resizing.
// GET /files/<key>                              -> original object
// GET /files/cdn-cgi/image/<options>/<key>      -> resized (cached) variant
// PUT /files/<key>?expires&ct&sig               -> signed upload from the browser

const TRANSFORM_PREFIX = 'cdn-cgi/image/';
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 200 * 1024 * 1024;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// Fog masks and thumbnails are overwritten in place, so they must never be cached
const cacheControlFor = (key: string) =>
  key.startsWith('fog/') || key.startsWith('thumbnail/') ? 'no-cache' : 'public, max-age=86400';

const ensureLocal = () => {
  if (!isLocalStorage()) error(404, 'Local file storage is disabled');
};

const parsePath = (rawPath: string) => {
  if (!rawPath.startsWith(TRANSFORM_PREFIX)) return { key: rawPath, transform: null };
  const rest = rawPath.slice(TRANSFORM_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash === -1) error(400, 'Invalid transform URL');
  return { key: rest.slice(slash + 1), transform: rest.slice(0, slash) };
};

const serve = async (rawPath: string, request: Request, headOnly: boolean) => {
  ensureLocal();
  const { key, transform } = parsePath(rawPath);

  let objectPath: string;
  try {
    objectPath = resolveObjectPath(key);
  } catch {
    error(400, 'Invalid path');
  }

  const stats = await statLocalObject(key);
  if (!stats) error(404, 'Not found');

  const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}${transform ? `-${transform}` : ''}"`;
  const baseHeaders = { ...corsHeaders, ETag: etag, 'Cache-Control': cacheControlFor(key) };
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  if (transform) {
    const result = await transformLocalImage(key, transform);
    if (!result) error(404, 'Not found');
    return new Response(headOnly ? null : new Uint8Array(result.data), {
      headers: { ...baseHeaders, 'Content-Type': result.contentType, 'Content-Length': String(result.data.length) }
    });
  }

  const body = headOnly ? null : (Readable.toWeb(createReadStream(objectPath)) as ReadableStream);
  return new Response(body, {
    headers: {
      ...baseHeaders,
      'Content-Type': await contentTypeForKey(key),
      'Content-Length': String(stats.size),
      'Last-Modified': stats.mtime.toUTCString(),
      'Accept-Ranges': 'none'
    }
  });
};

export const GET: RequestHandler = ({ params, request }) => serve(params.path ?? '', request, false);

export const HEAD: RequestHandler = ({ params, request }) => serve(params.path ?? '', request, true);

export const OPTIONS: RequestHandler = () => new Response(null, { status: 204, headers: corsHeaders });

export const PUT: RequestHandler = async ({ params, url, request }) => {
  ensureLocal();
  const key = params.path ?? '';
  if (key.startsWith(TRANSFORM_PREFIX) || !verifyLocalSignedWrite(key, url.searchParams)) {
    error(403, 'Invalid or expired upload signature');
  }

  const declaredLength = Number(request.headers.get('content-length'));
  if (declaredLength > MAX_UPLOAD_BYTES) error(413, 'File too large');

  const body = Buffer.from(await request.arrayBuffer());
  if (body.length > MAX_UPLOAD_BYTES) error(413, 'File too large');

  try {
    await putLocalObject(key, body);
  } catch (err) {
    console.error('Local upload failed', err);
    error(400, 'Invalid upload path');
  }
  return new Response(null, { status: 200, headers: corsHeaders });
};
