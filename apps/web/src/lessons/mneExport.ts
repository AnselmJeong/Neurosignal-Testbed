// P2-3: "do what this lab did, with MNE, on your own recording". Each generator turns the lab's
// current recipe into a short Python script. The values come from the recipe, the calls are the
// ones the analysis server makes, and the comments say where the script differs from the lab.
import type { QeegRecipe } from '../lib/qeeg'
import type { ConnectivityRecipe, ExperimentRecipe, IcaRecipe, SourceModelRecipe } from '../types'

const py = (value: number | null | undefined) => (value === null || value === undefined ? 'None' : Number.isInteger(value) ? `${value}.0` : String(value))

const HEADER = (lab: string) => `# ${lab}: 이 Lab이 한 일을 MNE-Python으로 직접 하는 코드
# Neurosignal Testbed에서 내보냄. 값은 화면의 현재 설정에서 왔습니다.
# 필요한 패키지: mne${lab.includes('03') || lab.includes('06') ? ', mne-connectivity' : ''}
import mne
import numpy as np
`

const LOAD = `
# 1) 자료 불러오기: 내 기록의 경로로 바꾸세요(EDF, BDF, FIF, BrainVision 등).
raw = mne.io.read_raw("my_recording.edf", preload=True)
raw.pick("eeg")
`

export function filterScript(recipe: ExperimentRecipe): string {
  const p = recipe.preprocessing
  const lines = [HEADER('Lab 01 · 표본화와 필터'), LOAD]
  lines.push(`
# 2) 표본화율 바꾸기: Lab에서는 ${recipe.simulation.sampling_rate_hz} Hz로 만들었습니다.
#    resample은 먼저 anti-aliasing 저역 통과를 겁니다. Lab 01은 접힘을 보이려고 이 단계를 뺐습니다.
raw.resample(${py(recipe.simulation.sampling_rate_hz)})
`)
  if (p.reference === 'average') lines.push(`
# 3) 평균 기준전극
raw.set_eeg_reference("average", projection=False)
`)
  const band = p.highpass_hz !== null || p.lowpass_hz !== null
  if (band) lines.push(`
# 4) 영위상 Butterworth 필터(차수 ${p.filter_order}). MNE의 IIR 필터는 앞뒤로 두 번 걸어 위상을 보존합니다.
raw.filter(l_freq=${py(p.highpass_hz)}, h_freq=${py(p.lowpass_hz)}, method="iir",
           iir_params=dict(order=${p.filter_order}, ftype="butter"))
`)
  if (p.notch_hz !== null) lines.push(`
# 5) 전원 잡음 노치(${p.notch_hz} Hz). Lab은 Q=30 IIR 노치를 씁니다. Nyquist(${recipe.simulation.sampling_rate_hz / 2} Hz) 이상이면 MNE가 거부합니다.
raw.notch_filter(${py(p.notch_hz)}, method="iir")
`)
  lines.push(`
# 6) Welch 파워 스펙트럼: Lab의 "02 스펙트럼" 그림
spectrum = raw.compute_psd(method="welch", fmax=raw.info["sfreq"] / 2)
spectrum.plot(average=True)
`)
  return lines.join('')
}

