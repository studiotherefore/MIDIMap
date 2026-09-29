// Cloudflare Worker for MIDIMap. Serves the site's files, and answers the
// page's key-file request (config.local.json, the same path as a local setup)
// from secrets, so no key or token ever has to be in the public repo.
//   npx wrangler secret put MAPS_API_KEY       Google Maps key (the instrument)
//   npx wrangler secret put MAPILLARY_TOKEN    Mapillary client token (experiments)

const KEY_PATH = '/config.local.json';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === KEY_PATH) {
      const config = {};
      if (env.MAPS_API_KEY) config.mapsApiKey = env.MAPS_API_KEY;
      if (env.MAPILLARY_TOKEN) config.mapillaryToken = env.MAPILLARY_TOKEN;
      // Nothing set: 404, and the page falls back to a key saved in the browser.
      if (!Object.keys(config).length) return new Response('Not found', { status: 404 });
      return new Response(JSON.stringify(config), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
