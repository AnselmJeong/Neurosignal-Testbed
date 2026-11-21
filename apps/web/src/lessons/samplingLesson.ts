// Lab 01 teaching content: graded predictions and "Try this" experiments.
// The experiment table follows the app manual (Lab 01 · 실험 과제). Each expected outcome
// was checked against the analysis engine with the default recipe (seed 42).
import { defaultRecipe, type ExperimentRecipe, type ExperimentResult } from '../types'

export interface PredictionChoice {
  id: string
  text: string
}

export interface GradedPrediction {
  question: string
  choices: PredictionChoice[]
  correct: string
  /** Shown after reveal, whichever choice was made. */
  explanation: string
}

export interface SamplingSettings {
  sampling_rate_hz: number
  noise_uv: number
  highpass_hz: number
  lowpass_hz: number
  reference: 'average' | 'none'
}

export interface SamplingExperiment {
  id: string
  title: string
  /** One-line description of the single change, e.g. "Sampling rate 250 → 100 Hz". */
  change: string
  settings: Partial<SamplingSettings>
  view: 'Channel detail' | 'Filter response'
  /** Where to look after the run. Must not give away the answer. */
  lookAt: string
  /** What the experiment teaches; shown after reveal. */
  learn: string
  prediction: GradedPrediction
}

export const BASELINE_PREDICTION: GradedPrediction = {
  question: '기본 설정(표본화율 250 Hz, 1–40 Hz 필터)으로 처리하면 처리 후 스펙트럼에 뚜렷이 남는 봉우리는?',
  choices: [
    { id: 'all', text: '2 · 10 · 60 Hz 세 봉우리가 모두 남는다' },
    { id: 'two-ten', text: '2 Hz와 10 Hz는 남고 60 Hz는 크게 줄어든다' },
    { id: 'ten-only', text: '10 Hz만 남고 2 Hz와 60 Hz는 모두 사라진다' },
  ],
  correct: 'two-ten',
  explanation: '2 Hz와 10 Hz는 통과대역(1–40 Hz) 안에 있어 남는다. 60 Hz는 40 Hz 저역 통과(Low-pass)와 60 Hz 노치(Notch) 때문에 60 dB 넘게 줄어든다. 1 Hz 고역 통과(High-pass)는 2 Hz를 거의 건드리지 않는다.',
}