export function icaScript(recipe: IcaRecipe): string {
  return `${HEADER('Lab 02 · ICA')}${LOAD}raw.set_montage("standard_1020", on_missing="ignore")  # 지형도를 그리려면 전극 위치가 필요합니다
${recipe.reference === 'average' ? `
# 2) 평균 기준전극. 평균 기준은 rank를 1 줄이므로 성분 수가 채널 수 − 1을 넘을 수 없습니다.
raw.set_eeg_reference("average", projection=False)
` : ''}
# 3) 적합용 사본: ${recipe.fit_highpass_hz}–${recipe.fit_lowpass_hz} Hz로 거른 복사본에 ICA를 맞춥니다.
#    원본(raw)은 거르지 않은 채로 두고, 찾은 성분을 원본에 적용합니다.
fit_raw = raw.copy().filter(l_freq=${py(recipe.fit_highpass_hz)}, h_freq=${py(recipe.fit_lowpass_hz)}, method="iir",
                            iir_params=dict(order=4, ftype="butter"))
rank = mne.compute_rank(raw, rank=None)["eeg"]

# 4) ICA 적합(${recipe.algorithm === 'infomax' ? 'extended Infomax' : 'FastICA'}, 성분 ${recipe.component_count}개, seed ${recipe.seed})
ica = mne.preprocessing.ICA(n_components=min(${recipe.component_count}, rank), method="${recipe.algorithm}",
                            ${recipe.algorithm === 'infomax' ? 'fit_params=dict(extended=True), ' : ''}random_state=${recipe.seed}, max_iter="auto")
ica.fit(fit_raw)

# 5) 네 가지 확인: 지형도, 시계열, 스펙트럼, 분산. Lab의 성분 카드와 같은 그림입니다.
ica.plot_components()
ica.plot_sources(raw)
ica.plot_properties(raw, picks=[0, 1])

# 6) 제외할 성분을 직접 고르고 원본의 복사본에 적용합니다.
#    번호는 seed와 자료에 따라 바뀝니다. 위의 그림을 보고 정하세요.
ica.exclude = [0]
cleaned = ica.apply(raw.copy())
cleaned.plot()
`
}

export function connectivityScript(recipe: ConnectivityRecipe): string {
  const metric = recipe.metric === 'pearson' ? 'coh' : recipe.metric
  return `${HEADER('Lab 03 · 연결성')}from mne_connectivity import spectral_connectivity_epochs
${LOAD}${recipe.reference === 'average' ? `raw.set_eeg_reference("average", projection=False)
` : ''}
# 2) ${recipe.epoch_duration_s}초 길이 epoch로 자르기(Lab은 epoch ${recipe.epoch_count}개)
epochs = mne.make_fixed_length_epochs(raw, duration=${py(recipe.epoch_duration_s)}, preload=True)

# 3) ${recipe.band_low_hz}–${recipe.band_high_hz} Hz 대역의 ${metric.toUpperCase()}, ${recipe.spectral_mode} 스펙트럼 추정
con = spectral_connectivity_epochs(epochs, method="${metric}", mode="${recipe.spectral_mode}",
                                   fmin=${py(recipe.band_low_hz)}, fmax=${py(recipe.band_high_hz)}, faverage=True)
matrix = np.abs(con.get_data(output="dense")[:, :, 0])
matrix = matrix + matrix.T
${recipe.metric === 'pearson' ? '# Lab의 Pearson 상관은 시계열 상관이라 스펙트럼 지표가 아닙니다. 여기서는 coherence로 바꿨습니다.\n' : ''}
# 4) 비교 대상(대리자료): epoch 짝을 섞어 관계를 끊고 같은 값을 ${recipe.surrogate_count}번 계산합니다.
rng = np.random.default_rng(${recipe.seed})
data = epochs.get_data()
null = []
for _ in range(${recipe.surrogate_count}):
    shuffled = np.stack([data[rng.permutation(len(data)), ch] for ch in range(data.shape[1])], axis=1)
    c = spectral_connectivity_epochs(shuffled, method="${metric}", mode="${recipe.spectral_mode}", sfreq=epochs.info["sfreq"],
                                     fmin=${py(recipe.band_low_hz)}, fmax=${py(recipe.band_high_hz)}, faverage=True, verbose=False)
    m = np.abs(c.get_data(output="dense")[:, :, 0])
    null.append(m + m.T)
threshold = np.percentile(null, 95, axis=0)
print("우연의 95% 경계를 넘는 쌍:", np.argwhere(np.triu(matrix > threshold, 1)))
`
}

