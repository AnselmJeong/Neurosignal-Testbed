// P2-3: "더 읽기" per lab. Every entry is a reference from the app manual's appendix C; the level
// and the one-line reason are ours, so a learner knows where to start and what to expect.
import type { LabKey } from '../components/LabNavigator'

export type ReadingLevel = '입문' | '중급' | '심화'

export interface Reading {
  cite: string
  title: string
  level: ReadingLevel
  why: string
  /** Other labs this reading also supports. */
  alsoFor?: LabKey[]
}

const R = {
  welch: { cite: 'Welch (1967) IEEE Trans Audio Electroacoust 15:70–73', title: 'The use of fast Fourier transform for the estimation of power spectra' },
  thomson: { cite: 'Thomson (1982) Proc IEEE 70:1055–1096', title: 'Spectrum estimation and harmonic analysis' },
  widmann: { cite: 'Widmann, Schröger, Maess (2015) J Neurosci Methods 250:34–46', title: 'Digital filter design for electrophysiological data' },
  donoghue: { cite: 'Donoghue et al. (2020) Nat Neurosci 23:1655–1665', title: 'Parameterizing neural power spectra into periodic and aperiodic components' },
  pfurtscheller: { cite: 'Pfurtscheller, Lopes da Silva (1999) Clin Neurophysiol 110:1842–1857', title: 'Event-related EEG/MEG synchronization and desynchronization' },
  leVanQuyen: { cite: 'Le Van Quyen et al. (2001) J Neurosci Methods 111:83–98', title: 'Comparison of Hilbert transform and wavelet methods for the analysis of neuronal synchrony' },
  bruns: { cite: 'Bruns (2004) J Neurosci Methods 137:321–332', title: 'Fourier-, Hilbert- and wavelet-based signal analysis: are they really different approaches?' },
  bell: { cite: 'Bell, Sejnowski (1995) Neural Comput 7:1129–1159', title: 'An information-maximization approach to blind separation and blind deconvolution' },
  lee: { cite: 'Lee, Girolami, Sejnowski (1999) Neural Comput 11:417–441', title: 'Independent component analysis using an extended infomax algorithm' },
  hyvarinen: { cite: 'Hyvärinen, Oja (2000) Neural Netw 13:411–430', title: 'Independent component analysis: algorithms and applications' },
  iclabel: { cite: 'Pion-Tonachini, Kreutz-Delgado, Makeig (2019) NeuroImage 198:181–197', title: 'ICLabel: an automated electroencephalographic independent component classifier' },
  lachaux: { cite: 'Lachaux et al. (1999) Hum Brain Mapp 8:194–208', title: 'Measuring phase synchrony in brain signals' },
  nolte: { cite: 'Nolte et al. (2004) Clin Neurophysiol 115:2292–2307', title: 'Identifying true brain interaction from EEG data using the imaginary part of coherency' },
  stam: { cite: 'Stam, Nolte, Daffertshofer (2007) Hum Brain Mapp 28:1178–1193', title: 'Phase lag index' },
  vinck2010: { cite: 'Vinck et al. (2010) NeuroImage 51:112–122', title: 'The pairwise phase consistency' },
  vinck2011: { cite: 'Vinck et al. (2011) NeuroImage 55:1548–1565', title: 'An improved index of phase-synchronization … volume-conduction, noise and sample-size bias' },
  king: { cite: 'King et al. (2013) Curr Biol 23:1914–1919', title: 'Information sharing in the brain indexes consciousness in noncommunicative patients' },
  hamalainen: { cite: 'Hämäläinen, Ilmoniemi (1994) Med Biol Eng Comput 32:35–42', title: 'Interpreting magnetic fields of the brain: minimum norm estimates' },
  hauk: { cite: 'Hauk, Stenroos, Treder (2022) NeuroImage 255:119177', title: 'Towards an objective evaluation of EEG/MEG source estimation methods: the linear approach' },
  gramfort: { cite: 'Gramfort et al. (2013) Front Neurosci 7:267', title: 'MEG and EEG data analysis with MNE-Python' },
  jansen: { cite: 'Jansen, Rit (1995) Biol Cybern 73:357–366', title: 'Electroencephalogram and visual evoked potential generation in a mathematical model of coupled cortical columns' },
  tvb: { cite: 'Sanz Leon et al. (2013) Front Neuroinform 7:10', title: 'The Virtual Brain: a simulator of primate brain network dynamics' },
  granger: { cite: 'Granger (1969) Econometrica 37:424–438', title: 'Investigating causal relations by econometric models and cross-spectral methods' },
  schreiber: { cite: 'Schreiber (2000) Phys Rev Lett 85:461–464', title: 'Measuring information transfer' },
  barnett: { cite: 'Barnett, Barrett, Seth (2009) Phys Rev Lett 103:238701', title: 'Granger causality and transfer entropy are equivalent for Gaussian variables' },
  haufe: { cite: 'Haufe et al. (2013) NeuroImage 64:120–133', title: 'A critical assessment of connectivity measures for EEG data: a simulation study' },
  friston: { cite: 'Friston, Harrison, Penny (2003) NeuroImage 19:1273–1302', title: 'Dynamic causal modelling' },
  cole: { cite: 'Cole et al. (2016) Nat Neurosci 19:1718–1726', title: 'Activity flow over resting-state networks shapes cognitive task activations' },
} as const