export const SAMPLING_EXPERIMENTS: SamplingExperiment[] = [
  {
    id: 'alias-100',
    title: '표본화율을 100 Hz로 낮추기',
    change: '표본화율(Sampling rate) 250 → 100 Hz',
    settings: { sampling_rate_hz: 100 },
    view: 'Channel detail',
    lookAt: '02 스펙트럼에서 회색 점선(처리 전) 중 30–50 Hz 구간과, 오른쪽 경고 카드를 보세요.',
    learn: 'Nyquist 주파수(표본화율의 절반, 50 Hz)보다 빠른 60 Hz는 사라지지 않고 |60 − 100| = 40 Hz로 접힌다(aliasing). 접힌 성분은 원래 40 Hz였던 신호와 구별할 수 없어서 나중에 어떤 필터로도 가려낼 수 없다. 그래서 실제 장비는 표본화 전에 anti-aliasing 필터를 건다.',
    prediction: {
      question: '표본화율을 100 Hz로 낮추면 처리 전(Raw) 스펙트럼의 60 Hz 봉우리는?',
      choices: [
        { id: 'vanish', text: '사라진다' },
        { id: 'fold-40', text: '40 Hz에 나타난다' },
        { id: 'stay-60', text: '60 Hz에 그대로 보인다' },
      ],
      correct: 'fold-40',
      explanation: '100 Hz 표본화의 Nyquist 주파수는 50 Hz다. 60 Hz는 50 Hz 선에서 반사되어 40 Hz에 나타난다. 40 Hz는 저역 통과 차단 주파수와 같아서 처리 후에도 일부가 남고, 60 Hz 노치는 Nyquist 이상이라 적용되지 않는다.',
    },
  },
  {
    id: 'nyquist-150',
    title: '표본화율 150 Hz에서 확인하기',
    change: '표본화율(Sampling rate) 250 → 150 Hz',
    settings: { sampling_rate_hz: 150 },
    view: 'Channel detail',
    lookAt: '02 스펙트럼의 가로축 끝(Nyquist)과 60 Hz 부근을 함께 보세요.',
    learn: 'Nyquist 조건: 표본화율이 신호 주파수의 두 배를 넘으면(150 > 2 × 60) 성분이 제자리에 표현된다.',
    prediction: {
      question: '표본화율 150 Hz에서 처리 전 스펙트럼의 60 Hz 봉우리는 어디에 보이는가?',
      choices: [
        { id: 'stay-60', text: '60 Hz 제자리에 보인다' },
        { id: 'fold-90', text: '90 Hz로 옮겨 간다' },
        { id: 'fold-30', text: '30 Hz로 접힌다' },
      ],
      correct: 'stay-60',
      explanation: '150 Hz 표본화의 Nyquist 주파수는 75 Hz이므로 60 Hz는 접히지 않는다. 스펙트럼의 가로축도 75 Hz에서 끝난다.',
    },
  },
  {
    id: 'lowpass-90',
    title: '저역 통과를 90 Hz로 올리기',
    change: '저역 통과(Low-pass) 40 → 90 Hz',
    settings: { lowpass_hz: 90 },
    view: 'Filter response',
    lookAt: '필터 응답(Filter response) 곡선의 60 Hz 부근 모양을 보고, 채널 상세로 돌아가 처리 후 스펙트럼의 60 Hz를 확인하세요.',
    learn: '저역 통과는 차단 주파수 위를 넓게 줄이고, 노치는 한 주파수만 좁게 겨냥한다. 이 Lab에는 Q = 30인 60 Hz 노치가 항상 함께 걸려 있다.',
    prediction: {
      question: '저역 통과를 90 Hz로 올리면 처리 후 신호의 60 Hz는?',
      choices: [
        { id: 'pass', text: '통과대역 안이므로 그대로 남는다' },
        { id: 'notch', text: '노치가 60 Hz만 좁게 깎아 여전히 크게 줄어든다' },
        { id: 'shift', text: '90 Hz로 옮겨 간다' },
      ],
      correct: 'notch',
      explanation: '60 Hz는 이제 저역 통과의 통과대역 안에 있지만, 60 Hz 노치가 약 25–30 dB 줄인다. 필터 응답에서 60 Hz에 좁은 골이 보이고 그 주변 주파수는 그대로 통과한다.',
    },
  },
  {
    id: 'lowpass-15',
    title: '저역 통과를 15 Hz로 낮추기',
    change: '저역 통과(Low-pass) 40 → 15 Hz',
    settings: { lowpass_hz: 15 },
    view: 'Filter response',
    lookAt: '필터 응답의 10–20 Hz 구간 기울기를 보고, 채널 상세에서 10 Hz 봉우리를 확인하세요.',
    learn: '필터는 차단 주파수에서 칼처럼 잘리지 않는다. 차단 주파수 근처에는 이득이 서서히 변하는 전이 대역(transition band)이 있다.',
    prediction: {
      question: '저역 통과 15 Hz에서 10 Hz 알파 봉우리는?',
      choices: [
        { id: 'keep', text: '거의 그대로 남는다' },
        { id: 'vanish', text: '완전히 사라진다' },
        { id: 'grow', text: '오히려 커진다' },
      ],
      correct: 'keep',
      explanation: '10 Hz는 차단 주파수 15 Hz 아래라 거의 그대로 남는다(필터만의 감쇠는 1 dB 미만). 대신 20 Hz 이상은 20 dB 넘게 줄어든다. 전이 대역은 필터 응답에서 15 Hz 근처의 완만한 경사로 보인다.',
    },
  },
  {
    id: 'highpass-8',
    title: '고역 통과를 8 Hz로 올리기',
    change: '고역 통과(High-pass) 1 → 8 Hz',
    settings: { highpass_hz: 8 },
    view: 'Channel detail',
    lookAt: '02 스펙트럼의 2 Hz와 10 Hz 봉우리를 처리 전·후로 비교하고, 01 신호 아래의 "제거된 것"을 보세요.',
    learn: '고역 통과를 높이면 느린 drift는 사라지지만, 차단 주파수가 관심 리듬에 가까워지면 그 리듬도 깎이기 시작한다. 과도한 고역 통과는 관심 신호를 왜곡한다.',
    prediction: {
      question: '고역 통과를 8 Hz로 올리면 2 Hz drift와 10 Hz 알파는?',
      choices: [
        { id: 'drift-gone', text: '2 Hz는 사라지고 10 Hz는 대부분 남는다' },
        { id: 'both-gone', text: '둘 다 사라진다' },
        { id: 'both-stay', text: '둘 다 그대로 남는다' },
      ],
      correct: 'drift-gone',
      explanation: '2 Hz는 90 dB 가까이 줄어 사라진다. 10 Hz는 차단 주파수 8 Hz 바로 위에 있어 대부분 남지만, 전이 대역에 걸쳐 조금 깎이기 시작한다.',
    },
  },
  {
    id: 'reference-none',
    title: '기준전극을 바꾸기',
    change: '기준전극(Reference) Average → None',
    settings: { reference: 'none' },
    view: 'Channel detail',
    lookAt: '캔버스 아래 03 원천 가중치(Source weights)의 Raw와 처리 후(Processed) 값을 비교하세요.',
    learn: '평균 기준(Average reference)은 모든 채널에서 같은 시점의 채널 평균을 뺀다. 그래서 각 채널에 원천이 섞인 유효 가중치가 바뀌고, 봉우리 높이도 채널마다 다르게 변한다.',
    prediction: {
      question: '기준전극을 None으로 바꾸면 원천 가중치의 처리 후(Processed) 값은?',
      choices: [
        { id: 'equal-raw', text: 'Raw 값과 같아진다' },
        { id: 'zero', text: '모두 0이 된다' },
        { id: 'unchanged', text: 'Average일 때와 똑같다' },
      ],
      correct: 'equal-raw',
      explanation: '재기준화를 하지 않으면 처리 후 가중치는 원래 혼합 가중치(Raw)와 같다. 시간 필터는 가중치를 바꾸지 않는다.',
    },
  },
  {
    id: 'background-20',
    title: '배경 활동을 키우기',
    change: 'EEG 배경 활동(EEG background) 4 → 20 µV',
    settings: { noise_uv: 20 },
    view: 'Channel detail',
    lookAt: '02 스펙트럼에서 봉우리가 주변 배경보다 얼마나 솟아 있는지 보세요.',
    learn: '봉우리를 찾을 수 있는지는 신호 대 잡음비(SNR)가 정한다. 1/f 배경은 낮은 주파수일수록 크므로 느린 성분이 먼저 묻힌다.',
    prediction: {
      question: '배경 활동을 20 µV로 키우면 2 Hz와 10 Hz 봉우리는?',
      choices: [
        { id: 'sharper', text: '더 뚜렷해진다' },
        { id: 'buried', text: '배경에 묻혀 덜 두드러진다' },
        { id: 'shift', text: '다른 주파수로 옮겨 간다' },
      ],
      correct: 'buried',
      explanation: '원천의 진폭은 그대로지만 배경이 커져서 봉우리가 배경 위로 솟은 높이가 10 dB 이상 줄어든다. 주파수 위치는 바뀌지 않는다.',
    },
  },
]

