// P1-2: "The math" next to the controls. Each lab gets 3–4 named steps, one sentence and one
// formula each, condensed from the theory sections of the app manual (section names in comments).
// Formulas are written as MathML so the desktop app needs no fonts, CDN, or renderer library.
import { createElement, type ReactNode } from 'react'

type Node = ReactNode
const el = (tag: string, ...children: Node[]) => createElement(tag, null, ...children)
const el2 = (tag: string, props: Record<string, string>, ...children: Node[]) => createElement(tag, props, ...children)

export const mi = (name: string) => el('mi', name)
export const mn = (value: string) => el('mn', value)
export const mo = (op: string) => el('mo', op)
export const mtext = (text: string) => el('mtext', text)
export const row = (...children: Node[]) => el('mrow', ...children)
export const frac = (top: Node, bottom: Node) => el('mfrac', top, bottom)
export const sub = (base: Node, script: Node) => el('msub', base, script)
export const sup = (base: Node, script: Node) => el('msup', base, script)
export const subsup = (base: Node, lower: Node, upper: Node) => el('msubsup', base, lower, upper)
export const sqrt = (body: Node) => el('msqrt', body)
export const bold = (name: string) => el2('mi', { mathvariant: 'bold' }, name)
export const under = (base: Node, script: Node) => el('munder', base, script)
export const abs = (...body: Node[]) => row(mo('|'), ...body, mo('|'))
export const mean = (...body: Node[]) => row(mo('⟨'), ...body, mo('⟩'))
export const paren = (...body: Node[]) => row(mo('('), ...body, mo(')'))
export const space = () => el2('mspace', { width: '1em' })

export function MathFormula({ children, label }: { children: Node; label: string }) {
  return createElement('math', { display: 'block', 'aria-label': label }, children)
}

export interface MathStep {
  id: string
  title: string
  line: string
  formula: Node
  /** Plain-text reading of the formula for screen readers and tests. */
  spoken: string
}

const x = bold('x')
const s = bold('s')
const j = bold('j')
const n = bold('n')
const t = paren(mi('t'))

