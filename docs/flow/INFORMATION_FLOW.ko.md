# 정보 흐름(Information flow) 실습 — 개념, 수식, 계산, 시뮬레이션 결과

이 문서는 정답 방향 그래프를 아는 시뮬레이션 32채널 휴지기 EEG에서 정보 흐름·유효 연결 지표를 계산하는 교육용 파이프라인을 설명한다. 각 지표가 **무엇을 보여주고 무엇을 보여주지 못하는지**를 실제 실행 결과로 확인하는 것이 목적이다.

- 개념의 근거 문서: `resources/Structural connectivity, functional connectivity, information flow.md` (저장소 바깥의 상위 폴더). 개념 카탈로그 `neurobridge.flow.concepts`도 이 문서를 출처로 적어 둔다(`SOURCE_DOCUMENT`).
- 이 문서의 모든 수치는 아래 명령을 2026-11-13에 직접 실행한 결과다(§7에 원문 출력). 단, 영위상 필터 비교(§3, §5.1)는 같은 레시피에서 `preprocessing.highpass_phase`만 `"zero_phase"`로 바꾼 두 번째 실행(`flow-39894e4a70-ce801e`)의 결과다. 다른 실행에서 가져온 숫자는 쓰지 않았다.

```bash
uv run neurosignal-recipe flow run fixtures/recipes/flow-preview.json --root <임시 폴더>
# exit 0 · run flow-70de3a216c-1118ea · 파이프라인 total 114.0 s (simulate 62.6 s, analyse 51.2 s)
# frozen analysis sha256 974bd4f411ca…
```

> **범위 주의.** 이것은 시뮬레이션 교육 도구다. 시뮬레이션 설정(G=10, 지연 8 ms, 센서 잡음 25 V 등)은 레시피에 `unvalidated_starting_values`로 표시된 시작값이며, 생리적으로 보정된 값이 아니다. 아래 숫자는 seed 하나(seed 7), 60 s 실행 1회의 값이다.

---

## 1. 네 가지 개념: SC, FC, 방향성 FC/EC, 정보 흐름

| 개념 | 핵심 질문 | 이 실습에서의 위치 |
| --- | --- | --- |
| 구조적 연결성 (SC) | 어느 영역이 물리적으로 연결되어 있는가? | 시뮬레이션의 결합 행렬 `C[target, source]`. **생성 정답**이며 분석 함수에는 전달되지 않는다. 결과가 고정된 뒤 소스 공간 평가에서만 읽는다. |
| 기능적 연결성 (FC) | 어느 영역들의 활동이 함께 변하는가? | Activity flow의 FC 가중치(Pearson·ridge 회귀). |
| 방향성 FC / 유효 연결성 (dFC/EC) | 어느 영역이 다른 영역의 미래를 예측하거나 영향을 주는가? | GC(M27), TE(M28), DCM 정신의 선형 모델. |
| 정보 흐름 (IF) | 어떤 정보가 언제, 어디서 어디로 전달되고 변환되는가? | 방향(Level 1)·내용(Level 2)·변환(Level 3)으로 나누어 묻는다(§2). |

근거 문서의 요지: 강한 FC는 정보 전달을 **시사**할 수 있지만 그것만으로 전달을 결론 내릴 수 없다. 같은 상관은 A→B, B→A, 양방향, 제3 영역 C의 공통 구동, 공통 리듬 동기화 중 어느 것에서도 나온다. 반대로 정보가 실제로 전달되어도 장시간 평균 FC는 낮을 수 있다.

## 2. 세 단계: Direction · Content · Computation

| 단계 | 질문 | 대표 방법 | 이 실습 |
| --- | --- | --- | --- |
| Level 1 · Direction | A에서 B로 영향이 향하는가? | GC, TE, DCM | 계산함 (GC, TE, 선형 유효 모델, activity flow) |
| Level 2 · Content | A에 있던 **어떤** 정보가 B에 도달하는가? | 시간 분해 디코딩, RSA, 자극 조건부 정보 | **해당 없음** (`level2_content_decoding = not_applicable / no_stimulus_labels`) |
| Level 3 · Computation | B가 받은 정보를 다른 입력과 결합해 새 표현을 만드는가? | PID, 비선형 상태공간 모델 | PID(MMI)로 계산함 |

**휴지기 범위 주의 (Level 2).** 내용을 측정하려면 자극·과제 라벨로 표현을 디코딩해야 한다. 휴지기 시뮬레이션에는 자극이 없으므로 파이프라인은 이 항목을 계산하지 않고 `not_applicable`과 이유를 기록한다. 이 값은 0이 아니라 "해당 없음"이다(`pipeline.level2_status()`).

