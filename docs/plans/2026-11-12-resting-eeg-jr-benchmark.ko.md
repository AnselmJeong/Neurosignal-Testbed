# Neurosignal Testbed의 resting-state EEG 시뮬레이션과 지표 분석 구현 계획

_2026-11-12 · TVB, MNE-Python, MNE-Connectivity 기반 · resting-state EEG 전용 · ClaudeEEG 참고 반영 · 구현 전 계획_

---

## 📋 1. 목표와 기존 코드에서 확인한 출발점

목표는 **알려진 신경집단 네트워크 → 가상 resting EEG → 분석 → 조건 비교**를 하나의 재현 가능한 실험으로 만드는 것이다. 32채널 EEG를 생성하고, 집단 간 연결·관측 혼합·기준전극·잡음을 독립적으로 조작한다. 단순히 많은 숫자를 계산하는 대신, 어떤 지표가 어떤 resting EEG 특성을 구별하고 어떤 교란에 취약한지 판단할 수 있는 도구로 만든다.

범위는 오프라인 resting-state EEG다. MEG, BCI, 자극·ERP, 행동 반응, 분류·딥러닝·실시간 장비 연동은 이번 기능에서 제외한다. 앞선 목록의 자극 관련 M07–M10과 M34는 범위에서 제거하고, 나머지 29개 ID를 유지한다. 번호의 공백은 기존 논의와의 추적을 위한 것이며 구현 누락이 아니다.

기존 Connectivity 수업은 보존하고, 별도 `JR Benchmark` 실험실을 추가한다. 공통 계산·저장 계층을 먼저 구축한 후 기존 수업과 실제 EEG 분석에 점진적으로 재사용한다. 기존 수업을 한 번에 새 엔진으로 바꾸는 전면 교체는 하지 않는다.

### 1.1 현재 상태

저장소: `/Volumes/Aquatope/_DEV_/Neural_Signal_Analysis/Neurosignal-Testbed`.
검토한 HEAD: `4ce22959d0538a36f655926b808fac6ea78b3cde`. 기존 미추적 `docs/` 자료는 보존한다.

| 영역 | 소스에서 확인한 구현 | 이번 확장 방향 |
| --- | --- | --- |
| 실행 구조 | Python scientific core + FastAPI + React/TypeScript/Vite | 기존 구조 유지 |
| 연결성 생성기 | 4개 사인파 신호원, 8개 센서, 공유 위상 성분 | TVB 기반 실제 동적 결합 생성기 추가 |
| 연결성 분석 | Pearson, coherence, imcoh, PLV, PPC, PLI, wPLI | 공통 metric registry와 새 어댑터 추가 |
| 결과 처리 | 연결성 엔진에서 절댓값·0–1 clipping 사용 | 새 엔진은 원값·부호·정의역 보존 |
| 소스 모델링 | 14채널 구형 머리 모델, forward/inverse | geometry 생성 로직을 매개변수화해 재사용 |
| QEEG | 19/32채널 forward geometry, PSD·대역 파워·스펙트럼 엔트로피 등 | 32전극 목록·좌표와 검증 패턴 재사용 |
| 실데이터 | 원본 보존, FIF working copy, derivative·JSON·HTML 저장 | artifact 저장 패턴을 공통화 |
| 화면 | 생성→관찰→추정→A/B 비교, 실패 시 이전 결과 유지 | 다조건·반복 실험으로 확장 |
| API | 분석별 동기 호출, 일부 결과는 메모리 사전 | 지속 가능한 background job 추가 |
| registry | capability manifest에 모듈을 나열 | 실행 가능한 분석 어댑터 registry를 추가 |

현재 로컬 환경에서 확인한 버전은 Python 3.12.11, MNE 1.12.1, MNE-Connectivity 0.8.1, specparam 2.0.0rc7이다. 설치된 `mne_connectivity.wsmi()`의 존재와 시그니처도 확인했다. TVB, AntroPy, Tensorpac, IDTxl, bctpy는 현재 설치되어 있지 않다. 이는 의존성·API 확인이며 새 파이프라인의 수치 검증 결과는 아니다.

`pyproject.toml`의 현재 `mne-connectivity>=0.8,<0.9` 범위 안에서도 wSMI를 사용할 수 있다. 새 stable 버전으로 일괄 갱신하기보다, 먼저 현 환경과 추가 패키지의 호환성을 별도 환경에서 검증하고 승인된 버전 조합을 잠근다.[^1]

### 1.2 성공 기준과 범위

- JR의 연결 행렬과 관측 행렬을 독립적으로 바꾸고, 같은 원신호를 여러 관측 조건에 재사용한다.
- 32개 신호원과 32개 EEG 전극을 기본값으로 사용하되 개수를 별도 필드로 관리한다.
- 아래 29개 metric ID를 모두 등록하고, 계산 가능한 데이터에서는 실제 결과를 생성한다.
- 순수 resting 시뮬레이션, artifact stress test, 알려진 수식의 알고리즘 검증 fixture를 구분한다.
- seed 반복, 불확실성, 수치 수렴, null 대조, backend 일치 검증을 제공한다.
- 서버 재시작·작업 취소·부분 실패 후 완료된 artifact와 진행 상태를 복원한다.
- 기준 결과를 얻기 전에 지표가 좋아 보이도록 매개변수나 표시 예제를 선택하지 않는다.

### 1.3 분석 질문과 결과를 먼저 정한다

아래 질문을 기본 preset과 보고서의 첫 화면으로 삼는다. 각 preset은 조작하는 요인, 고정하는 요인, primary metric·contrast, null, 필요한 데이터 길이를 명시한다. 분석 후 가장 유리한 지표·채널·시간창만 선택하지 않는다.

| 질문 | 주요 지표 | 결과로 답할 내용 |
| --- | --- | --- |
| Q1 · 실제 결합을 바꾸면 무엇이 달라지는가? | PLV·wPLI·wSMI, PSD 보조 | 원신호와 센서의 결합 효과·CI |
| Q2 · 결합 없이 혼합·reference만 바꿔도 연결이 생기는가? | Pearson·coh·PLV·wPLI·AEC·wSMI | 공통장·공통 참조에 대한 민감도 |
| Q3 · 진동 세기·주파수·배경이 바뀐 효과를 결합과 구별하는가? | PSD·peak·aperiodic + 연결성 | 결합 고정 시 nuisance 반응 |
| Q4 · 시간 패턴의 다양성과 집단 간 의존성은 함께 변하는가? | PE·SampEn·LZ, MI·wSMI | local complexity와 sharing의 분리 |
| Q5 · 기록 길이·구간·seed가 바뀌어도 결과를 믿을 수 있는가? | 모든 적합 지표 | 편향·분산·순위·그래프의 안정성 |
| Q6 · artifact 제거가 오염을 줄이며 신경 신호도 보존하는가? | 파워·복잡도·연결성 변화 | 제거 효과와 신호 왜곡의 동시 평가 |
| Q7 · 방향성·PAC가 알려진 대조에서 구별되는가? | GC·TE·PAC | 방향·common input·고조파 대조 결과 |

한 실행에서 모두 유의해야 하는 것은 아니다. 최종 산출물은 metric별 **용도·데이터 요구량·교란 민감도·불확실성·실패 조건**을 제시하는 비교 카드다. 특정 지표의 일괄 우승이나 정상/비정상 판정을 목표로 하지 않는다.

## 🧠 2. 생성 모형과 실험 조건

### 2.1 동역학과 관측을 분리한다

TVB `JansenRit`로 각 집단의 상태를 적분하고, 피라미드세포의 순 시냅스후전위에 해당하는 `v_i = y1_i - y2_i`를 출력한다. 집단 간 연결은 정규화 규칙을 고정한 `C`, 전역 결합 강도 `G`, 전달 지연 `D`로 표현한다. 단일 집단 내부의 흥분·억제 연결과 집단 사이의 연결을 서로 다른 설정으로 노출한다.[^2]

관측은 다음 계약으로 분리한다.

```text
TVB state → v(t) [mV]
q(t) = gain × (v(t) − fixed baseline) [A·m]
unreferenced(t) = L × q(t) + sensor_noise(t) [V]
recording(t) = R × unreferenced(t) [V]
```

JR 전위에서 등가 전류쌍극자로 가는 `gain`은 모형의 관측 가정이다. 전위를 그대로 MNE의 dipole amplitude로 전달하지 않는다. gain·baseline·방향·좌표계·단위 변환을 artifact에 저장하고, 독립 calibration에서 결정한 값을 조건 전체에 유지한다. 조건별 z-score나 RMS 정규화로 연결에 따른 진폭 변화를 지우지 않는다. MNE 내부 EEG 단위는 V, 쌍극자 단위는 A·m로 맞춘다.[^3]

