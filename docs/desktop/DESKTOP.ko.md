# Neurosignal Testbed 데스크톱 앱 (macOS)

Neurosignal Testbed를 macOS 앱(`Neurosignal Testbed.app`, 번들 ID `local.neurosignal.testbed`)으로
실행합니다. 앱 셸은 Electrobun 2(`electrobun` 2.0.6, bun 메인 프로세스)로 만들었습니다. 앱 안에
독립 실행형 Python 런타임과 빌드된 웹 화면이 함께 들어 있어서, 실행할 때 저장소, `.venv`, `uv`,
Homebrew, 셸 PATH가 필요하지 않습니다. 기존 웹/API 개발 흐름(`uv run neurosignal-api`, `npm run dev`)은
그대로 동작합니다.

관련 파일:

| 경로 | 역할 |
| --- | --- |
| `apps/desktop/electrobun.config.ts` | 앱 이름·식별자·버전(`pyproject.toml`의 version), 번들에 넣을 파일 |
| `apps/desktop/src/bun/index.ts` | 메인 프로세스: 로딩 화면 → 백엔드 감독 → 앱 창, 메뉴, 종료 처리 |
| `apps/desktop/src/bun/backend.ts` | 백엔드 위치 탐색, 실행 명령·환경변수, READY 파싱, 시작/종료 감독 |
| `apps/desktop/src/bun/pages.ts` | 오류 화면(로그 꼬리, 재시작/로그 열기 버튼) |
| `apps/desktop/src/views/loading/index.html` | 로딩 화면 |
| `apps/api/neurobridge_api/desktop.py` | 데스크톱용 Python 진입점(`neurosignal-desktop`) |
| `scripts/desktop/build_python_runtime.sh` | 번들용 Python 런타임 빌드 |
| `scripts/desktop/build_app.sh` | 앱 빌드·서명·설치·DMG |
| `scripts/desktop/smoke_app.sh` | 빌드된 앱 스모크 테스트 |

## 1. 구조

```
Neurosignal Testbed.app
└─ bun 메인 프로세스 (src/bun/index.ts)
   ├─ 창(네이티브 WebKit): views://loading → http://127.0.0.1:<port>/
   └─ Bun.spawn ─▶ Contents/Resources/app/python-runtime/python/bin/python3.12
                    -I -u -m neurobridge_api.desktop
                    --data-dir <userData> --port 0 --parent-pid <bun pid> --ready-stdout
                    --web-dir Contents/Resources/app/web
                    └─ uvicorn (127.0.0.1, 임의 포트)
                       ├─ /api  → neurobridge_api.main:app (기존 FastAPI 그대로)
                       ├─ /     → 웹 빌드(apps/web/dist), 확장자 없는 경로는 index.html로
                       └─ 작업 워커(multiprocessing spawn)
```

- **같은 출처(same origin).** API와 웹 화면을 `http://127.0.0.1:<port>` 하나에서 제공합니다. 웹 클라이언트는
  기본 API 주소 `/api`를 그대로 쓰므로 앱 전용 코드가 없습니다. 호스트는 `127.0.0.1`만 허용되고
  (`--host` choices), 포트는 `--port 0`이라 실행할 때마다 운영체제가 빈 포트를 고릅니다.
- **READY 핸드셰이크.** `desktop.py`는 소켓을 먼저 바인딩한 뒤 서버가 연결을 받기 시작하면 stdout에
  다음 한 줄만 씁니다.

  ```
  NEUROSIGNAL_READY {"port": 51234, "pid": 4321, "version": "0.2.5"}
  ```

  그 뒤 stdout(fd 1)을 stderr로 돌리므로 stdout에는 다른 출력이 나오지 않습니다. 셸(`Backend.start`)은
  이 줄을 파싱하고 `/api/health`가 `{"status": "ready"}`를 돌려줄 때까지 100 ms 간격으로 확인한 뒤 창을
  `http://127.0.0.1:<port>/`로 엽니다. READY 줄이 120 s(`READY_TIMEOUT_MS`) 안에 오지 않거나, 백엔드가
  시작 중에 종료되거나, 상태 확인이 실패하면 오류 화면을 보여 줍니다. 오류 화면에는 로그 꼬리와 재시작 버튼이 있습니다.
