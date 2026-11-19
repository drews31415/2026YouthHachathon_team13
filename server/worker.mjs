import files from 'site:assets';
import { handleApi } from './api.mjs';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/')) return handleApi(request, env);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const asset = files[path === '/' ? '/index.html' : path];
    if (!asset) return new Response('Not found', { status: 404 });
    const headers = {
      'Content-Type': asset.type,
      'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    };
    if (request.method === 'HEAD') return new Response(null, { headers });
    const compressed = Uint8Array.from(atob(asset.gzip), c => c.charCodeAt(0));
    return new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')), { headers });
  },
};