## 3. 시뮬레이션과 관측: 정답을 아는 실험

**정답 그래프** (`fixtures/recipes/flow-preview.json`의 `graph.edges`, `[source, target]`): 8개 TVB Jansen–Rit 노드와 7개 간선.

| 모티프 | 간선 | 이 모티프로 확인하는 것 |
| --- | --- | --- |
| pair | P1→P2 | 단순 방향 |
| chain | A→B→C | 간접 경로 A→C를 직접 간선으로 오인하는가 |
| fork | C→D, C→E | 공통 입력: 형제 D↔E 사이의 허위 간선 |
| convergence | P1→F, A→F | 두 입력의 통합 (PID) |

- 결합 G=10(coupled)과 G=0(control). 두 조건은 같은 seed와 같은 입력 잡음을 쓴다. 행 정규화, 지연 8 ms. 노드 출력은 `v = y1 − y2`(mV), 256 Hz.
- PSD peak(Hz): coupled `[6.75, 6.75, 6.75, 6.75, 6.75, 6.5, 6.5, 9.75]`(F가 9.75), control `[6.75, 6.75, 6.75, 6.75, 7.0, 6.75, 7.0, 6.75]`. 결합이 스펙트럼도 바꾼다는 점(특히 수렴 노드 F)은 방향 지표와 별개인 혼입 요인이다.
- 관측: `source_native`(8채널, 소스 그대로)와 `eeg_forward`(32전극 MNE 구 모형, reference none, 절대 센서 잡음 25 V). 따라서 데이터셋은 `source/coupled`, `sensor-none/coupled`, `source/control`, `sensor-none/control` 4개다.
- 전처리(`pipeline.preprocess`): 선형 detrend → **인과(causal) 0.5 Hz Butterworth high-pass**(`sosfilt`, 처음 2 s 버림) → anti-aliased decimation ×2(256→128 Hz) → 채널별 평균 제거. band-pass는 하지 않는다. 분석 샘플 수는 데이터셋마다 7424개(128 Hz에서 58 s)다.
  - 왜 인과 필터인가: 영위상(`sosfiltfilt`) 필터는 미래 값을 과거에 섞는다. 같은 preview 레시피에서 `highpass_phase: "zero_phase"`만 바꿔 실행하면, 결합이 없는 G=0 소스 공간의 조건부 GC 거짓 양성이 **3/56에서 35/56으로** 늘었다(§5.1).

**정답 격리.** 분석 함수 `pipeline.analyze_dataset(x, sfreq, channel_names, plan, *, sensor_positions=None)`에는 정답 인자가 없다. 분석 결과를 직렬화해 sha256(`truth_isolation.frozen_analysis_sha256`)을 먼저 고정하고, 그다음 `evaluation.evaluate_flow`가 정답을 **소스 공간에서만** 사용한다. 센서 채널은 소스가 아니므로 센서 공간에는 정밀도·재현율을 매기지 않고, G=0에서도 나타나는 방향성 구조만 보고한다. 각 소스에 가장 가까운 전극(`display_channels`)은 표시·가설 위치일 뿐이며, 이번 실행에서는 P2와 C가 모두 T7에 대응했다(`has_duplicate_channels: true`).

**평가 지표 읽는 법.** 소스 공간 G=10에서
- 간선 AUC: 7개 정답 간선과 49개 비간선(KSG는 선언한 17개)의 원시 추정값으로 계산한 Mann–Whitney AUC(`evaluation.auc`). 절댓값을 취하지 않는다.
- 방향 정확도: 정답 간선마다 `forward > backward`인 비율.
- TP/FP: 56개 순서쌍에 대한 Bonferroni 유의성(임계 p = 0.05/56 ≈ 8.9×10⁻⁴).

---

## 4. 다섯 가지 방법

모든 행렬은 `values[target, source]`(행 = 받는 쪽)이고 대각은 NaN이다. 실패하거나 적용할 수 없는 계산은 0이 아니라 `status`와 `reason_code`로 남는다.

### 4.1 Granger causality (F01 · M27) — 누가 누구의 미래를 예측하는가?

**질문.** A의 과거를 알면 B의 미래 예측 오차가 줄어드는가?

**수식.**

$$B_t=\sum_{i=1}^{p} a_i B_{t-i}+\sum_{i=1}^{p} b_i A_{t-i}+\epsilon_t,\qquad F_{A\to B}=\ln\frac{\operatorname{var}(\epsilon^{\text{restricted}})}{\operatorname{var}(\epsilon^{\text{full}})}$$