- **환경변수.** 셸은 백엔드 환경을 처음부터 새로 만듭니다(`backendEnv()`). `PATH=/usr/bin:/bin:/usr/sbin:/sbin`
  으로 고정하고, 쓰기 위치는 모두 데이터 디렉터리로 보냅니다(`NEUROSIGNAL_BENCHMARK_ROOT`,
  `NEUROSIGNAL_PROJECTS_DIR`, `NUMBA_CACHE_DIR`, `MPLCONFIGDIR`, `TVB_USER_HOME`, `MNE_DATA`).
  Python은 `-I`(격리 모드)로 실행하므로 사용자 site-packages나 `PYTHONPATH`의 영향을 받지 않습니다.
- **종료.** 메뉴의 종료, Cmd+Q, 마지막 창 닫기는 모두 `before-quit`에서 백엔드부터 멈춘 뒤 앱을 끝냅니다.
  순서는 SIGTERM → 최대 12 s 대기(`STOP_GRACE_MS`) → SIGKILL입니다. 백엔드는 종료하면서 작업 워커를
  정리하고, 끝나지 않은 작업은 다음 실행 때 `interrupted`로 복구됩니다.
- **부모 감시(watchdog).** `--parent-pid`가 주어지면 백엔드는 1초마다 부모(bun) 프로세스를 확인합니다.
  부모가 사라지거나 프로세스가 재부모화되면 스스로 종료하고, 10 s 뒤에는 강제 종료합니다. 앱이 강제로
  죽어도 Python이 남지 않게 하려는 장치입니다.
- **탐색 제한.** 창은 실행 중인 백엔드 출처(`http://127.0.0.1:<port>/…`)만 열 수 있습니다. 그 밖의 `https`
  링크는 기본 브라우저로 열고 나머지는 버립니다(`navigationRules`, `externalUrl`).
- **메뉴.** `보기` 메뉴에 `다시 불러오기`, `분석 서버 재시작`, `실행 로그 열기`가 있습니다.

### 데이터 디렉터리

변경되는 상태는 앱 번들 안에 쓰지 않습니다. 모두 Electrobun의 `Utils.paths.userData`에 둡니다.

```
~/Library/Application Support/local.neurosignal.testbed/stable/   (릴리스 빌드)
~/Library/Application Support/local.neurosignal.testbed/dev/      (bun run dev)
├─ benchmarks/          작업 DB·결과물 (NEUROSIGNAL_BENCHMARK_ROOT)
├─ flow/                정보 흐름 실행 기록·결과
├─ cache/               numba, matplotlib 캐시
├─ uninstall            Electrobun이 만드는 제거 도구
└─ logs/
   ├─ backend.log       백엔드 stdout/stderr + [supervisor] 기록 (5 MB 넘으면 backend.log.1로 회전)
   └─ desktop.log       셸 이벤트 (시작, ready, 종료)
```

프로젝트·TVB·MNE 디렉터리(`projects/`, `tvb/`, `mne_data/`)도 이 디렉터리 아래에 만들어집니다.
앱을 지워도 데이터는 남습니다. 완전히 초기화하려면 앱을 종료한 뒤 이 디렉터리를 지웁니다.

## 2. 빌드

### 요구 사항

- Apple Silicon(arm64) macOS. 스크립트는 `uname -m`이 `arm64`가 아니면 멈춥니다.
- `bun` (개발 기준 1.4.4), `npm`/Node, `uv`. 셸 PATH에 없으면 `BUN_BIN`, `NPM_BIN`, `UV_BIN`으로 지정합니다.
- `codesign`, `ditto`, `PlistBuddy`, `hdiutil`(macOS 기본 도구).
- 네트워크: `uv python install`, 의존성 설치, `npm ci`, `bun install`이 패키지를 내려받습니다.

### 명령

저장소 루트에서 실행합니다.

```bash
scripts/desktop/build_app.sh               # = --build-only: apps/desktop/dist/"Neurosignal Testbed.app"
scripts/desktop/build_app.sh --run         # 빌드 후 실행
scripts/desktop/build_app.sh --install     # 빌드 후 /Volumes/Aquatope/Applications 에 설치
scripts/desktop/build_app.sh --dmg         # 빌드 후 apps/desktop/dist/"Neurosignal Testbed-<version>-arm64.dmg"
```