`C`, `D`, `L`, `R`와 잡음 공분산은 각각 별도 artifact로 저장한다. 행렬 방향은 외부 계약에서 `C[target, source]`로 고정하고 TVB 어댑터에서 변환한다. source 0→1의 impulse test로 방향을 검증한다.

### 2.2 관측 조건

| 관측 모드 | 의미 | 화면 표기 |
| --- | --- | --- |
| `source_native` | JR 전위 또는 등가 dipole을 직접 분석 | 원래 신호원; EEG 센서로 부르지 않음 |
| `identity_probe` | 신호원별 독립 가상 관측, 대각 전달 행렬 | 혼합 없는 가상 채널; 실제 두피 EEG 아님 |
| `schematic_mixed` | 알려진 비대각 혼합 행렬 | 수학적 혼합 대조 |
| `eeg_forward` | MNE 구형 머리 모델과 32전극 리드필드 | 물리적 forward 모형의 가상 EEG |

독립 가상 채널을 V로 표현할 때도 고정된 가상 probe gain을 기록한다. 실제 전극 위치가 없는 identity 채널에 두피 지도를 그리지 않는다. 서로 단위가 다른 source와 sensor의 절대 파워를 직접 빼지 않는다.

기준전극은 관측 혼합과 독립적인 요인이다. identity 조건에 average reference를 적용해도 공유 성분이 생길 수 있으므로 이를 별도 조건으로 둔다. `none`은 forward 계산 기준을 유지한다는 뜻이며 물리적으로 기준이 없다는 뜻으로 표시하지 않는다.

### 2.3 핵심 조건과 확장 조건

먼저 다음 2×2 비교를 완성한다. 원래 신호원 분석은 모든 실행에 함께 보존한다.

| 조건 | 집단 간 연결 | 관측 | 주된 질문 |
| --- | --- | --- | --- |
| A | 없음 | identity probe | 독립 동역학의 기준 분포는? |
| B | 있음 | identity probe | 결합의 효과가 원신호에 나타나는가? |
| C | 없음 | EEG forward | 혼합만으로 어떤 의존성이 생기는가? |
| D | 있음 | EEG forward | 결합 효과가 전극에서도 구별되는가? |

이후 schematic 혼합, reference, 잡음, 결합 강도·지연, 집단 간 이질성을 추가한다. 기본 그래프는 단일 방향 edge, 양방향 pair, chain, modular network 순서로 확장한다. 공통 입력만 공유하는 fork와 간접 경로만 있는 chain을 넣어 통계적 의존성과 직접 연결을 구분한다.

독립 조건은 `G=0`뿐 아니라 집단별 독립 확률 입력과 초기조건을 사용한다. 동일 주파수의 결정론적 진동은 결합 없이도 일정한 위상 차이를 유지할 수 있으므로, 무결합에서 PLV=0을 필수 판정으로 사용하지 않는다.

집단 간 입력 잡음은 독립으로 생성하되, 연결 조건 A/B를 비교할 때는 같은 node별 확률 입력 realization을 재사용한다. seed 계층은 초기상태·입력·센서잡음·artifact·surrogate·bootstrap으로 분리하고 worker 실행 순서에 영향받지 않게 한다.

### 2.4 프로토콜과 제안 시작값

다음은 구현 시작값이며 검증된 최종 생리학 매개변수가 아니다. calibration seed에서 안정성·PSD·발화 범위를 확인한 뒤 evaluation seed를 고정한다.

| 항목 | 제안 시작값 또는 규칙 |
| --- | --- |
| 신호원 / EEG 전극 | 32 / 32; 서로 독립적인 설정 |
| 전극 목록 | 기존 QEEG의 32전극 목록·`standard_1020` 좌표를 검증 후 공유 |
| 머리 모델 | 기존 구형 모델을 일반화; 개인 해부학 모형으로 표기하지 않음 |
| 신호원 위치·방향 | 두개 내부 32개 좌표와 고정 방향; 좌표·방향·head frame 검사 |
| 출력 샘플링 | 256 Hz |
| 적분 간격 | 0.1220703125 ms를 후보로 검증 |
| 중간 출력 | 1024 Hz; anti-aliasing 후 256 Hz로 변환 |
| 안정 상태 본 분석 | burn-in 10초 이후 120초 |
| 기본 epoch | 8초, 비중첩; 120초에서 15개 |
| 빠른 미리보기 | 32초와 소수 seed; 본 분석과 구분 |
| 스펙트럼 대역 | delta 1–4, theta 4–8, alpha 8–13, beta 13–30, gamma 30–45 Hz |
| 반복 | calibration과 분리한 30개 evaluation seed를 시작점으로 사용 |
| surrogate | preview 49, 본 분석 999 후보; 검정 해상도와 계산량을 표시 |

TVB는 적분 간격과 monitor 주기를 ms 단위로 사용하므로 정수 배수 관계를 검증한다. 중간 출력도 그 이전 Nyquist 이상 성분의 aliasing을 검사하며, 필요하면 monitor 주파수를 높여 같은 저역통과 결과로 수렴하는지 확인한다. 단순히 매 N번째 표본을 취하지 않는다.[^4]

세 가지 실행 목적을 제공한다. 모두 자극·이벤트 평균을 사용하지 않는다.

1. `resting_clean`: 외부 과제 없는 연속 JR 활동과 선언된 측정 잡음. 기본 결합·혼합 비교에 사용한다.
2. `resting_artifact_stress`: 같은 clean 신호에 알려진 artifact를 더해 오염·전처리 효과를 확인한다. artifact를 정답 연결로 취급하지 않는다.
3. `validation_controls`: 알려진 VAR, 독립 noise, ordinal pattern, PAC 신호 등 알고리즘 검증 전용 fixture. JR 출력과 다른 생성기임을 기록한다.

epoch는 연속 resting 기록을 분석용 고정 길이 구간으로 나눈 것이다. trial이나 자극 조건으로 부르지 않는다. 실제 데이터에서는 eyes-open/eyes-closed, 경과 시간, 졸림 관련 관찰, 복용·기록 환경 같은 제공된 상태 metadata를 보존하되 이를 자동 진단 label로 바꾸지 않는다.

한 개의 alpha-dominant JR 설정만으로 모든 대역과 PAC 양성 대조가 확보된다고 가정하지 않는다. 대역 파워는 계산할 수 있어도 해당 대역의 진동 존재는 별도로 확인한다. multi-timescale JR은 기본 파이프라인 검증 뒤 별도 preset으로 추가한다.

### 2.5 결합과 무관한 변화도 대조한다

순수 결합 on/off 실험 이후에는 `G`를 고정한 상태에서 관측 gain, 독립 입력의 크기·색, sensor SNR, 중심 주파수의 이질성, recording drift, burstiness를 바꾼다. 기준 조합에만 잘 맞는 지표를 고르지 않고 nuisance가 달라질 때 결합 contrast가 얼마나 유지되는지 기록한다.

신호 파워·스펙트럼 차이가 큰 조건에서 연결성 차이를 오직 결합 변화로 설명하지 않는다. 각 contrast 옆에 실제 파워·peak·SNR·잔존 길이 변화를 붙인다. 파워를 맞춘 보조 대조가 필요하면 독립 calibration에서 정의하고 primary 원신호 결과와 따로 보존한다.

## 📊 3. 전체 지표 목록과 계산 계약

29개 ID는 기능 추적을 위한 단위다. 대역별·채널별·주파수별 결과 수를 29개로 제한한다는 뜻은 아니다. 모든 지표는 source와 관측 데이터에서 적합성을 판정하고, 같은 ID라도 적용한 전처리와 집계 방식이 다르면 별도 variant로 저장한다.

### 3.1 스펙트럼

| ID | 지표 | 구현 후보 | 출력·필수 조건 |
| --- | --- | --- | --- |
| M01 | PSD | MNE Welch·multitaper | 채널×주파수; 창·taper·density 단위 |
| M02 | 절대 대역 파워 | PSD의 수치 적분 | 채널×대역; 경계·단위 명시 |
| M03 | 상대 대역 파워 | 대역 파워 / 고정 전체 범위 파워 | 분모 범위와 0분모 처리 |
| M04 | 스펙트럼 정점 | specparam + 명시적 peak 기준 | 중심 주파수·높이·폭; 정점 없음은 null |
| M05 | 비주기 지수 | 기존 specparam 어댑터 | fit 범위·모드·잔차·적합도 |
| M06 | 비주기 오프셋 | 같은 fit | 로그·입력 단위 명시 |