export const MATH_STEPS: Record<'filter' | 'ica' | 'connectivity' | 'source', MathStep[]> = {
  // Manual: Lab 01 · 이론 (표본화와 Nyquist 주파수, Aliasing, 디지털 필터, Welch 파워 스펙트럼 밀도)
  filter: [
    {
      id: 'sample', title: '표본화(Sampling)', line: '연속 신호를 1/fₛ 간격으로 찍습니다. 표현할 수 있는 가장 높은 주파수는 fₛ의 절반입니다.',
      formula: row(mi('x'), mo('['), mi('n'), mo(']'), mo('='), mi('x'), paren(frac(mi('n'), sub(mi('f'), mi('s')))), space(), sub(mi('f'), mtext('Nyquist')), mo('='), frac(sub(mi('f'), mi('s')), mn('2'))),
      spoken: 'x[n] = x(n / fs), f_Nyquist = fs / 2',
    },
    {
      id: 'alias', title: '접힘(Aliasing)', line: 'Nyquist보다 높은 성분은 사라지지 않고 가장 가까운 fₛ의 배수에서 뺀 자리로 접힙니다.',
      formula: row(sub(mi('f'), mtext('alias')), mo('='), abs(mi('f'), mo('−'), mi('k'), sub(mi('f'), mi('s'))), mo(','), space(), mi('k'), mo('='), mtext('round'), paren(mi('f'), mo('/'), sub(mi('f'), mi('s')))),
      spoken: 'f_alias = |f − k fs|, k = round(f / fs)',
    },
    {
      id: 'filter', title: '필터(Butterworth)', line: '차단 주파수 f_c를 지나면 차수 n이 클수록 가파르게 줄어듭니다. 영위상 필터는 이것을 두 번(앞뒤로) 겁니다.',
      formula: row(sup(abs(mi('H'), paren(mi('f'))), mn('2')), mo('='), frac(mn('1'), row(mn('1'), mo('+'), sup(paren(mi('f'), mo('/'), sub(mi('f'), mi('c'))), row(mn('2'), mi('n')))))),
      spoken: '|H(f)|² = 1 / (1 + (f / fc)^(2n))',
    },
    {
      id: 'welch', title: '스펙트럼(Welch PSD)', line: '신호를 겹치는 구간으로 나눠 구간마다 파워를 구하고 평균합니다. 평균할수록 덜 흔들립니다.',
      formula: row(mover(mi('P'), mo('^')), paren(mi('f')), mo('='), sub(mean(sup(abs(sub(mi('X'), mi('k')), paren(mi('f'))), mn('2'))), mi('k'))),
      spoken: 'P(f) = ⟨|X_k(f)|²⟩ over segments k',
    },
  ],
  // Manual: Lab 02 · 이론 (ICA 모델, rank와 성분 수, 성분 제거와 재구성)
  ica: [
    {
      id: 'mix', title: '혼합(Mixing)', line: '센서 신호는 원천들이 혼합 행렬 A로 섞인 것입니다. ICA는 A도 s도 모른 채 시작합니다.',
      formula: row(x, t, mo('='), mi('A'), s, t),
      spoken: 'x(t) = A s(t)',
    },
    {
      id: 'whiten', title: '백색화(Whiten)', line: 'PCA로 채널 사이 상관을 없애고 분산을 1로 맞춥니다. rank만큼의 차원만 남습니다.',
      formula: row(bold('z'), mo('='), sub(mi('W'), mn('0')), x, mo(','), space(), mean(bold('z'), sup(bold('z'), mo('⊤'))), mo('='), mi('I')),
      spoken: 'z = W0 x, ⟨z zᵀ⟩ = I',
    },
    {
      id: 'rotate', title: '회전 찾기(Unmix)', line: '남은 일은 회전 하나를 고르는 것입니다. 성분들이 서로 가장 독립이 되는 회전 W를 찾습니다(Infomax, FastICA).',
      formula: row(bold('u'), t, mo('='), mi('W'), bold('z'), t),
      spoken: 'u(t) = W z(t)',
    },
    {
      id: 'remove', title: '삭제와 재구성(Remove)', line: '제외한 성분의 시계열에 그 지형도를 곱해 센서 신호에서 뺍니다. 그 성분에 실린 신경 신호도 함께 빠집니다.',
      formula: row(sub(x, mtext('clean')), mo('='), x, mo('−'), under(mo('∑'), row(mi('k'), mo('∈'), mtext('제외'))), sub(bold('a'), mi('k')), sub(mi('u'), mi('k')), t),
      spoken: 'x_clean = x − Σ_{k∈excluded} a_k u_k(t)',
    },
  ],
  // Manual: Lab 03 · 이론 (계산 과정: 화살표를 만들고 평균한다, 첫째/둘째 부류, 대리자료 검정)
  connectivity: [
    {
      id: 'arrow', title: '화살표 만들기(Cross-spectrum)', line: 'epoch마다 두 신호의 푸리에 계수를 곱해 화살표 하나를 만듭니다. 방향이 위상차, 길이가 두 진폭의 곱입니다.',
      formula: row(sub(mi('S'), row(mi('x'), mi('y'))), paren(mi('f')), mo('='), mean(mi('X'), paren(mi('f')), sup(mi('Y'), mo('*')), paren(mi('f')))),
      spoken: 'S_xy(f) = ⟨X(f) Y*(f)⟩',
    },
    {
      id: 'average', title: '평균하고 길이 재기(Coherence, PLV)', line: '화살표를 평균한 길이가 일관성입니다. PLV는 길이를 모두 1로 두고 방향만 평균합니다.',
      formula: row(mtext('PLV'), mo('='), abs(mean(sup(mi('e'), row(mi('i'), mi('Δ'), mi('φ'))))), space(), mtext('coh'), mo('='), frac(abs(sub(mi('S'), row(mi('x'), mi('y')))), sqrt(row(sub(mi('S'), row(mi('x'), mi('x'))), sub(mi('S'), row(mi('y'), mi('y'))))))),
      spoken: 'PLV = |⟨e^(iΔφ)⟩|, coh = |S_xy| / √(S_xx S_yy)',
    },
    {
      id: 'drop-zero', title: '0° 버리기(wPLI)', line: '번짐은 위상차 0°를 만듭니다. 세로 성분(허수부)만 쓰면 0° 관계는 진짜든 번짐이든 모두 버려집니다.',
      formula: row(mtext('wPLI'), mo('='), frac(abs(mean(mtext('Im'), mo('⁡'), sub(mi('S'), row(mi('x'), mi('y'))))), mean(abs(mtext('Im'), mo('⁡'), sub(mi('S'), row(mi('x'), mi('y'))))))),
      spoken: 'wPLI = |⟨Im S_xy⟩| / ⟨|Im S_xy|⟩',
    },
    {
      id: 'null', title: '비교 대상(Surrogate)', line: 'epoch 짝을 섞어 관계를 끊은 자료로 같은 값을 N번 계산합니다. 관측값이 이 분포의 꼬리에 있어야 믿습니다.',
      formula: row(mi('p'), mo('='), frac(row(mn('1'), mo('+'), mo('#'), mo('{'), sub(mtext('값'), mtext('섞음')), mo('≥'), sub(mtext('값'), mtext('관측')), mo('}')), row(mn('1'), mo('+'), mi('N')))),
      spoken: 'p = (1 + #{surrogate ≥ observed}) / (1 + N)',
    },
  ],
  // Manual: Lab 04 · 이론 (순방향 문제, Minimum-norm 추정, 해상도 행렬, 대역 파워 지도와 봉우리 검출)
  source: [
    {
      id: 'forward', title: '순방향(Forward)', line: '원천 전류를 알면 두피 전압은 lead field L로 정해집니다. 센서보다 원천 격자점이 훨씬 많습니다.',
      formula: row(x, t, mo('='), mi('L'), j, t, mo('+'), n, t),
      spoken: 'x(t) = L j(t) + n(t)',
    },
    {
      id: 'inverse', title: '역해(Minimum-norm)', line: '같은 두피를 만드는 해가 무수히 많으므로, 그중 전체 전류가 가장 작은 해를 고릅니다. λ²가 잡음과 조용함 사이의 저울입니다.',
      formula: row(mover(j, mo('^')), mo('='), mi('M'), x, mo(','), space(), mi('M'), mo('='), sup(mi('L'), mo('⊤')), sup(paren(mi('L'), sup(mi('L'), mo('⊤')), mo('+'), sup(mi('λ'), mn('2')), mi('C')), row(mo('−'), mn('1')))),
      spoken: 'ĵ = M x, M = Lᵀ(L Lᵀ + λ² C)⁻¹',
    },
    {
      id: 'resolution', title: '해상도(Resolution)', line: '점 원천 하나를 넣고 역해를 거치면 퍼진 덩어리가 나옵니다. R의 열 하나가 그 점이 보이는 모양입니다.',
      formula: row(mover(j, mo('^')), mo('='), mi('M'), mi('L'), j, mo('='), mi('R'), j),
      spoken: 'ĵ = M L j = R j',
    },
    {
      id: 'peaks', title: '봉우리 검출(Peaks)', line: '대역 파워 지도에서 이웃보다 크고 임계값을 넘는 점을 봉우리로 셉니다. 가까운 두 원천은 봉우리 하나로 합쳐질 수 있습니다.',
      formula: row(sub(mi('P'), mtext('band')), mo('='), under(mo('∑'), row(sub(mi('f'), mn('1')), mo('≤'), mi('f'), mo('<'), sub(mi('f'), mn('2')))), mi('P'), paren(mi('f')), mi('Δ'), mi('f')),
      spoken: 'P_band = Σ_{f1 ≤ f < f2} P(f) Δf',
    },
  ],
}

function mover(base: Node, accent: Node) {
  return el2('mover', { accent: 'true' }, base, accent)
}
