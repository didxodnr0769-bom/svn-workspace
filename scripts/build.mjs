import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
await Promise.all([
  bundle({ entryPoints: ['src/main/main.ts'], outfile: 'dist-electron/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: false }),
  bundle({ entryPoints: ['src/main/preload.ts'], outfile: 'dist-electron/preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: false }),
  viteBuild(),
]);