`cd apps/desktop && bun run build`는 `scripts/desktop/build_app.sh`(기본 `--build-only`)를 실행합니다.
설치 위치는 `NST_INSTALL_DIR`로 바꿀 수 있습니다.

### 파이프라인 (`build_app.sh`)

1. **웹.** `apps/web`에서 `npm ci && npm run build`를 실행해 `apps/web/dist`를 만듭니다.
2. **Python 런타임.** `scripts/desktop/build_python_runtime.sh`가 `apps/desktop/build/python-runtime`을 만듭니다.
   - `uv python install 3.12.11 --no-bin`으로 python-build-standalone CPython을 받습니다. 이 인터프리터는
     재배치할 수 있습니다. 버전은 `PY_VERSION`으로 바꿀 수 있지만 개발 `.venv`와 같게 유지합니다.
   - `uv export --frozen --no-dev --no-editable --no-emit-project --extra simulation --extra metrics --extra pac`로
     `uv.lock`의 실행 의존성을 내보내고, `uv build --wheel`로 프로젝트 휠을 만듭니다. 둘 다
     `uv pip install --link-mode=copy --compile-bytecode`로 설치합니다.
   - pip, idlelib, tkinter, test, ensurepip를 덜어 냅니다. 바이트코드는
     `compileall --invalidation-mode unchecked-hash`로 컴파일합니다. 서명된 번들 안의 `__pycache__`가 다시
     쓰이면 서명이 깨지기 때문입니다.
   - `neurobridge_api.desktop` 등을 import해 보고, 통과한 경우에만 기존 런타임을 바꿉니다. 같은 명령을 다시
     실행해도 결과가 같습니다.
3. **확인.** `build/python-runtime/python/bin/python3.12`나 `apps/web/dist/index.html`이 없으면 빌드를 멈춥니다.
4. **Electrobun.** `bun install --frozen-lockfile && bun x electrobun build --env=stable`을 실행합니다.
   Electrobun 2.0.6의 `build.copy`는 심볼릭 링크를 실제 파일로 바꾸고 mtime을 초기화합니다. 약 31k 개의
   런타임 파일을 이 경로로 보내면 외장 디스크에서 약 15분 걸리기 때문에, 이 단계 동안 런타임을
   `build/.python-runtime.held`로 잠시 옮겨 둡니다. 스크립트가 어떻게 끝나든 trap이 원래 위치로 되돌립니다.
5. **압축 해제.** stable 빌드 결과물은 자체 압축 해제 설치 파일입니다. 이 설치 파일의 볼륨 간 rename은
   외장 디스크에서 실패하므로, 안의 `.tar.zst`를 풀어 실제 `.app`을 꺼냅니다.
6. **런타임 넣기.** `ditto --clone`으로 런타임을 `Contents/Resources/app/python-runtime`에 복사합니다. 심볼릭
   링크, 권한, mtime이 보존됩니다. 이어서 python 실행 파일, `web/index.html`, 심볼릭 링크 수가 원본과 같은지,
   번들 python이 `env -i`에서 `neurobridge_api.desktop`을 import하는지 확인합니다.
7. **Info.plist.** `NSRemovableVolumesUsageDescription`을 넣습니다. `CFBundleShortVersionString`(= CFBundleVersion)과
   `LSMinimumSystemVersion 13.0`은 값이 없을 때만 넣습니다.
8. **서명.** `codesign --force --deep --sign -`로 ad-hoc 서명하고 `codesign --verify --deep --strict`로 확인합니다.
9. **교체.** 새 빌드를 `apps/desktop/dist/"Neurosignal Testbed.app"`으로 옮깁니다. 이전 빌드는
   `"Neurosignal Testbed.previous.<시각>.app"`으로 남습니다. 이전 빌드는 하나만 유지하고 더 오래된 것은 빌드 때 지웁니다.

단계별 로그는 `apps/desktop/build/{web,python-runtime,electrobun,signing}.log`에 남습니다.
`apps/desktop/build/`, `apps/desktop/dist/`, `node_modules/`, `.hutch/`는 `apps/desktop/.gitignore`로 제외됩니다.

### 설치 (`--install`)

1. `ditto --clone`으로 앱을 `/Volumes/Aquatope/Applications/.Neurosignal Testbed.next.app`에 복사하고 서명을 검증합니다.
2. 설치된 앱이 실행 중이면 설치를 멈춥니다. 먼저 앱을 종료합니다.
3. 기존 앱을 옆으로 옮기고, 새 앱을 `Neurosignal Testbed.app` 이름으로 바꾼 뒤 기존 앱을 지웁니다.