specparam은 현재 프로젝트의 2.0.0rc7 경로를 우선 감싼다. aperiodic 성분을 분리하고 peak와 fit 품질을 함께 저장하며, exponent를 흥분/억제 균형의 직접 측정으로 표시하지 않는다.[^5] peak 미검출·낮은 적합도를 질환 판정으로 해석하지 않는다.

### 3.2 상관·위상·진폭 연결성

| ID | 지표 | 구현 후보 | 원값·형태 |
| --- | --- | --- | --- |
| M11 | Pearson correlation | NumPy/SciPy | 부호 있는 대칭 행렬 |
| M12 | Coherence | MNE-Connectivity `coh` | coherency 크기; 제곱 coherence와 구분 |
| M13 | Imaginary coherency | `imcoh` | 부호·채널 순서 보존; magnitude variant 분리 |
| M14 | PLV | `plv` | 주파수별 위상 관계 |
| M15 | PPC | `ppc` | squared PLV의 편향 보정 추정량 |
| M16 | PLI | `pli` | 위상 지연 지표 |
| M17 | wPLI | `wpli` | 일반 wPLI |
| M18 | Debiased squared wPLI | `wpli2_debiased` | 제곱 지표; 음수 추정값도 보존 |
| M19 | AEC | `envelope_correlation`, orthogonalize=False | band-limited 진폭 포락선의 부호 있는 상관 |
| M20 | Orthogonalized AEC | 같은 API, pairwise | M19와 다른 측정량으로 저장 |

MNE-Connectivity의 epoch 기반 추정은 여러 epoch를 가로질러 계산한다. epoch 내부에서 시간 평균하는 추정과 구분한다. 초기 기본은 `spectral_connectivity_epochs()`로 고정하고, 시간 내 추정은 별도 variant와 검증을 거쳐 제공한다.[^6] AEC는 앞서 대역 제한한 신호를 사용하고, orthogonalization·절댓값·log-power 여부를 모두 명시한다.[^7]

M13의 imaginary coherency는 채널 순서를 뒤집으면 부호가 달라질 수 있다. 보편적인 대칭화 함수를 적용하지 않는다. M15·M18의 음수를 절댓값으로 바꾸거나 성공한 0으로 clipping하지 않는다.

### 3.3 정보량·복잡도·방향성·교차주파수

| ID | 지표 | 구현 후보 | 필수 설정 |
| --- | --- | --- | --- |
| M21 | 연속 MI | IDTxl/JIDT Kraskov MI 어댑터 | 동시점 정의·kNN·Theiler exclusion·단위 |
| M22 | SMI | MNE-Connectivity `wsmi(weighted=False)` | kernel·tau·동률 처리·정규화 |
| M23 | wSMI | `wsmi(weighted=True)` | 기호 가중치·anti-aliasing·epoch 집계 |
| M24 | Permutation entropy | AntroPy | order·delay·정규화·동률 처리 |
| M25 | Sample entropy | AntroPy | embedding 차수·거리·허용오차 |
| M26 | Lempel–Ziv complexity | AntroPy | 이진화·알파벳·길이 정규화 |
| M27 | Granger causality | MNE-Connectivity state-space GC | 방향·lag·rank·VAR 진단 |
| M28 | Transfer entropy | IDTxl/JIDT | embedding·lag·추정기·조건부 변수 |
| M29 | PAC | Tensorpac | phase/amplitude 대역·방법·surrogate |

wSMI의 `tau`는 표본 수다. 256 Hz에서 kernel=3, tau=2/4/8은 각각 약 7.8/15.6/31.3 ms이며, 내장 저역통과 cutoff는 약 42.7/21.3/10.7 Hz가 된다. 이를 gamma/beta/alpha 대역과 동일하다고 부르지 않는다. 처음에는 이 세 척도를 사전 지정하고, 전처리 변형을 별도 비교한다.[^1]

AntroPy는 permutation/sample entropy와 Lempel–Ziv 구현을 제공한다.[^8] Sample entropy에 matching pattern이 없어 유한한 값이 나오지 않는 경우 이유를 반환한다. LZ 정규화 값이 유한 표본에서 항상 0–1에 있다고 가정하지 않는다. 독립 noise에서 높은 복잡도가 나오는 것은 뇌의 기능적 우수성을 뜻하지 않는다.

MI는 동시점 연속 MI를 기본으로 한다. IDTxl의 lag 선택을 포함한 네트워크 MI와 혼동하지 않고 직접 MI estimator를 감싼다. Kraskov 계열의 nats와 다른 estimator의 bits를 구분한다. TE는 pairwise와 conditional/network inference를 별도 ID variant로 저장한다. JIDT의 Java·JPype 의존성은 전용 worker에서 검사하고 버전·jar hash를 기록한다.[^9]

GC는 32채널 전체를 한꺼번에 적합하는 방식만 제공하지 않는다. 먼저 지정 source→target pair를 분석하고, multivariate set을 사용할 때는 rank·표본 수·lag·조건부 범위를 명시한다. pairwise GC·TE는 관측하지 않은 공통 원인을 자동으로 제거하지 않는다. time-reversed GC는 추가 진단으로 두며 원래 결과와 분리한다.[^6]

PAC는 한 채널 내 분석부터 시작하고 지정 채널 간 분석을 추가한다. primary estimator는 Tort modulation index로 고정하고 다른 방법은 variant로 둔다. modulation index의 MI와 mutual information의 MI는 화면에서 서로 다른 이름을 쓴다. surrogate 보정 전·후 값과 고조파·비정현 파형 검사를 함께 제공한다.[^10]

### 3.4 그래프

| ID | 지표 | 구현 후보 | 입력·해석 |
| --- | --- | --- | --- |
| M30 | 군집계수 | bctpy | 지정한 weighted/binary 그래프 |
| M31 | 모듈성 | bctpy | community 방법·resolution·seed |
| M32 | 전역 효율성 | bctpy | edge→distance 변환 명시 |
| M33 | 특성 경로 길이 | bctpy | 단절 그래프 처리·포함 노드 명시 |

그래프 지표는 EEG 배열에서 직접 계산하지 않고, 먼저 완성한 연결성 결과를 입력으로 받는다.[^11] 기본은 nonnegative PLV/wPLI 그래프다. raw matrix, thresholded matrix, binary adjacency를 별도 저장하고, 10/20/30% density 같은 사전 지정 민감도 분석을 제공한다. 모듈성은 반복 최적화·seed를 기록한다.

음수 edge를 모두 절댓값으로 바꾸지 않는다. signed 분석을 지원하지 않는 경우 이유를 반환한다. `distance=1/weight`에서 0 edge를 무한 거리로 처리하고, 단절 그래프의 경로 길이를 0으로 채우거나 무단으로 최대 연결 성분만 선택하지 않는다.

### 3.5 공통 반환 규칙

metric 결과는 값뿐 아니라 `status`, `reason_code`, `variant`, `analysis_space`, `units`, `axes`, `parameters`, `input_artifact_id`, `backend_version`, `n_samples`, `n_epochs`, `validity_flags`를 포함한다.

상태는 `ok`, `not_applicable`, `insufficient_data`, `invalid_input`, `unsupported_dependency`, `failed`, `cancelled`로 구분한다. 누락·실패를 0이나 빈 성공 행렬로 바꾸지 않는다. 요청한 필수 metric의 dependency 누락은 전체 완료로 처리하지 않는다. 조건별 peak 부재처럼 정상적으로 발생 가능한 결과와 실행 실패를 구별한다.

## ⚙️ 4. 처리 순서와 통계 비교

### 4.1 실행 흐름

```mermaid
flowchart LR
    accTitle: JR EEG Benchmark Pipeline
    accDescr: A validated recipe generates JR source activity, reuses it across observation conditions, computes eligible metrics, and compares independent repetitions while keeping truth outside analysis.
    recipe["Recipe와 비용 검증"] --> simulate["TVB JR 적분"]
    simulate --> sources["원래 신호원 저장"]
    sources --> observe["관측과 reference 적용"]
    observe --> preprocess["QC와 분석별 전처리"]
    preprocess --> metrics["지표 어댑터 실행"]
    metrics --> compare["반복과 조건 비교"]
    compare --> report["결과와 보고서 저장"]
    sources -.-> truth["생성 truth 별도 보관"]
    truth -.-> compare
```

