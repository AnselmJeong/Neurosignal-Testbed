# Neurosignal Testbed — desktop shell (Electrobun 2)

macOS app shell around the Python backend (`neurobridge_api.desktop`) and the built web app.

```sh
bun install
bun test            # pure helpers + supervisor against fake backends
bun run typecheck   # projects the Electrobun SDK (.hutch/) if missing, then tsc --noEmit
bun run dev         # electrobun dev; backend = repo .venv, web = apps/web/dist (build it first)
bun run build       # ../../scripts/desktop/build_app.sh (packaging)
bun run icon        # regenerate assets/AppIcon.iconset
```

## Contracts

- Packaged payload: `electrobun.config.ts` copies only the web build; `scripts/desktop/build_app.sh`
  adds the python runtime with `ditto --clone` after `electrobun build` (Electrobun's copy dereferences symlinks):
  `build/python-runtime` → `Resources/app/python-runtime` (launch `python-runtime/python/bin/python3.12`),
  `../web/dist` → `Resources/app/web`.
- Launch: `<python> -I -u -m neurobridge_api.desktop --data-dir <userData> --port 0 --parent-pid <bun pid> --ready-stdout --web-dir <web>`.
  Environment: `backendEnv()` in `src/bun/backend.ts` is the single list (PATH=/usr/bin:/bin:/usr/sbin:/sbin; data/cache dirs under userData).
- READY: one stdout line `NEUROSIGNAL_READY {"port": N, "pid": N, "version": "x"}`, then `/api/health` must answer `{"status": "ready"}`; timeout 120 s.
- Data: `Utils.paths.userData` = `~/Library/Application Support/local.neurosignal.testbed/<channel>` (`stable` for release builds, `dev` for dev builds). Logs: `<userData>/logs/backend.log`, `desktop.log`.
- Stop: SIGTERM, wait 12 s, SIGKILL. Quit waits for the backend; the backend also exits when the shell dies (`--parent-pid`).
- Dev backend lookup: `NEUROSIGNAL_PROJECT_ROOT`, else walk up from the app's cwd to the repo (`pyproject.toml` + `apps/api`), using `<repo>/.venv/bin/python`.