### 개발 모드

```bash
cd apps/web && npm run build          # 웹 빌드가 먼저 있어야 합니다
cd ../desktop && bun install
bun run dev                           # electrobun dev, 백엔드 = 저장소 .venv/bin/python
bun test                              # 감독 로직 단위 테스트
bun run typecheck
```

개발 모드에서는 `NEUROSIGNAL_PROJECT_ROOT`(`bun run dev`가 지정)나 상위 디렉터리를 찾아 저장소의
`.venv/bin/python`과 `apps/web/dist`를 씁니다. 데이터는 `…/local.neurosignal.testbed/dev`에 저장됩니다.
Python 쪽 데스크톱 진입점 테스트는 `tests/integration/test_desktop_serve.py`에 있습니다.

## 3. 스모크 테스트

```bash
scripts/desktop/smoke_app.sh "apps/desktop/dist/Neurosignal Testbed.app"
SMOKE_OPEN_IN_PLACE=1 scripts/desktop/smoke_app.sh "/Volumes/Aquatope/Applications/Neurosignal Testbed.app"
```

1. **번들.** python 런타임과 웹 화면이 있는지, 서명이 유효한지, 번들 ID가 맞는지 확인합니다.
2. **백엔드 단독.** 앱과 같은 방식으로 실행합니다. 작업 디렉터리는 `Resources/app`이고,
   `env -i HOME PATH=/usr/bin:/bin`, 임시 데이터 디렉터리를 씁니다. 확인 항목은 다음과 같습니다.
   - READY 줄과 `/api/health`
   - `/api/flow/concepts` 16개
   - `/`가 번들의 `index.html`과 바이트 단위로 같은지
   - `fixtures/recipes/flow-preview.json`으로 `/api/flow/runs` 작업 1건이 끝나는지
   - SIGTERM에 종료 코드 0으로 끝나는지, stdout에 READY 줄만 있는지, 남은 python이 없는지
3. **실제 앱.** `open -n`으로 실행하고 `<userData>/logs/backend.log`의 `[supervisor] ready` 줄에서 포트와 pid를
   찾습니다. 백엔드가 번들 python이고 앱의 자식인지 확인한 뒤 `/api/health`와 `/`를 확인합니다. 그다음
   AppleScript로 종료해 `backend exited code=0`인지, 남은 python이 없는지 봅니다.
4. **재검증.** 서명을 다시 확인합니다. 실행 중에 번들 안에 아무것도 쓰이지 않았는지 보기 위해서입니다.

앱이 외장 볼륨에 있으면 3단계는 내장 디스크(`$TMPDIR`)에 복사한 사본을 실행합니다. 이유는 4장의 외장 볼륨
권한 창 항목에 있습니다. `SMOKE_OPEN_IN_PLACE=1`을 주면 앱을 제자리에서 실행합니다. 이때는 권한 창에서
**허용**을 누를 사람이 화면 앞에 있어야 합니다. 대기 시간은 `SMOKE_READY_TIMEOUT`(기본 240 s)과
`SMOKE_RUN_TIMEOUT`(기본 600 s)으로 조정합니다. 통과하면 `SMOKE PASS`를 출력합니다.

### 측정값 (버전 0.2.5, /Volumes/Aquatope 외장 디스크)

| 항목 | 값 |
| --- | --- |
| 앱 크기 | 876 MB (Python 런타임 773 MB) |
| `build_app.sh --build-only` | 약 210 s (웹 18 s, 런타임 97 s, electrobun 22 s, 압축 해제·복사·확인 56 s, 서명 13 s, 검증 3 s) |
| 백엔드 READY (비어 있는 임시 데이터 디렉터리) | 약 4 s |
| 앱 첫 실행 → ready (비어 있는 데이터 디렉터리) | 28.6 s. 주로 matplotlib 글꼴 캐시를 만드는 시간 |
| 앱 두 번째 이후 실행 → ready | 8.2 s |
| `smoke_app.sh` 전체 | 7–18분. 대부분 외장 디스크의 복사와 서명 시간 |

