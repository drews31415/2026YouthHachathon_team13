import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { Readable } from 'node:stream';
import { handleApi } from './server/api.mjs';

function localApi(env: Record<string, string | undefined>): Plugin {
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.startsWith('/api/')) return next();
    try {
      const origin = 'http://' + (req.headers.host ?? 'localhost');
      const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers: {} };
      for (const name of ['origin', 'content-type', 'content-length']) {
        const value = req.headers[name];
        if (typeof value === 'string') (init.headers as Record<string, string>)[name] = value;
      }
      if (req.method === 'POST') {
        init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
        init.duplex = 'half';
      }
      const response = await handleApi(new Request(new URL(req.url, origin), init), env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '서비스 요청을 처리하지 못했습니다.' }));
    }
  };
  return { name: 'public-data-api',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), localApi({ ...process.env, ...loadEnv(mode, process.cwd(), ['KMA_', 'SEOUL_', 'TMAP_']) })],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
}));
