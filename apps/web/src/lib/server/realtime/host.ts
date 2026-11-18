import { dev } from '$app/env';

// Host the browser connects to for realtime. Empty means "same origin as the page":
// the self-hosted Node server proxies /parties/* to the realtime container.
export const getPartykitHost = () => process.env.PUBLIC_PARTYKIT_HOST || (dev ? 'localhost:1999' : '');

// Where this server reaches the realtime worker directly (container network)
export const getRealtimeInternalUrl = () => {
  if (process.env.REALTIME_INTERNAL_URL) return process.env.REALTIME_INTERNAL_URL.replace(/\/+$/, '');
  const host = getPartykitHost() || 'localhost:1999';
  const protocol = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https';
  return `${protocol}://${host}`;
};