export function settingsOf(recipe: ExperimentRecipe): SamplingSettings {
  return {
    sampling_rate_hz: recipe.simulation.sampling_rate_hz,
    noise_uv: recipe.simulation.noise_uv,
    highpass_hz: recipe.preprocessing.highpass_hz ?? 0,
    lowpass_hz: recipe.preprocessing.lowpass_hz ?? 0,
    reference: recipe.preprocessing.reference,
  }
}

/** Default recipe with only the experiment's one change applied. */
export function experimentRecipe(experiment: SamplingExperiment | null): ExperimentRecipe {
  const recipe = structuredClone(defaultRecipe)
  if (!experiment) return recipe
  const { sampling_rate_hz, noise_uv, highpass_hz, lowpass_hz, reference } = experiment.settings
  if (sampling_rate_hz !== undefined) recipe.simulation.sampling_rate_hz = sampling_rate_hz
  if (noise_uv !== undefined) recipe.simulation.noise_uv = noise_uv
  if (highpass_hz !== undefined) recipe.preprocessing.highpass_hz = highpass_hz
  if (lowpass_hz !== undefined) recipe.preprocessing.lowpass_hz = lowpass_hz
  if (reference !== undefined) recipe.preprocessing.reference = reference
  return recipe
}

/** A prediction is graded only when the run used exactly the settings the question assumes. */
export function matchesExperiment(recipe: ExperimentRecipe, experiment: SamplingExperiment | null): boolean {
  const expected = settingsOf(experimentRecipe(experiment))
  const actual = settingsOf(recipe)
  return (Object.keys(expected) as (keyof SamplingSettings)[]).every((key) => expected[key] === actual[key])
}

