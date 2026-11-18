import { getDatabaseMode } from '#lib/db/app/index.js';
import { getBucketUrl, isEmailEnabled, isGoogleOAuthEnabled, isStripeEnabled } from '#lib/server/index.js';
import { getPartykitHost } from '#lib/server/realtime/host.js';
import { json, type RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = async () => {
  const partykitHost = getPartykitHost() || 'same-origin';

  return json({
    status: 'ok',
    databaseMode: getDatabaseMode(),
    region: process.env.FLY_REGION || 'unknown',
    alloc: process.env.FLY_ALLOC_ID || 'unknown',
    app: process.env.FLY_APP_NAME || 'unknown',
    timestamp: new Date().toISOString(),
    isStripeEnabled: isStripeEnabled(),
    isGoogleOAuthEnabled: isGoogleOAuthEnabled(),
    isEmailEnabled: isEmailEnabled(),
    r2BucketUrl: getBucketUrl(),
    partykit: {
      host: partykitHost,
      url: partykitHost.includes('localhost') ? `ws://${partykitHost}` : `wss://${partykitHost}`
    }
  });
};