분석 함수는 resting 신호·구간 metadata·분석 recipe만 받는다. 실제 연결 행렬이나 planted edge를 받아 분석 대역·lag·정답 위치를 선택하지 않는다. truth는 분석 결과를 동결한 뒤 evaluation 계층에서만 사용한다.

신호 생성, 관측, 전처리, metric, 통계, 보고서를 별도 cache key로 분리한다. metric을 바꾸면 기존 신호를 재분석하고 TVB를 다시 실행하지 않는다. L·reference만 바꾸면 원신호 artifact를 그대로 사용한다. A/B 측정 설정을 바꿀 때는 두 결과가 모두 준비된 뒤 함께 교체한다.

### 4.2 전처리 분기

- Raw 원본은 불변으로 두고, PSD·위상 연결성·ordinal 정보량·entropy·GC/TE·PAC별 derivative를 만든다.
- 필터는 가능한 연속 신호에서 적용하고 epoch 경계·edge padding·제외 구간을 기록한다.
- PSD·복잡도·연결성에 사용한 실제 시간 구간이 다르면 화면과 보고서에 표시한다.
- GC/TE는 임의의 강한 대역통과를 공통 적용하지 않는다. 필터에 따른 방향성 변화와 모델 진단을 별도로 확인한다.
- PAC의 amplitude 대역은 modulation sideband를 포함할 수 있게 정하고 phase 대역과의 중첩·고조파를 검사한다.
- 원신호 native 분석에는 센서 reference를 적용하지 않는다. source 재구성이 추가되면 `reconstructed_source`라는 별도 공간으로 관리한다.

### 4.3 조건 효과와 반복 단위

1. 같은 seed의 연결 on/off 차이를 paired effect로 계산한다.
2. 같은 source artifact의 identity/혼합 차이로 관측 효과를 계산한다.
3. `(D−C)−(B−A)`로 혼합에 따라 결합 효과가 어떻게 달라지는지 요약한다.
4. confidence interval과 permutation/bootstrap의 재표집 단위는 독립 simulation seed다. 한 기록의 epoch나 496개 edge를 독립 실험 반복으로 세지 않는다.
5. 절대 진폭·단위가 다른 공간에서는 raw power 차이 대신 공간 내 상대 변화 등을 별도 정의한다.

지표 간 숫자 크기를 그대로 비교하지 않는다. within-metric 효과·신뢰구간·null 대비 변화·검출 성능을 비교한다. B보다 A가 높게 나온 metric도 결과로 보존하며, 결과 방향을 성공 판정으로 강제하지 않는다.

### 4.4 Null과 다중 비교

독립 시뮬레이션, channel별 phase randomization, 적절한 epoch permutation·시간 이동을 목적에 맞게 사용한다. 단순 시점 무작위 섞기는 autocorrelation·스펙트럼을 파괴하므로 기본 null로 사용하지 않는다. 반복성이 강한 진동에서 고정 시간 이동은 위상 관계를 충분히 파괴하지 못할 수 있으므로 각 null의 실제 동작을 확인한다.

각 null이 보존·파괴하는 속성을 manifest에 기록한다. 496개 무방향 pair와 992개 방향 pair를 구분하며, band·tau·시간창까지 포함한 검정 family를 사전 선언한다. max-statistic FWER 또는 선언된 FDR을 사용하고 방법을 결과에 저장한다. surrogate p-value는 `(b+1)/(B+1)`로 계산해 0을 보고하지 않는다. 필요한 p-value 해상도가 부족하면 추가 계산 또는 해상도 부족 상태를 표시한다.

### 4.5 Ground truth의 범위

JR `C`는 생성 과정의 직접 연결이다. pairwise 통계적 의존성은 간접 경로나 공통 입력에도 발생할 수 있으므로 C와 일치하지 않는 모든 edge를 알고리즘 실패로 부르지 않는다. 직접 edge 검출, 조건 개입에 대한 반응, 통계적 독립성 검정을 서로 다른 평가로 분리한다.

센서 행렬은 source C와 노드 의미가 다르므로 source 그래프를 그대로 대입해 precision/recall을 계산하지 않는다. 정답을 연결 행렬에서 얻는 평가는 source 공간에 한정하며, 센서에서는 독립 조건의 오검출·조건 구분·관측 변화에 대한 민감도를 평가한다.

## 🏗️ 5. 기존 저장소에 추가할 구조

### 5.1 모듈 경계와 파일 배치

아래는 제안 경로이며 아직 구현된 파일 목록이 아니다. 루트는 위에 명시한 Neurosignal-Testbed 저장소다.

```text
packages/neurobridge_core/src/neurobridge/
  simulation/tvb_jr.py                 # TVB adapter, units, seed, integration
  simulation/resting_artifacts.py      # 통제된 오염 생성; truth 별도 보관
  forward/geometry.py                  # 기존 sphere/몽타주 코드의 공통 경계
  forward/observation.py               # identity/schematic/physical + R/noise
  benchmarks/
    contracts.py                      # experiment/condition/run contracts
    presets.py                        # Q1–Q7의 질문과 contrast 정의
    planner.py                        # condition expansion, cost, DAG
    runner.py                         # orchestration and stage checkpoints
    comparisons.py                    # paired effects and uncertainty
    evaluation.py                     # truth-aware scoring; analysis와 분리
  metrics/
    registry.py                       # executable adapters and requirements
    spectra.py                        # M01–M06
    connectivity.py                   # M11–M20
    information.py                    # M21–M23
    complexity.py                     # M24–M26
    directed.py                       # M27–M28
    pac.py                            # M29
    graphs.py                         # M30–M33
  quality/
    recording.py                      # 원본·구간 QC, 유효 mask, rank
    eligibility.py                    # metric별 입력 적합성 판정
    stability.py                      # 길이·구간·반복 신뢰성
  artifacts/store.py                  # immutable arrays/manifests/checksums
  jobs/manager.py                      # persistent status, progress, cancel
  jobs/worker.py                       # scientific process workers

apps/api/neurobridge_api/routes/benchmarks.py
apps/web/src/features/benchmarks/
  BenchmarkWorkbench.tsx
  ExperimentDesigner.tsx
  ConditionGrid.tsx
  MetricCatalog.tsx
  ResultsExplorer.tsx
  JobProgress.tsx
  api.ts
  types.ts

fixtures/recipes/jr-*.json
lessons/benchmarks/jr-*.yaml
tests/oracle/test_jr_*.py
tests/integration/test_benchmark_*.py
```

기존 `contracts/models.py`에 모든 새 모델을 계속 쌓기보다 새 기능 계약을 별도 파일에 두고 필요한 타입만 re-export한다. Python JSON Schema를 기반으로 새 기능의 TypeScript 타입을 생성·검증해 수동 중복을 줄인다. 기존 타입 계약과 API는 호환 유지한다.

### 5.2 재사용할 실제 파일

| 현재 파일 | 재사용 또는 수정 범위 |
| --- | --- |
| `packages/neurobridge_core/src/neurobridge/connectivity/engine.py` | MNE 호출·fixture 패턴 참고; 절댓값/clipping 경로는 새 엔진에 복사하지 않음 |
| `packages/neurobridge_core/src/neurobridge/source_modeling/engine.py` | forward 생성의 좌표·방향 검증을 공통 geometry로 추출 |
| `packages/neurobridge_core/src/neurobridge/qeeg_lab.py` | 32전극 목록, 리드필드 방향 투영·단위 변환의 기존 경계 재사용 |
| `packages/neurobridge_core/src/neurobridge/real_data/qeeg.py` | derivative staging·원자적 저장·run JSON 패턴 재사용 |
| `packages/neurobridge_core/src/neurobridge/module_registry/registry.py` | `simulation.tvb-jr`, `benchmark.factorial`, metric capabilities 등록 |
| `packages/neurobridge_core/src/neurobridge/cli.py` | 구형 recipe 명령 유지, benchmark subcommand 추가 |
| `apps/api/neurobridge_api/main.py` | 새 router 등록; 기존 route 동작 유지 |
| `apps/web/src/components/LabNavigator.tsx` | 7번째 실험실 `JR Benchmark` 추가 |
| `apps/web/src/App.tsx` | 새 workbench 선택 경로만 연결 |
| 기존 matrix/trace/topomap components | 다채널·부호·정의역 지원 여부를 확인해 공유 |

geometry의 채널 수·source 개수·fs를 상수에 묶지 않는다. 리팩터링은 새 어댑터가 기존 결과를 보존하는 회귀 검증을 통과한 범위에서 수행한다. trace viewer 재사용은 32채널·긴 기록·창 요청을 검증한 뒤 적용한다.

### 5.3 데이터 계약

