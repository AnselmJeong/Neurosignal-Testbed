# JR Benchmark 구현 현황 (2026-11-12)

기준 계획은 [`docs/plans/2026-11-12-resting-eeg-jr-benchmark.ko.md`](../plans/2026-11-12-resting-eeg-jr-benchmark.ko.md)이다. 이 문서는 2026-11-12 작업 트리의 미커밋 코드와 이 시점에 실제로 실행한 테스트 결과만 근거로 한다.

**P4까지 끝났다고 전체 요청이 완료된 것은 아니다(계획 §8.1).** 현재 구현된 범위는 P0–P4 수직 기능(Q1: 결합 × 관측 4조건, PLV·wPLI·wSMI)의 CLI·API 경로다. 29개 ID 중 계산 가능한 지표는 12개이고 Q2–Q7 preset은 `planned` 상태다. 7번째 웹 실험실(JR Benchmark)은 Lab 목록에 연결되어 Q1 실행·진행·결과를 보여준다. 다만 센서 행렬 표시와 export 다운로드는 아직 없다(§4).

## 1. 이번 확인에서 실행한 명령

```bash
uv run python -m pytest -q -m 'not slow' tests/unit/test_benchmark_contracts.py \
  tests/unit/test_metric_registry.py tests/unit/test_artifact_store.py tests/unit/test_job_manager.py \
  tests/oracle/test_jr_generator.py tests/oracle/test_jr_observation.py \
  tests/oracle/test_metric_connectivity.py tests/oracle/test_metric_wsmi.py \
  tests/integration/test_benchmark_core.py tests/integration/test_benchmark_api.py
```

- 결과는 154개 수집, 153 passed, 1 skipped다. skip은 `source_native × average` 조합으로, 이 조합이 ValueError를 내는지는 다른 테스트에서 확인한다.
- `-m slow`로 분리된 V03은 이번에 다시 실행하지 않았다. p2 단계에서 1회 통과했다(405 s).
- 독립 검증(2026-11-13) 결과: 전체 `pytest` 233개 통과·1개 skip(slow 포함, 실패 0), `ruff check` 통과, 웹 `npm test` 48/48, `typecheck`·`build` exit 0.

## 2. 단계별 현황 (P0–P9)

| 단계 | 상태 | 근거 (코드 · 테스트) | 남은 것 |
| --- | --- | --- | --- |
| P0 · 환경·계약 | 구현·검증 | optional group `simulation`/`metrics`/`pac`(`pyproject.toml`), 환경 기록 `docs/benchmarks/p0-environment.md`, 계약 `benchmarks/contracts.py`(`tests/unit/test_benchmark_contracts.py`), 29개 ID 레지스트리 `metrics/registry.py`(`tests/unit/test_metric_registry.py`) | IDTxl/JIDT(`information`)는 잠글 수 없어 `unsupported_dependency`로 남김 |
| P1 · 실행 기반 | 구현·검증 | `artifacts/store.py`(`tests/unit/test_artifact_store.py`), `jobs/manager.py`·`jobs/worker.py`(`tests/unit/test_job_manager.py`) | worker heartbeat가 없어 crash는 `recover()` 때 `interrupted`로만 드러남. 긴 JIDT 작업용 종료 가능 프로세스 없음 |
| P2 · JR 생성기 | 부분 | `simulation/tvb_jr.py`, V01–V05(`tests/oracle/test_jr_generator.py`, V03은 `slow`) | calibration seed 실행과 preset·evaluation seed 동결 미완. 시작값(G=10, 8 ms, ring k=2)은 검증되지 않음. G>0이면 PSD peak가 6.75→10.25 Hz로 이동하므로 §2.5 nuisance 대조가 필요 |
| P3 · 관측 모형 | 구현·검증 | `forward/geometry.py`·`forward/observation.py`(identity/schematic/eeg_forward, reference none/average, 절대 sensor noise), V06·V08(`tests/oracle/test_jr_observation.py`) | gain 1e-8 A·m/mV는 보정되지 않은 Q1 기본값이며 경고로 표시됨 |
| P4 · 핵심 비교 | 구현 (CLI·API) | `benchmarks/{presets,planner,tasks,runner,comparisons,evaluation}.py`, CLI `neurosignal-recipe benchmark`, API `apps/api/neurobridge_api/routes/benchmarks.py`. 테스트: `tests/integration/test_benchmark_core.py`(inline), `tests/integration/test_benchmark_api.py`(실제 spawn worker로 생성→취소→재개→완료→window→analyses→export) | 웹 실험실은 연결됨(§4). 센서 행렬 표시 없음. HTML 보고서 없음(JSON/CSV/recipe만). export 다운로드 route 없음. 30-seed `jr-core-comparison.json`(TVB만 약 70분 예상) 미실행 |
| P5 · 일반 지표 | 부분 | M11–M13, M15, M16, M18–M20, M22 어댑터 구현(`metrics/connectivity.py`, `metrics/information.py`). V12·V13·V20(`tests/oracle/test_metric_connectivity.py`), V14 SMI/wSMI 부분(`tests/oracle/test_metric_wsmi.py`) | M01–M06, M21, M24–M26, M30–M33 미구현. V10, V11, V15, V19 미착수 |
| P6 · 방향성·PAC | 미착수 | — | M27–M29. M28은 의존성 미설치. V16, V17 |
| P7 · 품질·견고성 | 미착수 | — | QC/eligibility, artifact stress, V29–V33 |
| P8 · 웹·실데이터 | 부분 (웹) / 미착수 (실데이터) | 7번째 Lab 연결, `features/benchmarks/*.test.tsx` (§4) | 센서 행렬 API·표시, seed→trace/PSD 이동, export 다운로드, real-data 구간 선택, V27·V34·V36 |
| P9 · 반복·출시 | 미착수 | — | 30 seed 이상 본 분석, sensitivity, lock·보고서, 전체 V 추적 |