단위는 nats(잔차분산 비의 자연로그)이고, 유의성은 restricted/full 모형의 F 검정이다. **조건부 GC**는 나머지 모든 관측 채널을 full·restricted 양쪽 모형에 넣는다.

**앱의 계산** (`neurobridge.flow.granger`).
- `select_order(x, max_order, criterion="bic")`로 전체 VAR의 차수를 고른다.
- `conditional_gc(x, order, ...)`: VAR 하나에서 모든 순서쌍의 조건부 GC.
- `pairwise_gc(x, order, ...)`: preview에서는 조건부 GC 차수를 재사용한다(`pairwise_order: "conditional"`).
- `time_reversed_gc(x, order, mode="conditional")`: 시간을 뒤집어 다시 계산하고 `net = G − G_rev`, 우세 방향 `D = G − Gᵀ`를 낸다.
- `fit_var`, `check_eligibility`(관측 수/파라미터, rank: 평균 기준전극처럼 rank가 부족하면 `invalid_input/rank_deficient`).
- `spectral_gc`(mne-connectivity `method="gc"`)는 모듈에 있지만 파이프라인에서는 실행하지 않는다.
- 레지스트리 어댑터: `neurobridge.metrics.directed`의 M27 variant `pairwise`(기본)·`conditional`.

**이 시뮬레이션이 보여준 것.** BIC 차수는 모든 데이터셋에서 12였다. 이 값은 `max_order: 12` 상한과 같으므로 "상한에 걸린 선택"으로 읽어야 한다.

| 소스 공간 | 쌍별 GC | 조건부 GC |
| --- | --- | --- |
| G=10 간선 AUC | 0.892 | 0.901 |
| G=10 방향 정확도 | 7/7 | 6/7 (A→F: 0.002 < F→A 0.005) |
| G=10 Bonferroni TP / FP | 7 / 23 | 6 / 13 |
| G=0 거짓 양성 (Bonferroni, 56쌍 중) | 2 | 3 |

- 강한 간선은 방향이 분명하다. 조건부 GC는 P1→P2 0.454 대 역방향 0.066, A→B 0.434 대 0.032였다. 약한 수렴 간선 P1→F 0.006, A→F 0.002는 크기가 잡음 수준에 가깝다.
- **공통 입력(fork 형제).** P2↔F(공통 구동자 P1): 쌍별 GC는 P2→F를 유의하게 잡았고(0.0046), 조건부 GC는 0.0013, p = 0.68로 잡지 않았다. B↔F(구동자 A)도 같았다. 반면 D↔E(구동자 C)는 조건부 GC로도 남았다(D→E 쌍별 0.102 → 조건부 0.060, 둘 다 유의). 조건부화는 허위 간선을 양방향 모두 줄였지만 D↔E에서는 없애지 못했다. 한 가지 해석은 관측된 C 신호(v 하나)와 선형 VAR로는 C가 D·E에 주는 비선형 입력을 다 설명하지 못한다는 것이다. 이는 해석이며 이 실행에서 따로 검증하지 않았다.
- **간접 경로(chain).** A→C(B 경유): 쌍별 0.151 → 조건부 0.023. 크게 줄었지만 여전히 유의했다. B→D, B→E도 같은 양상이다.
- **시간 역전.** 진짜 지연 상호작용이면 시간을 뒤집을 때 우세 방향의 부호가 바뀐다. P1→P2의 우세 방향 D는 정방향 +0.389, 역방향 −0.405였고, A→B는 +0.402 → −0.298이었다. 센서 공간의 평균 net은 coupled 2.5×10⁻⁵, G=0 4.4×10⁻⁵로 0에 가까웠고 net > 0인 쌍 비율은 0.49와 0.51이었다. 순간 혼합(볼륨 전도)은 순·역방향 GC를 비슷하게 만든다.
- **센서 공간(정답 채점 없음).** 쌍별 GC가 Bonferroni로 유의한 쌍 비율은 coupled 0.996(988/992), **G=0 0.717(711/992)**였다. 결합이 없는데도 72%가 "유의"했고, 이것은 볼륨 전도·기준전극·센서 잡음의 산물이다. 조건부 GC 비율은 coupled 0.382, G=0 0.381로 결합 유무를 구별하지 못했다.

**한계.** GC는 예측(directed predictability)이지 물리적 전달이나 인과가 아니다. 관측되지 않은 공통 입력이 다른 지연으로 두 영역을 구동하면 허위 방향이 생긴다. 선형 모형이며 차수 선택과 필터에 민감하다. 센서 공간에서는 볼륨 전도 때문에 해부학적 경로를 주장할 수 없다.

