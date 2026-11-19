import { readFile, readdir, mkdir, copyFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

// Sites accepts a single Worker module. Bundle only the finished public Vite output.
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const files = {};
async function collect(relative) {
  for (const entry of await readdir(join('dist', relative), { withFileTypes: true })) {
    const path = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory() && ['assets', 'data'].includes(path.split('/')[0])) await collect(path);
    if (entry.isFile() && types[extname(path)]) {
      files['/' + path] = { type: types[extname(path)], gzip: gzipSync(await readFile(join('dist', path))).toString('base64') };
    }
  }
}
await collect('');
if (!files['/index.html'] || !files['/data/osm.json']) throw new Error('Public app build is incomplete');
await build({
  configFile: false, envFile: false, publicDir: false,
  plugins: [{
    name: 'bundle-public-site',
    resolveId: id => id === 'site:assets' ? '\0site:assets' : null,
    load: id => id === '\0site:assets' ? 'export default ' + JSON.stringify(files) : null,
  }],
  build: { ssr: 'server/worker.mjs', target: 'es2022', outDir: 'dist/server', emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'index.js', inlineDynamicImports: true } } },
});
await mkdir('dist/.openai', { recursive: true });
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