/** Frequency at which a sampled sinusoid appears: |f − k·fs| with k = round(f / fs). */
export function aliasFrequency(frequencyHz: number, samplingRateHz: number): number {
  return Math.abs(frequencyHz - Math.round(frequencyHz / samplingRateHz) * samplingRateHz)
}

export interface PeakChange {
  label: string
  plantedHz: number
  observedHz: number
  changeDb: number
}

/** Processed-minus-raw power change (dB) at each planted source's observed frequency. */
export function peakChanges(result: ExperimentResult, channelName: string): PeakChange[] {
  const frequencies = result.spectrum.frequency_hz
  const raw = result.spectrum.raw_power_by_channel?.[channelName] ?? []
  const processed = result.spectrum.filtered_power_by_channel?.[channelName] ?? []
  if (!frequencies.length || !raw.length || !processed.length) return []
  const samplingRate = result.recipe.simulation.sampling_rate_hz
  return result.recipe.simulation.sources.map((source) => {
    const observedHz = aliasFrequency(source.frequency_hz, samplingRate)
    let index = 0
    frequencies.forEach((frequency, candidate) => {
      if (Math.abs(frequency - observedHz) < Math.abs((frequencies[index] ?? 0) - observedHz)) index = candidate
    })
    const before = Math.max(raw[index] ?? 0, 1e-30)
    const after = Math.max(processed[index] ?? 0, 1e-30)
    return { label: source.label, plantedHz: source.frequency_hz, observedHz, changeDb: 10 * Math.log10(after / before) }
  })
}

function describeChange(changeDb: number): string {
  if (changeDb <= -40) return '사실상 사라졌다'
  if (changeDb <= -10) return '크게 줄었다'
  if (changeDb <= -3) return '줄었다'
  if (changeDb < 3) return '거의 그대로다'
  return '오히려 커졌다'
}

const formatDb = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)} dB`

/** One sentence that states what processing did to each planted peak on this channel. */
export function summarizePeakChanges(changes: PeakChange[], channelName: string, reference: 'average' | 'none'): string {
  if (!changes.length) return ''
  const sorted = [...changes].sort((a, b) => a.changeDb - b.changeDb)
  const parts = sorted.map((change) => {
    const where = change.observedHz === change.plantedHz ? `${change.plantedHz} Hz` : `${change.plantedHz} Hz(→ ${change.observedHz.toFixed(0)} Hz로 접힘)`
    return `${where} ${formatDb(change.changeDb)}로 ${describeChange(change.changeDb)}`
  })
  const referenceNote = reference === 'average' ? ' 평균 기준전극도 채널마다 봉우리 높이를 바꾸므로, 필터 효과만 보려면 기준전극을 None으로 두고 비교하세요.' : ''
  return `${channelName}에서 처리 후 ${parts.join(', ')}.${referenceNote}`
}