## 3. 검증 항목 (V01–V36)

| ID | 상태 | 근거 |
| --- | --- | --- |
| V01 | 구현·테스트 | `tests/oracle/test_jr_generator.py::test_v01_single_node_baseline_is_finite_and_reports_psd_peak`. PSD peak 보고만 하고 문헌 대조는 하지 않음 |
| V02 | 구현·테스트 | `test_jr_generator.py::test_v02_deterministic_dt_halving_converges` |
| V03 | 구현·테스트 (slow) | `test_jr_generator.py::test_v03_stochastic_dt_halving_converges_in_distribution`. 분포 수렴만 확인(matched Brownian 아님) |
| V04 | 구현·테스트 | `test_jr_generator.py::test_v04_*` (2개) |
| V05 | 구현·테스트 | `test_jr_generator.py::test_v05_*` (2개) |
| V06 | 구현·테스트 | `tests/oracle/test_jr_observation.py::test_v06_*`, `tests/integration/test_benchmark_core.py::test_source_checksum_identical_across_observations` |
| V07 | 구현·테스트 | `test_benchmark_core.py::test_rerun_other_metric_reuses_signals`(simulate를 막아도 M11 재분석 성공). API analyses도 확인 |
| V08 | 구현·테스트 | `test_jr_observation.py::test_v08_*` (4개) |
| V09 | 구현·테스트 | `test_benchmark_core.py::test_truth_isolation` |
| V10 | 미착수 | M01–M03 미구현 |
| V11 | 미착수 | M04–M06 미구현 |
| V12 | 구현·테스트 | `tests/oracle/test_metric_connectivity.py::test_v12_*` |
| V13 | 구현·테스트 | `test_metric_connectivity.py::test_v13_*` |
| V14 | 부분 | SMI·wSMI는 `tests/oracle/test_metric_wsmi.py::test_v14_*`에서 확인. MI(M21) 미구현 |
| V15 | 미착수 | M24–M26 미구현 |
| V16 | 미착수 | M27·M28 미구현 |
| V17 | 미착수 | M29 미구현 |
| V18 | 미착수 | resting 구간 선택·annotation 처리 없음 |
| V19 | 미착수 | M30–M33 미구현 |
| V20 | 구현·테스트 | `test_metric_connectivity.py::test_v20_*` |
| V21 | 구현·테스트 | `test_benchmark_core.py::test_seed_paired_comparisons`(`independent_n == n_seeds`, seed bootstrap CI) |
| V22 | 부분 | p=(b+1)/(B+1), 해상도를 `null_family`에 표기(예: `seed_sign_flip_exact(B=7)`), source edge FWER. sensor band 요약은 `uncorrected`로 표기. null 오검출률의 binomial 불확실성 확인 없음 |
| V23 | 구현·테스트 | `tests/unit/test_job_manager.py::test_restart_recovery_marks_interrupted_never_completed`, `tests/unit/test_artifact_store.py::test_checksum_mismatch_refuses_reuse`, `test_benchmark_core.py::test_interrupted_run_resumes_with_reuse`, `tests/integration/test_benchmark_api.py::test_restart_marks_running_job_interrupted` |
| V24 | 부분 | 취소·부분 실패: `test_job_manager.py::test_cancel_*`, `test_partial_failure_*`. 미설치 backend 상태: `test_metric_registry.py::test_capabilities_reports_core_present_and_unknown_module_missing`. worker crash 감지(heartbeat) 없음 |
| V25 | 부분 | 실험 간 격리와 위험 경로·ID 거부: `test_artifact_store.py::test_experiments_are_isolated`, `test_traversal_and_unsafe_ids_rejected`, `test_benchmark_api.py::test_unsafe_and_unknown_ids`. 미등록 metric(M99) → 422: `test_validate_rejects_bad_specs`. real-data 프로젝트 단위 연결·격리 없음 |
| V26 | 미착수 | 웹 A/B atomic update 미구현 |
| V27 | 미착수 | 32채널 trace UI 미구현 |
| V28 | 구현·검증 | 독립 검증에서 전체 pytest 233개 통과(기준선 79개 모두 유지)와 웹 테스트 48/48·typecheck·build 통과를 확인했다. 기존 수업 UI는 수동 회귀 확인 대상으로 남아 있다 |
| V29–V33 | 미착수 | P7 범위 |
| V34 | 미착수 | real-data 연결 없음 |
| V35 | 해당 없음 | source reconstruction 미사용(선택 기능) |
| V36 | 미착수 | 해석 문장을 담는 보고서 없음 |