export function sourceScript(recipe: SourceModelRecipe): string {
  return `${HEADER('Lab 04 · 원천 추정')}${LOAD}
# 2) 전극 위치와 평균 기준(역해에는 평균 기준 projection이 필요합니다)
raw.set_montage("standard_1020", on_missing="ignore")
raw.set_eeg_reference("average", projection=True)

# 3) 순방향 모형: Lab과 같은 90 mm 구형 머리와 ${recipe.grid_spacing_mm} mm 부피 격자.
#    실제 분석에서는 개인 MRI나 fsaverage BEM을 쓰세요. 구형 모형은 교육용 근사입니다.
src = mne.setup_volume_source_space(subject=None, pos=${py(recipe.grid_spacing_mm)}, sphere=(0.0, 0.0, 0.0, 0.08), exclude=0.01)
sphere = mne.make_sphere_model(r0=(0.0, 0.0, 0.0), head_radius=0.09)
fwd = mne.make_forward_solution(raw.info, trans=None, src=src, bem=sphere, meg=False, eeg=True)
fwd = mne.convert_forward_solution(fwd, force_fixed=True)

# 4) Minimum-norm 역해, λ² = ${recipe.inverse.lambda2}
noise_cov = mne.make_ad_hoc_cov(raw.info)
inv = mne.minimum_norm.make_inverse_operator(raw.info, fwd, noise_cov, loose=0, depth=None)
stc = mne.minimum_norm.apply_inverse_raw(raw, inv, lambda2=${recipe.inverse.lambda2}, method="MNE")

# 5) ${recipe.alpha_frequency_hz} Hz 근처 대역 파워 지도와 봉우리. Lab은 봉우리 문턱 ${recipe.inverse.peak_threshold}, 최소 간격 ${recipe.inverse.peak_separation_mm} mm를 씁니다.
from scipy.signal import welch
f, pxx = welch(stc.data, fs=raw.info["sfreq"], nperseg=int(raw.info["sfreq"] * 2))
band = (f >= ${py(recipe.alpha_frequency_hz - 2)}) & (f <= ${py(recipe.alpha_frequency_hz + 2)})
power = pxx[:, band].sum(axis=1)
positions_mm = src[0]["rr"][stc.vertices[0]] * 1000
print("가장 센 점(mm):", positions_mm[np.argmax(power)])

# 6) 해상도 행렬: 이 방법의 "시력". 열 하나가 점 원천 하나가 퍼져 보이는 모양입니다.
resolution = mne.minimum_norm.make_inverse_resolution_matrix(fwd, inv, method="MNE", lambda2=${recipe.inverse.lambda2})
`
}

export function qeegScript(recipe: QeegRecipe): string {
  return `${HEADER('Lab 06 · QEEG')}${LOAD}
# 2) 기준전극: ${recipe.reference === 'average' ? '평균 기준' : '연결 유양돌기(linked mastoids). M1·M2(또는 A1·A2) 채널 이름을 맞추세요.'}
${recipe.reference === 'average' ? 'raw.set_eeg_reference("average", projection=False)' : 'raw.set_eeg_reference(["M1", "M2"], projection=False)'}
raw.set_montage("standard_1020", on_missing="ignore")

# 3) Welch 스펙트럼과 대역 파워(Lab과 같은 대역 경계)
bands = {"delta": (1, 4), "theta": (4, 8), "alpha": (8, 13), "beta": (13, 30), "gamma": (30, 45)}
spectrum = raw.compute_psd(method="welch", fmin=1, fmax=45)
psd, freqs = spectrum.get_data(return_freqs=True)
df = freqs[1] - freqs[0]
absolute = {name: psd[:, (freqs >= lo) & (freqs < hi)].sum(axis=1) * df for name, (lo, hi) in bands.items()}
total = sum(absolute.values())
relative = {name: value / total for name, value in absolute.items()}
theta_beta = absolute["theta"] / absolute["beta"]

# 4) 두피 지도: 상대 알파 파워
mne.viz.plot_topomap(relative["alpha"], raw.info, names=raw.ch_names)

# 5) 규준 비교는 참조 집단의 평균과 표준편차가 있어야 합니다. Lab은 합성 집단(${recipe.cohort_size}명)을 씁니다.
#    z = (내 값 − 집단 평균) / 집단 표준편차. 실제 규준 자료 없이 이 값을 임상적으로 읽지 마세요.
`
}