### 4.2 Transfer entropy (F02 · M28) — 얼마나 많은 정보가 전달되는가?

**질문.** B 자신의 과거를 이미 알 때, A의 과거가 B의 미래에 대한 불확실성을 얼마나 더 줄이는가?

**수식.**

$$TE_{A\to B}=I(A_{\text{past}};B_{\text{future}}\mid B_{\text{past}})$$

- Gaussian(선형) 추정은 닫힌 형태다: `0.5 [ln|S(Yt,Yp)| − ln|S(Yp)| − ln|S(Yt,Yp,Xp)| + ln|S(Yp,Xp)|]`. 분석적 p값은 `2N·TE ~ χ²(l_hist)`를 쓴다.
- KSG 추정(k-최근접 이웃, max-norm): `ψ(k) − ⟨ψ(n_ac+1) + ψ(n_bc+1) − ψ(n_c+1)⟩`. 비선형 의존도 잡지만 유한 표본 편향이 있고 음수가 나올 수 있다(원시값을 그대로 둔다).

**앱의 계산** (`neurobridge.flow.transfer_entropy`).
- `te_matrix(x, pairs, estimator="gaussian"|"ksg", k_hist, l_hist, lag, n_surrogates, ...)`가 `gaussian_te`, `ksg_te`, `ksg_cmi`를 호출한다.
- 유의성: Gaussian은 분석적 χ². KSG는 `surrogate_test`(epoch 안 원형 이동, `p = (b+1)/(B+1)`)이며, preview에서는 surrogate를 0개로 두어 KSG에는 p값이 없다(`no_surrogate_test` 플래그).
- KSG 쌍은 각 모티프 노드 그룹 안의 모든 순서쌍(양방향)과 대조 쌍이다. 방향 정답을 쓰지 않고 고른다. 이번 실행에서는 소스 공간 24쌍이었다.
- 레지스트리 어댑터: M28 variant `gaussian`(기본)·`ksg`.

**이 시뮬레이션이 보여준 것** (preview: k_hist = l_hist = 2, lag 1, KSG k = 4).
- **GC와 TE의 관계.** 선형 Gaussian 과정에서 같은 차수일 때 TE = GC/2다. 파이프라인의 `gc_te_identity` 진단에서 채널 0→1, 차수 12의 Gaussian TE는 0.229016 nats, 쌍별 GC/2도 0.229016 nats였다.
- Gaussian TE(짧은 임베딩 k = l = 2): G=10 AUC 0.895, 방향 7/7, Bonferroni TP 7 / **FP 33**. **G=0 거짓 양성 21/56.** 목표 자신의 과거를 2샘플만 넣으면 진동하는 JR 신호의 자기상관이 남고, 분석적 χ² p값은 "과거가 충분하다"고 가정하므로 부풀려진다. GC가 같은 데이터에서 2–3/56이었던 것은 차수 12를 썼기 때문이다.
- KSG TE: AUC 0.790(7 간선 대 17 비간선), 방향 정확도 0.714. C→D(0.090 대 0.098)와 C→E(0.084 대 0.087)는 방향이 뒤집혔다.
- **KSG 유의성의 검정력 한계.** surrogate B개의 최소 p값은 1/(B+1)이다. 24쌍 Bonferroni 임계는 0.05/24 ≈ 0.0021이므로 B ≥ 479가 필요하다. API는 `n_surrogates ≤ 199`(최소 p = 0.005)로 제한하므로, API로 실행한 KSG는 이 Bonferroni 기준을 원리적으로 통과할 수 없다. 파이프라인 평가는 `min_attainable_p`와 `underpowered_surrogate_test`로 이 상황을 표시한다.

**한계.** TE가 유의해도 신호가 A에서 B로 실제로 이동했다고 확정할 수 없다. 공통 원인과 추정 편향에 취약하고, A 고유의 정보뿐 아니라 A와 B 과거의 시너지 정보도 포함할 수 있다. 결과는 선택한 변수·임베딩·시간 척도에 대한 진술이다.

### 4.3 DCM 정신의 선형 유효 연결 모델 (F03) — 어떤 방향 모델이 데이터를 가장 잘 설명하는가?

**질문.** 명시한 후보 모델(forward, backward, bidirectional, none, common_input) 가운데 관측 자료를 상대적으로 가장 잘 설명하는 것은 무엇인가?

**수식.**