## 4. 웹 실험실 (부분 구현)

`apps/web/src/features/benchmarks/`의 `BenchmarkWorkbench.tsx`가 `App.tsx`·`LabNavigator.tsx`에 7번째 Lab으로 연결되어 있다. 웹 검증 결과는 `npm test` 13개 파일·48개 테스트 통과, `npm run typecheck`·`npm run build` 모두 exit 0이다.

구현된 것:

- Q1 설계(회로·관측·지표), 서버 validate와 비용 표시. 검증을 통과한 설정에서만 실행할 수 있다.
- 실제 job polling, 취소·재개. 실패하거나 취소하면 이전 결과를 유지한다. 다시 열면 결과를 복원한다.
- A–D 조건 grid(대역별 요약값), source 행렬(off/on/on−off), seed-paired 효과와 CI, 결합에 동반된 스펙트럼 변화.
- 지표마다 고정된 색 범위를 쓰고, 부호 있는 지표는 발산형 색으로 표시한다. 값은 clipping하지 않는다. 29개 ID catalog를 함께 제공한다.

남은 것:

- 센서 channel×channel 행렬 표시. 3-D 결과를 내려주는 API route가 없다.
- seed 클릭 → trace/PSD 이동.
- export 다운로드 버튼과 route.
- 연결 행렬 직접 편집. 지금은 ring lattice만 지원한다.

## 5. 29개 metric ID 상태

아래 표는 adapter 모듈을 import한 뒤 `registry.capabilities()`를 실제로 실행한 출력이다(2026-11-12).

```python
import neurobridge.metrics.connectivity, neurobridge.metrics.information
from neurobridge.metrics import registry
registry.capabilities()   # len == 29
```

API `GET /benchmarks/capabilities`는 이 adapter들을 import한 같은 레지스트리를 반환한다.