| 계약 | 주요 내용 |
| --- | --- |
| `JRSimulationSpec` | preset/version, node parameters, C/D/G, input/noise, dt, duration, seed tree |
| `ObservationSpec` | kind, source geometry/orientation, montage, gain, L/R, sensor noise |
| `RestingRecordingSpec` | 상태 metadata, segment selection, 길이·gap·bad annotation |
| `RecordingQC` / `SegmentQC` | 단위·좌표·rank·품질·제외 사유·유효 시간 mask |
| `ArtifactStressSpec` | 오염 종류·강도·시점·공간 분포·seed; 평가용 truth 분리 |
| `MetricSpec` | ID/variant, backend, input spaces, params, requirements |
| `BenchmarkSpec` | factors, held-fixed settings, seeds, metrics, multiplicity, budget |
| `ArtifactManifest` | kind, shape, dtype, units, axes/order, checksum, parents, versions |
| `MetricResult` | status/reason, data refs, diagnostics, parameters, sample counts |
| `ComparisonResult` | contrast definition, independent n, CI, null/test family |
| `ReliabilityResult` | duration/subsegment/repeat, 추정 분산·안정성·coverage |
| `JobManifest` | state, stage, task counts, completed artifacts, failures, cancellation |

channel order와 source order를 이름·고정 ID로 기록한다. 낮은 삼각만 채워 반환하는 backend와 full matrix를 반환하는 backend를 구분하고 명시적 pair indices로 변환한다. 이미 대칭인 행렬을 `A+A.T`하여 두 배로 만들지 않는다. 분석 원값은 float64로 저장하고 반올림은 화면과 CSV 표시 단계에서만 한다.

### 5.4 저장과 작업 실행

로컬 앱 데이터 영역의 project별 `benchmarks/<experiment_id>/`를 사용하고 기존 real-data 프로젝트와 manifest 연결을 제공한다. raw EEG와 source 배열을 브라우저 localStorage나 응답 JSON 전체에 넣지 않는다.

초기 저장 형식은 MNE FIF(sensor·annotations·resting epochs), NumPy `.npy`(source·행렬; mmap 가능), JSON(manifest), CSV/TSV(요약)로 단순화한다. 배열 축·단위는 JSON에 함께 저장한다. 대규모 chunk 저장이 실제로 필요할 때만 Zarr/HDF5를 추가한다. pickle·임의 실행 Python recipe는 사용하지 않는다.

작업은 FastAPI 응답 수명과 분리된 process worker에서 실행한다. SQLite 또는 동등한 로컬 영속 job index, stage별 atomic artifact commit, checksum, resume를 제공한다. API 메모리 `RUNS` 사전을 장기 저장소로 확장하지 않는다. 서버 재시작 시 실행 중이던 항목을 무조건 completed로 바꾸지 않고 interrupted 상태를 복구한다.

취소는 checkpoint에서 cooperative하게 처리하고, 긴 JIDT 계산은 종료 가능한 전용 프로세스로 격리한다. 이미 commit한 artifact는 남긴다. worker 수·BLAS·Numba·Java thread 수를 함께 제한해 중첩 병렬화를 피한다. 새 route도 기존 로컬/remote 접근 정책을 따르고 artifact ID를 통한 프로젝트 범위 접근만 허용한다.

### 5.5 제안 API와 CLI

| API | 목적 |
| --- | --- |
| `GET /benchmarks/capabilities` | 설치·검증된 backend, metric requirements |
| `POST /benchmarks/validate` | schema·과학 조건·예상 비용 검증 |
| `POST /benchmarks/experiments` | recipe 저장과 작업 생성 |
| `GET /benchmarks/experiments/{id}` | 조건 목록·결과·manifest 조회 |
| `GET /benchmarks/jobs/{id}` | 실제 stage·진행·실패 수 조회 |
| `POST /benchmarks/jobs/{id}/cancel` | 작업 취소 요청 |
| `POST /benchmarks/experiments/{id}/resume` | 완료 artifact를 재사용해 재개 |
| `POST /benchmarks/experiments/{id}/analyses` | 같은 신호의 metric 재계산 |
| `GET /benchmarks/artifacts/{id}/window` | trace 부분 조회 |
| `POST /benchmarks/experiments/{id}/exports` | HTML·recipe·수치 export |

CLI는 `neurosignal-recipe benchmark validate/run/resume/export` 형태를 제안한다. 실제 옵션은 해당 단계에서 구현하며, 현재 제공되는 명령이라고 문서화하지 않는다. CLI와 웹은 동일 runner를 호출하고 별도 과학 계산 코드를 갖지 않는다.

## 🎓 6. 사용자 화면과 실행 규모

### 6.1 사용 흐름

`질문 선택 → 회로 구성 → 관측 조건 구성 → 지표 선택 → 예상 작업 확인 → 생성·분석 → 조건 비교 → 보고서` 순서로 제공한다. 기본 화면은 네 가지 핵심 조건을 보여주고 세부 factor는 펼쳐서 설정한다.

| 화면 | 보여줄 내용 |
| --- | --- |
| 회로 | source graph, 연결 강도·방향·지연, 입력·잡음 |
| 관측 | source/probe/EEG 구분, L/R, 32전극, 단위 |
| 품질 확인 | 원본·선택 구간·제외 이유·잔존 길이·rank·분석 가능 여부 |
| 지표 목록 | 질문별 분류, 적합성, 추가 의존성, 예상 비용 |
| 실행 | 실제 완료 task 수·현재 단계·오류·취소·재개 |
| 결과 | trace/PSD·spectrogram, spectra fit, 행렬, entropy 분포, PAC, graph |
| 조건 비교 | A/B 고정, seed paired change, confidence interval |
| 생성 정보 | 실제 C/D/L/R·parameter·version·hash·seed |

결과 화면의 기본 선택은 Q1의 PLV·wPLI·wSMI 비교이며 전체 catalog는 보조 탭으로 둔다. 한 카드에서 효과 크기·CI·유효 반복 수·자료 coverage·QC·nuisance 결과를 연결하고, 의미 없는 종합 점수로 축약하지 않는다. 분포·paired point·원자료를 먼저 보여주고 유의성 표시는 보조로 둔다.

지표를 바꾸면 같은 EEG를 사용한다. 결과와 편집 중 설정을 구별하고, 새 요청이 실패하거나 취소되면 이전 결과를 유지한다. seed별 결과를 클릭해 실제 신호·PSD로 돌아갈 수 있게 한다.

source matrix와 sensor matrix는 서로 다른 노드로 표시한다. 같은 metric·variant·단위의 조건끼리는 고정 색 범위를 사용하고 signed metric은 발산형 색상을 쓴다. PAC·GC·TE에는 방향·주파수 축을 유지한다. 수치 정의역이 다른 metric 사이에 공통 0–1 색 범위를 강제하지 않는다.

고급 설정에는 표본 수, reference, rank, epoch 길이, 사용 대역·tau, 독립 반복 n을 노출한다. 설치 경로·내부 cache key 같은 구현 정보는 사용자 판단에 필요한 provenance 화면에만 둔다.

### 6.2 실행 profile과 비용 관리

| Profile | 목적 | 완료 의미 |
| --- | --- | --- |
| `preview` | 한 seed·짧은 신호로 UI와 대략적 PSD 확인 | 연구 비교 완료가 아님 |
| `core-comparison` | 4조건, source/sensor, PLV·wPLI·wSMI와 QC | 핵심 결합·혼합 비교 |
| `full-metrics` | resting EEG 대상 29개 ID 전체 | 필수 지표별 상태·artifact 모두 검토 |
| `sensitivity` | delay·SNR·reference·length·dt 변화 | 사전 선언한 factor 범위 분석 |

첫 본 분석 예시는 연결 2수준 × 관측 3수준(identity/schematic/forward) × reference 2수준 × sensor noise 2수준 × seed 30개 = 720개 관측 기록이다. 동일 seed의 JR 적분은 연결 2수준에 대해 60번만 수행하고 나머지는 관측·분석을 재사용한다. 독립 입력 잡음 수준을 추가하면 별도 source artifact가 필요하다.

센서 noise는 무잡음과 독립 calibration으로 정한 고정 강도 두 수준을 사용한다. 각 관측 연산자 안에서는 연결 on/off에 동일 강도를 유지하고 실제 SNR도 보고한다. 조건마다 신호 RMS에 맞춰 noise를 다시 조절해 결합 효과를 숨기지 않는다.