디스크를 다른 작업과 함께 쓰면 런타임 빌드가 172–227 s, 서명이 10분 넘게 걸린 적도 있습니다.
외장 USB 디스크는 IOPS가 병목입니다. 외장 볼륨에서 GUI 앱을 처음 실행했을 때(권한 창 포함)의 시간은
측정하지 않았습니다.

## 4. 제약

- **arm64 전용.** Intel Mac과 유니버설 빌드는 지원하지 않습니다.
- **공증 없음, ad-hoc 서명.** Developer ID 서명과 공증(notarization)을 하지 않습니다. 이 Mac에서 직접
  빌드한 앱에는 격리(quarantine) 속성이 없어서 그대로 열립니다. 다른 Mac에서 DMG로 옮긴 앱은
  Gatekeeper가 막습니다. Finder에서 Control-클릭 → **열기**를 누릅니다. 최근 macOS에서는 **시스템 설정 →
  개인정보 보호 및 보안 → 그래도 열기**를 눌러야 할 수 있습니다.
- **외장 볼륨 권한 창.** 앱을 `/Volumes/Aquatope`에서 실행하면, 처음 실행할 때 macOS가 "외장 볼륨의 파일에
  접근" 권한을 묻습니다. bun 프로세스가 외장 디스크에 있는 `Resources/main.js`를 읽기 때문입니다.
  - ad-hoc 서명은 빌드마다 바뀌므로 **재설치할 때마다** 이 창이 다시 뜹니다.
  - **허용**을 누릅니다. 응답하기 전까지 앱이 멈춰 있고, 같은 외장 디스크를 쓰는 다른 프로세스의 접근도
    멈출 수 있습니다.
  - 그래서 사람이 없는 자동화에서는 설치된 앱을 `open`으로 열지 않습니다.
  - 권한을 되돌리려면 `tccutil reset SystemPolicyRemovableVolumes local.neurosignal.testbed`를 실행합니다.
- **용량.** 앱 하나가 약 876 MB입니다. `dist/`에는 직전 빌드(`*.previous.*.app`) 하나가 함께 남아 최대 약 1.8 GB를 씁니다.
- **첫 실행 지연.** 데이터 디렉터리가 비어 있으면 matplotlib 글꼴 캐시를 만드느라 첫 실행이 약 30초
  걸립니다. numba 커널은 처음 쓰는 시뮬레이션 작업에서 컴파일되어 `cache/numba`에 저장됩니다. 그 작업은
  처음 한 번 더 느립니다. 이 컴파일 시간은 따로 측정하지 않았습니다.
- **사용하지 않는 콘솔 스크립트.** 런타임의 `python/bin/*` 콘솔 스크립트(fastapi, f2py 등)는 shebang이 빌드
  당시 임시 경로를 가리킵니다. 앱은 `python3.12 -m …`만 쓰므로 영향이 없습니다.
- **외부 접속 없음.** 백엔드는 `127.0.0.1`에만 바인딩합니다. 원격 접속은 기존 웹 개발 서버 방식을 씁니다.
- **최소 창 크기 없음.** Electrobun 2.0.6에는 최소 창 크기 API가 없습니다.

## 5. 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| 오류 화면, 또는 "백엔드가 120초 안에 준비되지 않았습니다" | `보기 → 실행 로그 열기`, 또는 `~/Library/Application Support/local.neurosignal.testbed/stable/logs/backend.log`. 셸 이벤트는 `desktop.log` |
| 앱이 로딩 화면에서 멈추고 외장 디스크 접근도 멈춤 | 화면 어딘가에 외장 볼륨 권한 창이 떠 있는지 확인하고 **허용**을 누릅니다 |
| "확인되지 않은 개발자" | 4장의 Gatekeeper 항목(Control-클릭 → 열기 / 그래도 열기) |
| `--install`이 "is running; quit it first"로 실패 | 설치된 앱을 종료한 뒤 다시 실행합니다 |
| 빌드 실패 | 마지막 40줄이 터미널에 출력됩니다. 전체 로그는 `apps/desktop/build/*.log` |
| `bun not found` / `npm not found` / `uv not found` | `BUN_BIN`, `NPM_BIN`, `UV_BIN`으로 경로를 지정합니다 |
| 서명 검증 실패(실행 후) | 번들 안에 무언가가 쓰인 것입니다. 다시 빌드하고 `smoke_app.sh`로 확인합니다 |