$$\dot{\mathbf x}(t)=A\mathbf x(t)+C\mathbf u(t)\;\approx\;\mathbf x_{t+1}=A_d\mathbf x_t+\mathbf e_t,\qquad A=\log(A_d)/\Delta t,\qquad p(m\mid y)\propto e^{-\mathrm{BIC}_m/2}$$

**이것은 SPM DCM이 아니다.** 신경질량·혈역학 관측모델과 변분 베이즈(자유에너지)가 없고, 관측 채널을 잠재 상태로 직접 간주한다. 휴지기이므로 입력 `u`는 알 수 없는 잡음으로 둔다.

**앱의 계산** (`neurobridge.flow.effective`).
- 전체 행렬: `fit_linear_state_space(x, dt)`. VAR(1)을 최소제곱으로 적합하고 `A = logm(A_d)/dt`(1/s)로 변환한다. 실수 로그가 없으면 `(A_d − I)/dt` 근사로 대체하고 플래그를 남긴다.
- 모델 비교: `standard_candidates(...)`로 후보 5개를 만들고, `compare_linear_models(x, dt, candidates, order=p)`가 **마스크된 VAR(p)**를 행별 제약 최소제곱으로 적합한다. p는 모티프마다 `granger.select_order(..., criterion="bic")`로 고른다(결과 필드 `var_order`). 사후확률은 나열한 후보에 대한 균등 사전확률 아래 정규화한 `exp(−BIC/2)`다. `common_input`은 fork처럼 구동자를 지정하면 구동자→두 노드 간선을, 지정하지 않으면 상관된 혁신(`shared_noise`)을 뜻한다.
- 잔차 백색성: `fit_var(..., whiteness_lags=20)`의 채널별 Ljung–Box.

**이 시뮬레이션이 보여준 것.**
- 연속시간 A 행렬(VAR(1), `logm` 변환 성공, 안정, 이산 스펙트럼 반경 0.981): G=10 간선 AUC 0.939, 방향 정확도 6/7(A→F 0.351 < F→A 0.473).
- 모델 비교(BIC가 고른 p는 모든 모티프에서 20이었다. 이 값은 `max_order: 20` 기본 상한과 같다):

| 비교 | G=0 (기대 none) | G=10 (기대) | G=10 선택 (사후확률) |
| --- | --- | --- | --- |
| pair P1·P2 | none (0.906) ✓ | forward | **bidirectional (1.0)** ✗ |
| chain A·B | none (0.862) ✓ | forward | **bidirectional (1.0)** ✗ |
| fork D·E (구동자 C) | none (1.0) ✓ | common_input | common_input (1.0) ✓ |
| convergence P1·F | none (0.983) ✓ | forward | **none (0.989)** ✗ |

- **교훈.** G=0에서는 네 비교가 모두 올바르게 "간선 없음"을 골랐고, fork의 공통 입력도 맞혔다. 하지만 G=10의 pair·chain은 사후확률 1.0으로 bidirectional을, 약한 수렴 간선은 none을 골랐다. 비선형 JR 결합을 선형 VAR로 기술하면 **사후확률이 높아도 방향을 잘못 귀속**할 수 있다. 사후확률은 "나열한 모델 중 상대적으로 낫다"는 뜻이지 정답일 확률이 아니다. 이를 뒷받침하듯 모든 비교에서 잔차 백색성(Ljung–Box, 20 lags)이 모든 채널에서 기각되었고, 결과에 `var1_residuals_not_white` 플래그가 붙었다(VAR(p) 적합에도 같은 이름의 플래그를 쓴다).
- 센서 공간(정답 채점 없음)에서는 G=0에서도 pair·chain·convergence가 common_input(사후확률 1.0), fork가 forward(1.0)를 골랐다. 볼륨 전도로 섞인 채널에는 후보 집합 자체가 맞지 않는다.

**한계.** 실험적 개입 없이 인과를 확증하지 못한다. 후보에 없는 모델(숨은 공통 입력, 비선형성, 센서 혼합)은 평가되지 않는다. 결론은 모델 가정과 후보 선택에 의존한다.

### 4.4 Activity flow mapping (F04) — 연결망을 통한 전파 모델이 목표 활동을 예측하는가?

**질문.** 다른 영역의 활동과 그 영역에서 목표로 가는 연결 가중치만으로 목표 영역의 활동을 예측할 수 있는가?

**수식.**

$$\hat a_j=\sum_{i\ne j}FC_{ij}\,a_i$$