32×256 Hz×120초 float64 배열 하나는 약 7.5 MiB다. 720개 센서 배열만 약 5.3 GiB이며 derivative·surrogate·source 저장은 추가다. 고주파 적분 상태 전체를 매번 저장하지 않고 필요한 monitor output과 checkpoint만 보존한다. 시간·디스크 추정은 pilot 측정으로 보정한다.

TE 전체 992방향 pair, PAC의 채널×주파수 조합, surrogate 반복은 비용이 크다. 기본 UI는 선택 pair와 사전 지정 대역을 제안하되, 사용자가 전체를 요청하면 비용을 보여주고 queued job으로 실행한다. 선택 pair 실행을 전체 32채널 분석 완료라고 보고하지 않는다. 자원 한도 초과는 작업 분할로 처리하며 일부 지표를 몰래 제외하지 않는다.

`full-metrics`는 resting 기록의 29개 지표와 해당 알고리즘 검증 fixture를 포함한다. 자극·행동 데이터나 task 분석은 생성하지 않는다.

## ✅ 7. 과학·제품 검증 계획

### 7.1 독립 oracle와 불변성

| 검증 ID | 내용 | 통과 근거 |
| --- | --- | --- |
| V01 | TVB 1-node JR baseline | 사전 문헌 preset·단위·출력 변수와 PSD 확인 |
| V02 | 결정론 적분 수렴 | dt와 dt/2의 trajectory·PSD 수렴 |
| V03 | 확률 적분 수렴 | Brownian increment를 정합하거나 분포·PSD·효과의 수렴 확인 |
| V04 | 실제 결합 방향 | 0→1 impulse가 설정한 경로로 전달 |
| V05 | 독립 입력·재현 | node별 noise 독립, 같은 seed rerun 수치 tolerance 일치 |
| V06 | 관측만 변경 | source checksum·resting segment 정의 불변 |
| V07 | 지표만 변경 | 입력 EEG checksum 불변, JR 재적분 없음 |
| V08 | forward·reference | 독립 L@q 계산 일치, 좌표·단위·rank 확인 |
| V09 | 분석의 truth 격리 | truth metadata를 바꿔도 metric 결과 불변 |

확률·비선형 모형에서 다른 platform 또는 solver의 bitwise 동일성을 무조건 보장하지 않는다. 같은 잠금 환경의 재현성과 수치 tolerance, 환경을 바꾼 경우의 분포적 재현성을 구분한다. TVB wrapper를 같은 TVB 호출과만 비교하는 검증으로 끝내지 않는다.

### 7.2 지표별 양성·음성 대조

| 검증 ID | 대상 | fixture와 판단 |
| --- | --- | --- |
| V10 | PSD·파워 | 알려진 주파수·분산의 신호, Parseval·적분 단위 |
| V11 | specparam | 알려진 배경·peak·peak 없는 PSD; 결측과 fit 실패 구분 |
| V12 | PLV·PLI·wPLI | 독립 위상, 0지연, 일정 비영 지연; 유한 표본 null |
| V13 | PPC·debiased wPLI² | 음수 보존, 일반 지표와 혼동 없음 |
| V14 | MI·SMI·wSMI | 독립 신호·알려진 symbol joint counts·동일/반대 패턴 가중치 |
| V15 | Entropy·LZ | 상수·주기·독립 noise·길이 변화·정규화 |
| V16 | GC·TE | 알려진 방향의 VAR/비선형 fixture, reversed·common-input control |
| V17 | PAC | 알려진 modulation 양성, uncoupled 음성, 비정현 고조파 대조 |
| V18 | Resting 구간 선택 | gap·bad annotation·필터 edge 제외, 실제 잔존 시간 보존 |
| V19 | 그래프 | 손계산 가능한 작은 graph, 단절·음수·density 변화 |
| V20 | 행렬 축 | source/target order, lower triangle/full, signed/antisymmetric 구분 |

지표 wrapper는 원시 backend와 fixture에서 일치해야 하고, 최소 한 개의 손계산 또는 독립 공식 oracle를 가진다. surrogate의 independence·스펙트럼 보존도 검사한다. 수용 tolerance는 calibration에서 정의한 뒤 holdout에서 확인하며 매번 결과에 맞춰 완화하지 않는다.

### 7.3 통계·작업·UI 검증

- V21: seed 단위 paired effect와 confidence interval; epoch pseudo-replication 금지.
- V22: 검정 family·다중비교·p-value 해상도; null false-positive의 binomial 불확실성 확인.
- V23: 실행→저장→서버 재시작→복원→재개; checksum 불일치 시 재사용 금지.
- V24: 취소·worker crash·부분 실패·backend 미설치에서 완료 건수와 실패 이유 보존.
- V25: 두 프로젝트 간 artifact 격리, 잘못된 경로·미등록 metric 실행 거부.
- V26: UI A/B atomic update, stale request, metric 변경 시 입력 재사용.
- V27: 실제 32채널·긴 trace, 1024px와 넓은 화면에서 controls·색상·축·단위 확인.
- V28: 기존 sampling·ICA·connectivity·source·QEEG·real-data oracle와 UI 회귀 검사.
- V29: clean→corrupted→processed에서 오염 감소와 neural distortion을 독립 평가; clean 입력에는 강제 ICA 없음.
- V30: 30/60/120초 prefix·분리 구간·새 seed 반복의 안정성 및 실제 사용 epoch 수 확인.
- V31: C·G 고정, 파워·peak·noise·reference만 변경한 nuisance 대조; universal metric 순위 강제 없음.
- V32: QC mask를 바꾸면 실제 분석 입력과 유효 시간이 함께 바뀌며, 제외된 표본을 이어 붙여 가짜 시간 인접성을 만들지 않음.
- V33: 동일 source에서 파생된 관측·처리본을 독립 반복으로 중복 계수하지 않음.
- V34: empirical resting recording의 원본 hash 보존·재분석 일치; 실제 연결 truth 점수 없음.
- V35: source reconstruction을 켠 경우 native source와 구분하고, forward/inverse 일치·불일치 및 leakage를 기록.
- V36: 보고서의 해석 문장이 실제 metric·contrast·QC 결과를 참조하고, 과도한 생리·인과·진단 label을 출력하지 않음.

현재 저장소의 `pytest`, Ruff, 웹 test·typecheck·build 경로를 유지한다. 무거운 benchmark·Java 검증은 marker로 분리하되 release gate에서는 명시적으로 실행한다. 빠른 suite만 통과하고 전체 과학 검증을 통과했다고 보고하지 않는다.

## 📦 8. 단계별 구현과 완료 기준

| 단계 | 변경 범위 | 완료 기준 |
| --- | --- | --- |
| P0 · 환경·계약 | 격리 환경, dependencies, recipe/result schema, metric inventory | 현재 회귀 검사 보존; 29개 ID와 설치 가능성·API·단위 계약 확인 |
| P1 · 실행 기반 | artifact store, job manifest, worker, cancel/resume, cache keys | 실제 stage 진행·재시작 복원·부분 실패 보존 |
| P2 · JR 생성기 | 1→2→32 node, noise/input, C/D/G, monitor·단위 | V01–V05; calibration 후 preset·evaluation seed 동결 |
| P3 · 관측 모형 | identity/schematic/32전극 forward, reference/noise | V06·V08, source 불변과 L/R 분리 |
| P4 · 핵심 비교 | PLV·wPLI·wSMI, 네 조건, CLI 최소 report | 동일 입력 기반 원값·null·paired 효과; 증가 방향 강제 없음 |
| P5 · 일반 지표 | 스펙트럼·AEC·MI/SMI·복잡도·그래프·나머지 위상 지표 | M01–M06·M11–M26·M30–M33, 각 oracle·결측 상태 |
| P6 · 방향성·PAC | GC·TE·PAC와 독립 fixture | M27–M29; full-metrics에서 전 계열 실행 |
| P7 · 품질·견고성 | QC/eligibility, artifact stress, 길이·구간·nuisance 비교 | V29–V33; 제거 성능과 neural distortion 동시 평가 |
| P8 · 웹·실제 resting 연결 | 7번째 Lab, 질문별 preset, real-data 선택 구간, report | 32채널 UI·원본 보존·불확실성·재시작 복원; V34·V36 |
| P9 · 반복·출시 검증 | 30seed 이상 본 분석, sensitivity, 문서·lock·보고서 | 필수 V01–V34·V36와 전체 metric 추적 완료; source reconstruction 선택 시 V35도 필수 |

각 단계는 검토 가능한 작은 변경으로 나눈다. P0에서는 설치·메타데이터 확인에 그치지 않고 실제 import와 최소 계산을 실행한다. 현 `mne-connectivity 0.8.1`을 우선 시험하고, TVB·NumPy·SciPy·Numba·specparam 조합 때문에 변경이 필요할 때만 함께 검증한 잠금 버전을 선택한다.

