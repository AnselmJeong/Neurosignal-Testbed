# P0 환경 확인 (2026-11-12)

Python 3.12.11, uv `.venv`. 코어 버전은 변경 없음: numpy 2.5.2, scipy 1.18.1, mne 1.12.1,
mne-connectivity 0.8.1, specparam 2.0.0rc7, pydantic 2.13.5, scikit-learn 1.9.0.

## optional group과 설치 버전

| group | 패키지 | 설치 버전 | import | 최소 계산 |
| --- | --- | --- | --- | --- |
| simulation | tvb-library | 2.10.0 | OK | JansenRit 2-node, 1000 ms, HeunStochastic dt=0.1, TemporalAverage period=1.0 → time (1000,), data (1000, 2 voi, 2 node, 1 mode), 전부 유한값 |
| metrics | antropy | 0.2.3 | OK | `perm_entropy(white noise 2000, order=3, normalize=True)` = 0.9998 |
| metrics | bctpy | 0.6.1 | OK | `clustering_coef_wu` 4×4 대칭 가중 행렬 → 길이 4 벡터 |
| pac | tensorpac | 0.6.5 | OK | `Pac(idpac=(1,0,0))` 합성 10/100 Hz 신호 → (2, 2, 10) |
| (core) | mne-connectivity | 0.8.1 | OK | `wsmi(EpochsArray 5×3×500, kernel=3, tau=1)` → EpochConnectivity (5, 9), method `wSMI` |
| information | IDTxl/JIDT | — | 미설치 | unsupported_dependency (아래) |

TVB와 함께 numba 0.68.1, llvmlite 0.50.0, networkx 3.7, numexpr 2.14.2, ipython/ipywidgets가 추가된다. tvb-data는 필요하지 않다(연결 행렬을 직접 구성).

## TVB 관찰 사실 (tvb-library 2.10.0)

- `models.JansenRit.state_variables` = `y0, y1, y2, y3, y4, y5` (순서 고정). 기본 `variables_of_interest` = `y0..y3`.
- `cvar = [1, 2]` → 결합 대상 변수는 y1, y2. `SigmoidalJansenRit.pre`가 `x_j[:,0] - x_j[:,1]`, 즉 y1−y2를 사용한다.
- voi 선택지는 상태변수 이름뿐이며 `"y1 - y2"` 같은 식은 지원하지 않는다. `variables_of_interest=("y1","y2")`로 기록하고 사후에 `y[:,0]-y[:,1]`를 계산한다(출력 축: time, voi, node, mode).
- 결합: `coupling.SigmoidalJansenRit` 기본값 a=1(테스트는 10), r=0.56, midpoint=6.0, cmin=0, cmax=0.005. 결합항은 JR의 y4 식에 `c[0]`으로 들어간다.
- 단위: `integrator.dt` label "Integration-step size (ms)", monitor `period` "Sampling period (ms)"이므로 둘 다 ms. `simulation_length`도 ms. TemporalAverage period=1.0 → 첫 시점 0.5 ms, 1 kHz.
- 연결 방향: `weights[target, source]`. 소스 `Coupling.__call__`에서 `g_ij = history.es_weights`(= `weights[:, na, :, na]`, 축 (to, ncv, from, m)), `(g_ij*pre).sum(axis=2)`로 from 축을 합산한다. 실측: 결정론적 2-node, `w[0,1]=1`만 둘 때 무결합 대비 max|Δ(y1−y2)|가 node0 1.12, node1 0.0이므로 node1→node0.
- `tvb.__version__` 속성은 없다(None). 버전은 패키지 메타데이터로 확인한다.

## wSMI 시그니처 (mne-connectivity 0.8.1)

`wsmi(data, kernel, tau, indices=None, sfreq=None, names=None, tmin=None, tmax=None, anti_aliasing='auto', weighted=True, average=False, verbose=None)`
kernel과 tau는 필수 인자다. `average=False`이면 epoch별 결과(EpochConnectivity), 기본은 전체 채널쌍(n×n 평탄화)이다.

## 설치하지 않은 패키지

- **IDTxl (information group): unsupported_dependency.** PyPI에 없다(`idtxl was not found in the package registry`).
  git 소스(1.6.1, c7eacfd)의 setup.py는 Cython·numpy를 build 의존성으로 선언하지 않아 격리 빌드가
  `ModuleNotFoundError: No module named 'Cython'`로 실패한다. 수동 빌드는 가능하지만 install_requires가 없어
  jpype1, statsmodels, h5py, mpmath, matplotlib, setuptools<81(pkg_resources)을 직접 맞춰야 한다. pyopencl이 없으면
  `estimators_opencl`이 `sys.exit()`를 호출해 `BivariateTE.analyse_single_target`이 exit 0으로 조용히 종료한다.
  JIDT 추정기 자체(`JidtKraskovCMI.estimate`, Java 17)는 동작했다. 선언형 optional group으로 잠글 수 없어 제외하며,
  TE·MI는 capability에 unsupported_dependency로 표시한다.