**앱의 계산** (`neurobridge.flow.activity_flow.run_activity_flow`).
- 활동은 5–13 Hz envelope(Butterworth band-pass 후 Hilbert 진폭)이다.
- 시간을 연속 구간 TRAIN 60% | 1 s gap | TEST로 나누고, 활동은 구간별로 따로 계산한다(필터가 구간을 넘지 않음). z-score에는 TRAIN의 평균·표준편차만 쓴다.
- FC는 TRAIN에서만 추정한다. Pearson 상관과 ridge 회귀 FC(α = 1) 두 가지이며, 목표 채널은 항상 예측자에서 빠진다.
- 센서 데이터에서는 `neighbors_within_radius(positions, 0.05)`로 반경 5 cm 안의 이웃 전극도 예측자에서 뺀다(볼륨 전도 완화). 이웃을 빼지 않은 결과도 함께 낸다.
- 점수: TEST 구간에서 채널별 r과 R²(clipping 없음, 음수 가능).

**이 시뮬레이션이 보여준 것** (채널 평균, TEST 구간).

| 데이터셋 | Pearson r | Pearson R² | 회귀 r | 회귀 R² |
| --- | --- | --- | --- | --- |
| 소스 G=10 | 0.475 | 0.226 | 0.513 | 0.318 |
| 소스 G=0 | −0.059 | −0.066 | −0.054 | −0.064 |
| 센서 G=10, 이웃 제외 | 0.695 | **−27.4** | 0.953 | 0.908 |
| 센서 G=10, 이웃 포함 | 0.768 | −34.8 | 0.979 | 0.957 |
| 센서 G=0, 이웃 제외 | 0.720 | −4.69 | 0.922 | 0.846 |
| 센서 G=0, 이웃 포함 | 0.822 | −8.35 | 0.968 | 0.936 |

- 소스 공간에서는 결합이 있을 때만 예측이 된다(r ≈ 0.5 대 ≈ −0.06).
- 센서 공간에서는 **결합이 없어도** 회귀 r이 0.92였다. 32채널이 8개 소스의 혼합이므로 한 채널을 다른 채널로 예측할 수 있고, 이것은 전파가 아니라 볼륨 전도다. 5 cm 이웃 제외는 점수를 조금 낮출 뿐 이 효과를 없애지 못했다.
- **Pearson-FC R² 척도 주의.** Pearson FC 예측은 많은 상관을 단순 합산하므로 예측값의 크기(척도)가 실제와 어긋난다. 센서처럼 강하게 섞인 데이터에서는 r이 높아도 R²가 크게 음수(−27.4)가 될 수 있다. 이런 경우에는 r로 판단한다(결과 필드 `primary_score: "r"`, `score_note`).

**한계.** 정적 FC를 쓰는 기본 activity flow는 시간적 방향성을 직접 측정하지 않는다. 실제 신경 신호의 이동을 추적하는 기술이 아니라 "연결망을 통한 전파 모델의 예측력"을 검증하는 방법이다. 원래 방법은 과제 활성 예측(주로 fMRI)이며, 여기서는 휴지기 envelope의 시간 변동을 예측하는 변형이다.

### 4.5 Partial information decomposition (F05 · Level 3) — 두 입력의 정보가 어떻게 합쳐지는가?

**질문.** 두 소스 A, B가 목표 C에 주는 정보가 중복(R), 고유(U_A, U_B), 시너지(S) 중 무엇인가?

**수식.**

$$I(A,B;C)=R+U_A+U_B+S,\qquad R_{\text{MMI}}=\min\{I(A;C),\,I(B;C)\},\qquad S = I(A,B;C) - I(A;C) - I(B;C) + R$$

**앱의 계산** (`neurobridge.flow.pid`).
- 신호에는 `time_lagged_pid(x, source_a, source_b, target, lag=1, history=2)`를 쓴다. S1은 a의 과거(`t−lag`부터 `history`샘플), S2는 b의 과거, T는 `x[target, t]`이다. **목표 자신의 과거는 조건화하지 않는다.** 내부적으로는 Gaussian MMI-PID(`gaussian_pid`, `gaussian_pid_from_cov`)를 쓴다.
- 이산 교육 예제에는 Williams–Beer I_min을 쓴다: `discrete_pid_williams_beer`, `teaching_examples()`. 연속 예제는 `integration_demo()`이다.
- 분석할 세 변수는 레시피의 `analysis.pid_triplets`(가설)로 지정한다: `convergence_F`(P1, A → F)와 `fork_D`(C, E → D).

**이 시뮬레이션이 보여준 것** (bits, 소스 공간).

