import { createServer } from 'vite';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
await Promise.all([
  build({ entryPoints: ['src/main/main.ts'], outfile: 'dist-electron/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] }),
  build({ entryPoints: ['src/main/preload.ts'], outfile: 'dist-electron/preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] }),
]);
const server = await createServer();
await server.listen();
const env = { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5187' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['.'], { stdio: 'inherit', env });
const close = async () => { child.kill(); await server.close(); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
child.once('exit', async code => { await server.close(); process.exit(code ?? 0); });
