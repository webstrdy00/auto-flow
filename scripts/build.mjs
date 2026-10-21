import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
await viteBuild({ base: './', build: { outDir: 'dist/renderer', emptyOutDir: true } });
await bundle({ entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'node:sqlite'] });
await bundle({ entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });
