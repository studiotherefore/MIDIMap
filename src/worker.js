// Cloudflare Worker for MIDIMap. Serves the site's files, and answers the
// page's key-file request (config.local.json, the same path as a local setup)
// from the MAPS_API_KEY secret, so the key never has to be in the public repo.
// Set the secret with: npx wrangler secret put MAPS_API_KEY

const KEY_PATH = '/config.local.json';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === KEY_PATH) {
      // No secret: 404, and the page falls back to a key saved in the browser.
      if (!env.MAPS_API_KEY) return new Response('Not found', { status: 404 });
      return new Response(JSON.stringify({ mapsApiKey: env.MAPS_API_KEY }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