export const LIBRARY: Record<LabKey, Reading[]> = {
  journey: [
    { ...R.gramfort, level: '입문', why: '이 앱이 실제로 호출하는 도구(MNE-Python)의 전체 지도입니다. 어느 단계가 어떤 함수인지 먼저 훑기 좋습니다.', alsoFor: ['real', 'qeeg'] },
    { ...R.haufe, level: '중급', why: '정답을 아는 시뮬레이션으로 연결성 지표를 평가한다는, 이 앱 전체의 발상이 그대로 담긴 논문입니다.', alsoFor: ['connectivity', 'flow'] },
  ],
  filter: [
    { ...R.widmann, level: '입문', why: '차단 주파수, 차수, 영위상 필터를 실무자의 눈으로 설명합니다. Lab 01의 조절기를 움직이기 전에 읽기 좋습니다.', alsoFor: ['real'] },
    { ...R.donoghue, level: '중급', why: '스펙트럼을 1/f 배경과 봉우리로 나누는 방법입니다. Lab 01의 배경 활동이 왜 1/f인지 알 수 있습니다.', alsoFor: ['qeeg'] },
    { ...R.welch, level: '심화', why: '구간을 나눠 평균하는 Welch 스펙트럼의 원전입니다.', alsoFor: ['qeeg'] },
    { ...R.thomson, level: '심화', why: 'multitaper 스펙트럼의 원전입니다. Lab 03의 spectral mode 선택과 이어집니다.', alsoFor: ['connectivity'] },
  ],
  ica: [
    { ...R.hyvarinen, level: '입문', why: 'ICA가 무엇을 가정하고 왜 작동하는지 가장 읽기 쉬운 개관입니다.' },
    { ...R.iclabel, level: '중급', why: 'Lab 02의 "참고 꼬리표"를 만든 분류기입니다. 어떤 자료로 학습했고 어디서 틀리는지 알 수 있습니다.', alsoFor: ['real'] },
    { ...R.bell, level: '심화', why: 'Infomax ICA의 원전입니다.' },
    { ...R.lee, level: '심화', why: 'Lab 02가 쓰는 extended Infomax의 원전입니다. 분포가 뾰족한 성분과 납작한 성분을 함께 다룹니다.' },
  ],
  phase: [
    { ...R.lachaux, level: '입문', why: '위상 고정값(PLV)을 처음 제안한 논문입니다. 준비 장의 "평균 화살표"가 여기서 나왔습니다.', alsoFor: ['connectivity'] },
    { ...R.bruns, level: '중급', why: 'Fourier, Hilbert, wavelet이 사실상 같은 계산이라는 것을 보여 줍니다.' },
    { ...R.leVanQuyen, level: '중급', why: 'Hilbert와 wavelet으로 구한 위상 동기화가 얼마나 비슷한지 실제 자료로 비교합니다.' },
  ],
  connectivity: [
    { ...R.nolte, level: '중급', why: '볼륨 전도가 0° 관계를 만든다는 점과, 허수부만 쓰는 해법을 처음 제시했습니다.' },
    { ...R.stam, level: '중급', why: 'PLI: 위상차의 부호만 세서 0° 관계를 버리는 지표입니다.' },
    { ...R.vinck2010, level: '중급', why: 'PLV의 표본 수 편향을 없앤 PPC입니다. 준비 장 5번 장면과 같은 이야기입니다.', alsoFor: ['phase'] },
    { ...R.vinck2011, level: '심화', why: 'Lab 03과 07이 쓰는 wPLI의 원전입니다.', alsoFor: ['benchmark'] },
    { ...R.haufe, level: '중급', why: '시뮬레이션으로 여러 연결성 지표가 번짐에 속는 정도를 비교합니다.', alsoFor: ['flow'] },
  ],
  source: [
    { ...R.gramfort, level: '입문', why: 'MNE의 순방향 모형과 역해 함수가 어떻게 이어지는지 보여 줍니다.' },
    { ...R.hamalainen, level: '중급', why: 'Minimum-norm 추정의 원전입니다. "가장 조용한 설명"이라는 생각이 어디서 왔는지 볼 수 있습니다.' },
    { ...R.hauk, level: '심화', why: '해상도 행렬로 역해의 "시력"을 재는 방법입니다. Lab 04의 평가 방식과 같습니다.' },
  ],
  real: [
    { ...R.gramfort, level: '입문', why: '실제 기록을 불러오고 점검하는 MNE의 기본 흐름입니다.', alsoFor: ['qeeg'] },
    { ...R.widmann, level: '입문', why: '실제 자료에 필터를 걸기 전에 알아야 할 함정을 정리했습니다.' },
    { ...R.iclabel, level: '중급', why: '실제 기록에서 성분을 자동 분류할 때 결과를 얼마나 믿을지 판단하는 데 필요합니다.' },
  ],
  qeeg: [
    { ...R.pfurtscheller, level: '중급', why: '대역 파워의 증감(ERD/ERS)을 해석하는 기본 원리입니다.' },
    { ...R.donoghue, level: '중급', why: '대역 파워가 봉우리 변화인지 1/f 기울기 변화인지 가르는 방법입니다. QEEG 지표를 해석하기 전에 필요합니다.' },
    { ...R.welch, level: '심화', why: 'Lab 06의 스펙트럼 계산 방식의 원전입니다.' },
  ],
  benchmark: [
    { ...R.jansen, level: '심화', why: 'Lab 07이 쓰는 신경집단 모델의 원전입니다. 세 집단과 두 개의 시상수가 어디서 왔는지 볼 수 있습니다.' },
    { ...R.tvb, level: '중급', why: 'Jansen–Rit 같은 모델을 뇌 네트워크로 이어 붙이는 시뮬레이터입니다.' },
    { ...R.king, level: '중급', why: 'wSMI의 원전입니다. 정보 공유를 기호열로 세는 방법입니다.' },
    { ...R.vinck2011, level: '심화', why: 'wPLI의 원전입니다.', alsoFor: ['connectivity'] },
  ],
  flow: [
    { ...R.barnett, level: '중급', why: 'Gaussian 자료에서 Granger causality와 transfer entropy가 같은 값이라는 것을 보입니다. Lab 08의 GC·TE 비교의 출발점입니다.' },
    { ...R.haufe, level: '중급', why: '방향성 지표도 볼륨 전도에 속는다는 것을 시뮬레이션으로 보여 줍니다.', alsoFor: ['connectivity'] },
    { ...R.granger, level: '심화', why: '"과거가 예측을 돕는가"라는 질문의 원전입니다.' },
    { ...R.schreiber, level: '심화', why: 'Transfer entropy의 원전입니다.' },
    { ...R.friston, level: '심화', why: '가설끼리 겨루는 DCM의 원전입니다.' },
    { ...R.cole, level: '중급', why: 'Activity flow mapping: 연결로 활동을 예측해 보는 방법입니다.' },
  ],
  practice: [
    { ...R.iclabel, level: '중급', why: '사람과 분류기가 아티팩트 성분을 어떻게 판정하는지, 어디서 엇갈리는지 보여 줍니다.', alsoFor: ['ica'] },
    { ...R.haufe, level: '중급', why: '"이 연결선은 진짜인가"를 체계적으로 따진 시뮬레이션 연구입니다.', alsoFor: ['connectivity'] },
  ],
}