의존성은 `simulation`(TVB), `metrics`(AntroPy·bctpy), `pac`(Tensorpac), `information`(IDTxl/JIDT) 등 optional group으로 분리하고, 전체 환경은 검증된 조합으로 명시한다. 설치되지 않은 기능은 capability에 드러낸다. 모든 지표 구현 완료 판정에는 해당 group의 실제 실행이 필요하다.

### 8.1 첫 번째 구현 단위

가장 먼저 P0–P4를 하나의 수직 기능으로 완성한다. 사용자가 JR 네트워크로 네 조건을 생성하고, 같은 artifact에서 PLV·wPLI·wSMI를 계산해 seed별 차이를 저장·복원할 수 있어야 한다. 이 단위가 통과하면 나머지 지표들은 동일 registry·job·artifact 계약에 순차 등록한다.

첫 단계부터 모든 고급 지표의 UI를 만들지는 않지만, metric catalog에는 29개 전체의 개발 상태와 입력 요구사항을 표시한다. P4만 끝난 상태를 전체 요청 완료라고 표시하지 않는다.

### 8.2 전체 기능의 정의

- 범위에 남긴 29개 ID가 resting/control 데이터에서 실제 계산되고 source/sensor·채널·주파수·시간 축이 보존된다.
- 전체 요청의 조건·seed·metric 완료/실패/부적합 건수가 정확하다.
- 모든 필수 metric이 backend health와 oracle를 통과한다. TE·PAC의 subset 실행 여부가 명확하다.
- 실제 값·단위·부호·불확실성·전처리·검정 family를 export에서 재구성할 수 있다.
- source C와 sensor graph를 같은 정답으로 취급하지 않는다.
- independent repeat·수치 수렴·null 대조를 통과하고 전 지표의 증가를 강제하지 않는다.
- CLI와 웹 결과가 같은 입력에서 일치하고 취소·재개·재시작을 검증한다.
- 기존 수업과 실데이터 import·QEEG 결과를 보존한다.
- Q1–Q7 preset에서 어떤 질문에 답했고 어느 교란을 통제했는지, 각 metric의 용도·한계·안정성을 확인할 수 있다.
- 실제 resting EEG는 입력 품질·재현성·불확실성을 평가하고, 시뮬레이션 truth를 실제 데이터 정답으로 대입하지 않는다.

## 🔍 9. 첨부 자료를 반영한 resting EEG 분석 품질

### 9.1 참고 자료의 활용과 수정

참고한 문서는 [ClaudeEEG SKILL.md](/Volumes/Aquatope/Downloads/SKILL.md)다. 적용한 부분은 질문 중심 도구 선택, raw/PSD/구간 검토, 처리 기록, 비정상성·artifact·연결성 점검, 독립 반복·효과 크기·불확실성 보고다. 참고 위치는 §2, §4, §6.6, §13–14, §16이며, 모델링 데이터 분리 원칙만 §12.4·§17.4에서 참고했다. 문서 안의 장비 질문·설치·자동 실행 지시는 이번 요청을 대체하지 않는다.

첨부본 SHA-256은 `042e6b413fde3b6f7a2e22f0796c5c8cc982d2f2a9e1cbca1d68d0a6398a17fc`다. 외부 참고 파일이 바뀌어도 어떤 내용을 근거로 계획했는지 추적한다. 문서의 모든 문장을 검증된 표준으로 취급하지 않고, 다음 항목은 수정해 반영한다.

| 첨부 자료의 단정·예시 | 이번 설계의 처리 |
| --- | --- |
| 모든 데이터에 동일한 cleaning 순서 적용 | clean simulation은 최소 처리; 오염·분석 목적별 분기 |
| ICA/ICLabel 결과에 따른 자동 제거 예시 | 기존 수동 검토 유지; label은 보조이며 성능·왜곡을 검증 |
| 과거 `mne.connectivity` 경로 | 설치된 별도 `mne-connectivity` API 사용 |
| 정해진 Nyquist 비율로 무조건 low-pass | 목표 fs·통과/저지 대역·transition과 실제 anti-alias 응답 검사 |
| TE 또는 lag 지표가 혼합에 안전하다는 표기 | 혼합·reference·공통 입력 대조에서 직접 평가 |
| exponent·alpha 유무·R²로 정상/병리 판정 | descriptive 결과와 fit 진단만 제공; 진단 임계값 없음 |
| 채널 수 하나로 source 추정 가능성 판정 | rank·geometry·SNR·모형 불일치·leakage로 평가 |
| PLV/coherence의 센서 분석을 금지 | 혼합 민감도를 배우는 대조 지표로 유지 |
| 모든 파워에 log 변환·정규성 p값으로 검정 자동 선택 | primary contrast·변환·검정을 사전 지정; 분포·잔차와 설계 가정 확인 |

MNE의 실제 필터 위상·anti-alias 동작과 ICA의 rank·fit/apply 요구사항은 설치 버전의 공식 문서로 확인한다.[^12] 문서에 등장하는 인지·질환·주파수 대역의 단정적 대응을 자동 해석 규칙으로 이식하지 않는다.

### 9.2 품질 확인을 분석 입력에 연결한다

`RecordingQC`는 단위·시간축·유한값·flat/clipping·채널 누락·위치·reference·rank·이전 필터 정보를 확인한다. `SegmentQC`는 구간별 진폭 분포·스펙트럼·line peak·급격한 변화·bad annotation·유효 길이를 보존한다. 시뮬레이션에서는 알려진 포화 한계·오염 truth를 평가에만 사용하며, 실제 EEG에서는 관찰 근거와 수동 검토를 기록한다.

QC 판정은 `pass / review / block`과 사유를 반환한다. NaN·불명 단위·불가능한 Nyquist 같은 입력 오류는 차단하고, 미약한 alpha·넓은 배경·낮은 fit R²만으로 bad channel이나 질환을 자동 확정하지 않는다. source/probe 자료에는 두피 EEG 진폭 임계값을 적용하지 않는다.

선택한 제외 mask는 모든 downstream 입력에 실제로 적용한다. 필터 edge, 기록 gap, source/센서 관측 시간의 정합성을 보존하고, 채널·조건마다 유효 길이가 다르면 사용된 데이터 양을 표시한다. 교차 조건 비교는 공통 유효 구간·공통 채널의 결과와 각 조건 전체 결과를 구분한다.

연결성 계산에 보간 채널을 기본 포함하지 않는다. 보간은 다른 채널의 조합을 만들어 의존성을 바꿀 수 있으므로 topomap 표시용과 분석용을 분리한다. 분석에 포함하면 관련 mask·변환·rank와 보간 제외 민감도 결과를 함께 제공한다. 32채널 average reference는 최대 rank 31이며, 보간이 잃은 독립 정보를 복구한다고 가정하지 않는다.

epoch 길이를 늘린다고 자동으로 적합성이 충족되지는 않는다. wSMI는 symbol 수·joint count coverage, MI/TE는 embedding 차원·시간 의존·유효 표본, GC는 rank·lag·안정성·잔차, PAC는 낮은 위상의 cycle 수·amplitude 대역·edge crop을 검사한다. eligibility는 숫자 하나의 보편 임계값 대신 metric별 근거와 허용 가능한 사용 범위를 반환한다.

### 9.3 Artifact stress test에서 제거와 왜곡을 함께 측정한다

같은 source·L·R에서 `clean_sensor`, `corrupted_sensor`, `processed_sensor`를 만든다. blink/saccade형 공간장, 국소 EMG형 burst, line noise, drift, electrode pop·flat/clipping을 독립 모듈로 추가한다. 신경 신호·측정 잡음·오염의 출처를 분리하며, 오염 강도와 공간적 상관도 factor로 둔다.

검증은 첫 두 종류의 오염과 clean negative control부터 시작한다. 제거 전략은 최소 처리, 수동 bad-segment 제외, 기존 ICA 수동 선택을 비교한다. ASR·Zapline·추가 자동 제거기는 이번 핵심 완성의 선행 의존성으로 강제하지 않는다.

clean truth는 제거 알고리즘의 component 선택·threshold tuning에 전달하지 않고 사후 평가에만 사용한다. 적용한 reference·필터·시간 선택이 같은 clean 비교본을 만들어, 제거 전후의 오염 감소와 원래 신경 활동의 파워·파형·연결성 왜곡을 함께 보고한다. 필터가 제거하도록 정의된 주파수의 차이를 ICA 왜곡으로 잘못 계산하지 않는다.