| ID | 이름 | 계열 | status | variants | dependency group | 의존성 |
| --- | --- | --- | --- | --- | --- | --- |
| M01 | PSD | spectral | planned | — | core | 있음 |
| M02 | Absolute band power | spectral | planned | — | core | 있음 |
| M03 | Relative band power | spectral | planned | — | core | 있음 |
| M04 | Spectral peak | spectral | planned | — | core | 있음 |
| M05 | Aperiodic exponent | spectral | planned | — | core | 있음 |
| M06 | Aperiodic offset | spectral | planned | — | core | 있음 |
| M11 | Pearson correlation | correlation | implemented | default | core | 있음 |
| M12 | Coherence | phase | implemented | default | core | 있음 |
| M13 | Imaginary coherency | phase | implemented | default | core | 있음 |
| M14 | PLV | phase | implemented | default | core | 있음 |
| M15 | PPC | phase | implemented | default | core | 있음 |
| M16 | PLI | phase | implemented | default | core | 있음 |
| M17 | wPLI | phase | implemented | default | core | 있음 |
| M18 | Debiased squared wPLI | phase | implemented | default | core | 있음 |
| M19 | AEC | amplitude | implemented | default | core | 있음 |
| M20 | Orthogonalized AEC | amplitude | implemented | default | core | 있음 |
| M21 | Continuous mutual information | information | planned | — | information | **없음** (idtxl, jpype) |
| M22 | SMI | information | implemented | default | core | 있음 |
| M23 | wSMI | information | implemented | default | core | 있음 |
| M24 | Permutation entropy | complexity | planned | — | metrics | 있음 |
| M25 | Sample entropy | complexity | planned | — | metrics | 있음 |
| M26 | Lempel-Ziv complexity | complexity | planned | — | metrics | 있음 |
| M27 | Granger causality | directed | planned | — | core | 있음 |
| M28 | Transfer entropy | directed | planned | — | information | **없음** (idtxl, jpype) |
| M29 | PAC (Tort modulation index) | cross_frequency | planned | — | pac | 있음 |
| M30 | Clustering coefficient | graph | planned | — | metrics | 있음 |
| M31 | Modularity | graph | planned | — | metrics | 있음 |
| M32 | Global efficiency | graph | planned | — | metrics | 있음 |
| M33 | Characteristic path length | graph | planned | — | metrics | 있음 |

- 합계: implemented 12개(M11–M20, M22, M23), planned 17개.
- planned 중 M21과 M28은 의존성 자체가 설치되어 있지 않다.
- Q1 benchmark 실행에 쓰는 지표는 M14·M17·M23뿐이다. 나머지 implemented 지표는 `POST /benchmarks/experiments/{id}/analyses`로 같은 신호에 다시 실행할 수 있다.

## 6. 남은 작업 (P5–P9와 P4 잔여)

- **P4 잔여**
  - 웹 Lab에 센서 행렬 API·표시, seed→trace/PSD 이동, export 다운로드를 추가한다. 서버 재시작 시 살아 있는 worker를 판별하도록 recover()를 개선한다.
  - HTML 보고서와 export 다운로드 route를 만든다.
  - `jr-core-comparison.json` 본 실행(30 seed)을 한다.
- **P2 잔여**: calibration seed를 실행하고 preset·evaluation seed를 동결한다. 관측 gain도 보정한다.
- **P5**
  - 미구현 지표: M01–M06(Welch/multitaper, specparam), M24–M26(AntroPy), M30–M33(bctpy), M21(IDTxl 경로 결정 필요).
  - 검증: V10, V11, V15, V19, V14의 MI 부분.
- **P6**: M27(state-space GC), M28(TE, 의존성 문제), M29(Tensorpac)를 구현하고 V16·V17을 통과시킨다. 이후 full-metrics profile을 실행한다.
- **P7**: RecordingQC/SegmentQC, eligibility, artifact stress(clean/corrupted/processed), 길이·구간·nuisance 대조(V29–V33).
- **P8**: real-data resting 구간 선택, 질문별 preset UI(Q2–Q7), 해석 문장 보고서(V26, V27, V34, V36).
- **P9**: 30 seed 이상 본 분석, sensitivity profile, 잠금 환경·문서·보고서, V01–V34·V36 전체 추적을 완료한다.
- **기반 보완**
  - worker liveness를 확인한다. 현재는 이전 서버의 worker가 살아 있어도 `recover()`가 `interrupted`로 표시한다.
  - non-ok metric 셀 때문에 job 전체가 `failed`로 끝나는 현재 표기를 정리한다.