| triplet | 조건 | I(S1;T) | I(S2;T) | I(S1,S2;T) | R | U1 | U2 | S |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| convergence_F (P1, A → F) | G=10 | 0.0091 | 0.0109 | 0.0209 | 0.0091 | 0.0000 | 0.0018 | 0.0100 |
| fork_D (C, E → D) | G=10 | 0.5474 | 1.0514 | 1.1969 | 0.5474 | 0.0000 | 0.5041 | 0.1455 |
| convergence_F | G=0 | 0.0010 | 0.0048 | 0.0059 | 0.0010 | 0.0000 | 0.0039 | 0.0011 |
| fork_D | G=0 | 0.0086 | 0.0018 | 0.0102 | 0.0018 | 0.0068 | 0.0000 | 0.0016 |

- 수렴 노드 F가 받는 정보는 G=10에서도 0.02 bit 수준으로 작았다. 이는 GC에서 P1→F, A→F가 약했던 것과 일치한다. 그 작은 정보의 절반가량이 시너지로 분해되었다.
- fork_D에서는 **D를 구동하지 않는 E가 0.50 bit의 "고유 정보"**를 받았다. E와 D는 같은 구동자 C를 공유하고, 목표 자신의 과거를 조건화하지 않으며, PID 항은 "선택한 변수의 예측 정보"에 대한 분해다. 따라서 고유 정보는 간선을 뜻하지 않는다.
- 교육 예제(Williams–Beer I_min, bits): XOR은 S = 1, AND는 R = 0.311·S = 0.5, unique(T = X1)는 U1 = 1, redundant는 R = 1, independent는 모두 0이다. `integration_demo`의 "두 입력을 통합하는 목표"는 R 0.355, U1 0.015, S 0.769, 결합 정보 1.140이었다.
- **측도 의존성 (I_min COPY).** 2비트 COPY(T = (X1, X2))에 I_min은 **R = 1, S = 1 bit(U1 = U2 = 0)**를 준다. 직관적인 답 U1 = U2 = 1 bit는 BROJA나 I_ccs 측도의 값이다(Harder et al. 2013). 이 앱은 BROJA/I_ccs를 구현하지 않는다. PID 수치는 어느 중복정보 측도를 썼는지와 함께 읽어야 한다.

**한계.** 측도마다 답이 다르다. 고차원 추정과 해석이 어렵고, Gaussian 가정은 비선형 JR 신호의 정보를 과소평가할 수 있다. 정보의 "내용"(Level 2)은 여전히 측정하지 않는다.

---

## 5. 주의점 요약

### 5.1 거짓 양성과 볼륨 전도 (결합이 없는 G=0에서)

| 무엇을 | 결과 | 출처 |
| --- | --- | --- |
| 소스 쌍별 GC | 2/56 | preview |
| 소스 조건부 GC | 3/56 | preview |
| 소스 Gaussian TE (k = l = 2) | 21/56 | preview |
| 센서 쌍별 GC 유의 비율 | 0.717 | preview |
| 센서 activity flow 회귀 r (이웃 제외) | 0.922 | preview |
| 센서 모델 비교 | 4개 모두 none이 아닌 모델(common_input 3개, forward 1개)을 사후확률 1.0으로 선택 | preview |
| 소스 조건부 GC, 영위상 high-pass | **35/56** (쌍별 GC 42/56, 센서 쌍별 GC 유의 비율 0.908, 모델 비교 4개 중 3개 오답) | preview에서 `highpass_phase: "zero_phase"`만 바꾼 실행 `flow-39894e4a70-ce801e` |

### 5.2 기준전극

full 레시피(`fixtures/recipes/flow-full.json`)는 reference `none`과 `average`를 모두 관측한다. 평균 기준전극은 데이터의 rank를 하나 줄인다(R_avg = I − 11ᵀ/n). 이때 조건부 GC는 `invalid_input/rank_deficient`가 될 수 있고, 계산하지 못한 값은 0이 아니라 상태로 남는다. 이 문서 작성 중에는 full 레시피를 실행하지 않았다.

### 5.3 예측은 인과가 아니다

이 실습의 모든 방법은 관측 자료만 쓴다. 인과적 전파의 강한 증거는 개입(TMS–EEG, 전기 자극, perturbation)에서 나온다. 개입에서 보는 것도 자연 상태의 정보 흐름이 아니라 자극이 유도한 반응의 전파다.

---

## 6. 실행 방법

**CLI** (`neurosignal-recipe flow`):