clean 신호에도 같은 처리를 적용하는 대조를 두어 과잉 제거를 검출한다. 기존 ICA workbench의 수동 제외·호환성 검사를 재사용하며, ICLabel confidence는 정답이나 제거 승인으로 취급하지 않는다. artifact가 없는 JR 기본 비교에 ICA를 강제로 적용하지 않는다.

### 9.4 길이·비정상성·재현성과 해석

30/60/120초의 동일-recording prefix, 서로 분리된 구간, 새 seed의 독립 반복을 각각 비교한다. prefix는 자료 길이 효과, 분리 구간은 기록 내 안정성, 새 seed는 생성 변동성을 본다. 같은 기록의 prefix·half를 독립 n으로 늘리지 않는다. 실데이터에서는 session/recording과 반복 시뮬레이션을 서로 다른 계층으로 기록한다.

기본 QC에 spectrogram, rolling power·peak·variance, autocorrelation·epoch별 통계 분포를 포함한다. 전체 PSD가 유사해도 burst·drift가 다를 수 있는 paired fixture를 둔다. 비정상성이 있으면 한 개의 pooled matrix와 시간 구간별 추정의 차이를 확인하고, 짧은 창에서 생기는 추정 잡음을 실제 연결 변화로 단정하지 않는다.

지표마다 유효 구간 비율, 반복 분산·CI, 순위·그래프 안정성, 자료 길이 대비 수렴, null bias·오검출, runtime을 표시한다. 높은 재현성만으로 타당성을 선언하지 않는다. 센서 혼합에 의한 관계도 매우 재현 가능할 수 있기 때문이다.

주요 파워 contrast는 양수인 파워에 대한 dB ratio 또는 선언한 log difference로 정의하고, 원래 파워도 보존한다. 임의 epsilon으로 0을 숨기지 않는다. primary 분석은 seed 단위 paired 효과와 CI이며, 검정은 exchangeability 등 가정을 명시한다. 정규성 검정 결과 하나로 분석법을 자동 선택하지 않는다.

채널×주파수·시간에 대한 mass-univariate 분석이 필요한 경우에만 물리적 adjacency와 seed별 차이를 이용한 paired cluster permutation을 추가한다.[^13] 연결성의 edge adjacency는 전극 adjacency와 다르므로 자동 재사용하지 않는다. 유의한 cluster를 특정 한 채널·주파수의 정확한 위치 증명으로 해석하지 않는다.

보고서는 질문·대조·사용 데이터·QC·효과·CI·민감도·남은 대안 설명 순서로 작성한다. 기본 출력은 template 기반으로 수치와 provenance를 직접 참조한다. 예컨대 “결합 on/off 차이가 alpha PLV에 나타났고, reference-only 대조에서도 변화가 관찰됨”처럼 범위를 제한한다. “전두엽 소통 향상”, “의식 증가”, “질환 검출” 같은 생리·진단 문장은 생성하지 않는다.

### 9.5 실제 resting EEG와 source 재구성으로 연결할 때

기존 Real data lab의 FIF working copy에서 사용자가 resting 구간을 지정하고 동일 registry·QC·MetricSpec을 적용할 수 있게 한다. 이 경로는 원본과 기존 QEEG derivative를 수정하지 않는다. synthetic과 real에서 같은 ID는 같은 수학적 정의·단위·전처리 variant를 사용한다.

실데이터의 29개 지표는 자료 조건이 적합할 때 계산하며, 미검출·길이 부족·누락 위치 같은 상태를 남긴다. 평가 대상은 재분석 일치·구간 안정성·설정 민감도·fit 진단·자료 coverage다. JR의 연결 C나 문헌의 전형적 alpha 지도를 실제 기록의 정답으로 사용하지 않는다. synthetic normative cohort의 z-score를 이 연구 모듈에 자동 붙이지 않는다.

resting 기록에 알려진 오염을 추가하는 semi-synthetic 경로는 후속 선택 기능으로 둔다. 이때 오염 전 기록은 비교 기준이지 완전히 깨끗한 신경 truth가 아니다. 시뮬레이션에서 잘 작동한 지표가 실제 인간 EEG에서도 타당하다고 자동 승격하지 않는다.

초기 source 분석은 inverse를 거치지 않은 native source다. 후속으로 reconstruction을 켜면 `native_source / reconstructed_source / sensor`를 분리하고, 기존 inverse 경계를 재사용한다. 정확히 같은 forward/inverse geometry의 결과는 유리한 기준으로 표시하며 전극 위치·head conductivity·source grid 불일치를 별도 시험한다. 32센서로 32개 source를 정확히 분리했다고 주장하지 않고 resolution/leakage와 역문제의 불확실성을 남긴다. 이 선택 기능을 켠 실행에는 V35를 필수로 적용한다.

## 🔗 10. 근거와 구현 시 참고 자료

현재 코드 판단은 README, pyproject, core·API·React·oracle test를 직접 읽고 로컬 package metadata와 wSMI signature를 확인한 결과다. 새 TVB·지표 기능은 이 계획 작성 중 설치하거나 실행하지 않았다. 라이브 문서는 설치 버전과 달라질 수 있으므로 최종 구현은 잠금 버전에 맞춘다.

기존 프로젝트 문서인 `PRD.md`, `implementation_plan.md`, `source_localization_plan.md`, `docs/reports/2026-11-01-aeh-eeg-feature-gap-report.ko.md`의 truth 분리·원본 보존·A/B 비교·실험 기록 통합 방향을 이어받는다. 이 문서는 이들의 완료 상태를 덮어쓰지 않는 추가 구현 계획이다.

[^1]: MNE-Connectivity. [0.8.1 wSMI API](https://mne.tools/mne-connectivity/v0.8/generated/mne_connectivity.wsmi.html). 설치 버전의 API와 tau·filter·weighted 설정 확인.
[^2]: The Virtual Brain. [Jansen–Rit implementation](https://docs.thevirtualbrain.org/_modules/tvb/simulator/models/jansen_rit.html), [Simulator](https://docs.thevirtualbrain.org/api/tvb.simulator.simulator.html). 모형·결합·지연 구현의 공식 근거.
[^3]: MNE-Python. [단위 규약](https://github.com/mne-tools/mne-python/blob/main/doc/_includes/units.rst), [가상 Raw 생성](https://mne.tools/stable/auto_examples/simulation/simulate_raw_data.html). 관측 단위·forward 투영의 공식 근거.
[^4]: The Virtual Brain. [Integrators](https://docs.thevirtualbrain.org/api/tvb.simulator.integrators.html). 적분·monitor 주기의 단위와 정합성.
[^5]: specparam. [공식 문서](https://specparam-tools.github.io/). 현재 RC API와 periodic/aperiodic fit.
[^6]: MNE-Connectivity. [0.8.1 spectral_connectivity_epochs](https://mne.tools/mne-connectivity/v0.8/generated/mne_connectivity.spectral_connectivity_epochs.html). 추정 정의·지원 지표·GC·epoch 가정.
[^7]: MNE-Connectivity. [0.8.1 envelope_correlation](https://mne.tools/mne-connectivity/v0.8/generated/mne_connectivity.envelope_correlation.html). AEC·orthogonalization·절댓값 설정.
[^8]: AntroPy. [공식 저장소와 함수 목록](https://github.com/raphaelvallat/antropy). Entropy·LZ 계산 backend.
[^9]: IDTxl. [Estimator 문서](https://pwollstadt.github.io/IDTxl/html/idtxl_estimators.html), [공식 저장소](https://github.com/pwollstadt/IDTxl). MI/CMI/TE 추정과 JIDT 의존성.
[^10]: Tensorpac. [Pac API](https://etiennecmb.github.io/tensorpac/generated/tensorpac.Pac.html). PAC 방법·surrogate·정규화 설정.
[^11]: Brain Connectivity Toolbox for Python. [bctpy 공식 저장소](https://github.com/aestrivex/bctpy). 그래프 지표 backend 후보.
[^12]: MNE-Python 1.12.1. [Filtering](https://mne.tools/1.12/auto_tutorials/preprocessing/25_background_filtering.html), [ICA API](https://mne.tools/1.12/generated/mne.preprocessing.ICA.html). 필터링·위상·ICA fit/apply·rank 확인.
[^13]: MNE-Python 1.12.1. [Spatio-temporal cluster one-sample test](https://mne.tools/1.12/generated/mne.stats.spatio_temporal_cluster_1samp_test.html). paired difference와 시공간 adjacency를 사용하는 추정 경로.
