import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    // Derive base path from GITHUB_REPOSITORY (e.g. "user/my-fork" -> "/my-fork/")
    // so the app works on any fork without manual edits. Falls back to
    // "/read-something/" for the upstream repo / local builds.
    const ghRepo = process.env.GITHUB_REPOSITORY;
    const base = ghRepo ? `/${ghRepo.split('/')[1]}/` : '/read-something/';
    return {
      base,
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      optimizeDeps: {
        // Keep mobi parser out of pre-bundling so alias patches are applied consistently.
        exclude: ['@lingo-reader/mobi-parser', '@lingo-reader/shared'],
      },
      plugins: [
        {
          name: 'patch-lingo-mobi-parser-toc',
          enforce: 'pre',
          transform(code, id) {
            if (!id.includes('@lingo-reader/mobi-parser/dist/index.browser.mjs')) {
              return null;
            }
            let patched = code;
            const tocTarget = 'this.parseNavMap(tocAst.wrapper.children, toc);';
            if (patched.includes(tocTarget)) {
              patched = patched.replace(
                tocTarget,
                'this.parseNavMap((tocAst && tocAst.wrapper && tocAst.wrapper.children) || [], toc);'
              );
            }

            const coverTarget = 'if (offset) {';
            if (patched.includes(coverTarget)) {
              patched = patched.replace(coverTarget, 'if (offset !== void 0) {');
            }

            return patched === code ? null : patched;
          },
        },
        react(),
        {
          // Rewrite hardcoded "/read-something/" in public assets (404.html,
          // manifest.webmanifest) to the actual base path so forks with a
          // different repo name work out of the box.
          name: 'rewrite-base-in-public-assets',
          apply: 'build',
          closeBundle() {
            if (base === '/read-something/') return;
            const outDir = path.resolve(__dirname, 'dist');
            const targets = ['404.html', 'manifest.webmanifest'];
            for (const file of targets) {
              const p = path.join(outDir, file);
              if (!fs.existsSync(p)) continue;
              const original = fs.readFileSync(p, 'utf8');
              const updated = original.split('/read-something/').join(base);
              if (updated !== original) fs.writeFileSync(p, updated);
            }
          },
        },
      ],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@lingo-reader/shared': path.resolve(__dirname, 'utils/lingoReaderSharedCompat.ts'),
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