```bash
uv sync --extra dev --extra simulation                 # TVB가 있어야 시뮬레이션 가능
uv run neurosignal-recipe flow concepts                # 한국어 개념 카탈로그 JSON (16개 항목)
uv run neurosignal-recipe flow concepts --id pid       # 한 항목만
uv run neurosignal-recipe flow run fixtures/recipes/flow-preview.json --root /tmp/nsflow [--run-id ID] [--json]
uv run neurosignal-recipe flow run fixtures/recipes/flow-full.json --root /tmp/nsflow   # 120 s, average reference, 19 KSG surrogate
```

결과는 `<root>/benchmarks/<run_id>/flow_result.json`과 배열 artifact로 저장된다.

**API** (`apps/api/neurobridge_api/routes/flow.py`, prefix `/flow`; 웹 dev 서버에서는 `/api/flow/...`).

| Endpoint | 용도 |
| --- | --- |
| `GET /flow/concepts`, `GET /flow/concepts/{concept_id}` | 개념 카탈로그 |
| `POST /flow/validate` | 레시피 검사와 비용 추정 (`ok`, `errors`, `warnings`, `cost`) |
| `POST /flow/runs` | spawn worker로 실행 시작 (202; 동시 실행 2개 초과 시 409) |
| `GET /flow/runs`, `GET /flow/runs/{run_id}?include_result=` | 목록과 상태·결과 |
| `POST /flow/runs/{run_id}/cancel` | 단계 사이에서 협조적으로 취소 |

API 제한은 `duration_s ≤ 300`, `te.n_surrogates ≤ 199`다. 저장 루트는 `$NEUROSIGNAL_BENCHMARK_ROOT`(설정 시) 아래 `flow/`다.

**웹 실험실.** 8번째 Lab "Information Flow"(제목 "연결성은 정보 흐름인가?", `apps/web/src/features/flow/`, 진입점 `FlowWorkbench.tsx`)이 `LabNavigator.tsx`·`App.tsx`(지연 로딩)에 연결되어 있다. 개념 탭(SC/FC/방향성·유효 연결/정보 흐름, Level 1–3), 알려진 8-노드 그래프와 실행 설정(G, 길이, seed, 16/32 센서, 기준전극, causal/zero-phase high-pass), 방법별 카드(질문·수식·직관·결과·한계), 센서 대 소스 비교 탭을 제공한다. 웹 테스트는 `npm test`(15 파일·65 테스트)로 돌린다.

**테스트.**

```bash
uv run python -m pytest tests/oracle/test_flow_directed.py tests/oracle/test_flow_effective.py \
  tests/oracle/test_flow_pid.py tests/integration/test_flow_pipeline.py tests/integration/test_flow_api.py
```

## 7. 원문 출력 (이 문서의 수치 출처)

```text
flow run flow-70de3a216c-1118ea  profile preview  total 114.0s  frozen sha256 974bd4f411ca
  simulation coupled  G=10  PSD peaks Hz [6.8, 6.8, 6.8, 6.8, 6.8, 6.5, 6.5, 9.8]
  simulation control  G=0  PSD peaks Hz [6.8, 6.8, 6.8, 6.8, 7.0, 6.8, 7.0, 6.8]

source-space evaluation (truth used only here, after freezing):
  [coupled G=10] gc_pairwise: AUC=0.892 dir=1 TP=7 FP=23 | gc_conditional: AUC=0.901 dir=0.857 TP=6 FP=13 | te_gaussian: AUC=0.895 dir=1 TP=7 FP=33 | te_ksg: AUC=0.79 dir=0.714 | effective_model: AUC=0.939 dir=0.857
    model pair_P1_P2         best=bidirectional expected=forward match=False
    model chain_A_B          best=bidirectional expected=forward match=False
    model fork_D_E           best=common_input expected=common_input match=True
    model convergence_P1_F   best=none expected=forward match=False
  [control G=0] gc_pairwise: TP=0 FP=2 | gc_conditional: TP=0 FP=3 | te_gaussian: TP=0 FP=21
    model pair_P1_P2 / chain_A_B / fork_D_E / convergence_P1_F: best=none expected=none match=True

sensor space (no truth scoring; G=0 structure = volume conduction/reference/noise):
  [coupled G=10 ref=none] pairwise GC sig frac=0.996 conditional GC sig frac=0.382
  [control G=0 ref=none] pairwise GC sig frac=0.717 conditional GC sig frac=0.381
```

네 데이터셋 모두 GC·TE·유효 모델·activity flow·PID가 `ok`였고, `level2_content_decoding`은 `not_applicable/no_stimulus_labels`였다. 위 출력은 CLI 요약을 줄인 것이다(G=0 행의 AUC "—"와 모델 비교 4줄을 한 줄로 합침). 나머지 수치는 같은 실행의 `flow_result.json`에서 읽었다.
