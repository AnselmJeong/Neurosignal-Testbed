import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectrobunConfig } from 'electrobun';

const here = import.meta.dir;
const repoRoot = join(here, '..', '..');

// Single source of truth for the version: the repo's pyproject.toml ([project] version).
function repoVersion(): string {
  try {
    const match = readFileSync(join(repoRoot, 'pyproject.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m);
    if (match?.[1]) return match[1];
  } catch { /* fall through */ }
  return '0.0.0';
}

// Packaged payload produced by scripts/desktop (see apps/desktop/README.md):
//   apps/desktop/build/python-runtime  -> Resources/app/python-runtime  (python/bin/python3.12 …)
//   apps/web/dist                      -> Resources/app/web
// Only the web build is copied here (when present); the python runtime is added by build_app.sh.
// `electrobun dev` without a runtime falls back to the repo .venv; release builds verify both.
const payload: Record<string, string> = {
  'src/views/loading/index.html': 'views/loading/index.html',
};
// The bundled python runtime is NOT copied here: Electrobun's build.copy dereferences symlinks and is
// very slow for ~31k files. scripts/desktop/build_app.sh adds it with `ditto --clone` after the build,
// so dev builds never pick up a stale packaged runtime.
if (existsSync(join(repoRoot, 'apps', 'web', 'dist', 'index.html'))) payload['../web/dist'] = 'web';

export default {
  app: { name: 'Neurosignal Testbed', identifier: 'local.neurosignal.testbed', version: repoVersion() },
  build: {
    mainProcess: 'bun',
    bun: { entrypoint: 'src/bun/index.ts' },
    copy: payload,
    mac: {
      icons: 'assets/AppIcon.iconset',
      bundleCEF: false,
      bundleWGPU: false,
      codesign: false,
      notarize: false,
      createDmg: false,
      defaultRenderer: 'native',
    },
  },
  runtime: { exitOnLastWindowClosed: true },
} satisfies ElectrobunConfig;
