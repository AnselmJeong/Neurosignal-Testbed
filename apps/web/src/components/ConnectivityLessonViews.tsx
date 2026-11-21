import type { ConnectivityRecipe, ConnectivityResult, ConnectivitySpace } from '../types'
import { CircleNetwork, ConnectivityDifference, ConnectivityHeatmap, ScalpNetwork, SurrogateDistribution, CONNECTIVITY_GRADIENT, connectivityLineWidth } from './ConnectivityViews'
import { LineChart } from './Charts'
import { FieldSpreadCaption, SourceFieldHalos, phaseOffsetLabel } from './SourceSettingViews'

export const METRIC_GUIDE = {
  pearson: { label: 'Pearson |r|', explanation: '진폭이 함께 오르내리는가? 이 앱은 알파 대역 필터 없이 모든 표본과 epoch에 걸친 상관의 절댓값을 씁니다. 그래서 음의 상관과 양의 상관이 똑같이 강하게 보입니다.' },
  coh: { label: '코히어런스(Coherence)', explanation: '각 신호의 파워에 비해 교차 스펙트럼이 얼마나 한결같은가? 진폭과 위상이 모두 기여합니다. 제곱하지 않은 coherency 크기(0–1)입니다. 센서들이 같은 장(field)을 동시에 받기만 해도 높게 나올 수 있습니다.' },
  plv: { label: '위상 고정값(PLV)', explanation: 'Phase-locking value: 위상차가 epoch마다 얼마나 일정한가? 진폭은 정규화해 뺍니다. 0이 아닌 위상차라도 일정하면 PLV는 높습니다. 주파수가 같은 것만으로는 부족합니다.' },
  imcoh: { label: '|허수 코히어런스|(Imag. coherence)', explanation: 'coherency의 허수부 크기는 0이 아닌 위상차를 강조합니다. 이상적인 순간 혼합(볼륨 전도)은 억제하지만, 실제 0° 관계도 놓칩니다.' },
  ppc: { label: 'PPC 크기(Pairwise phase consistency)', explanation: '쌍별 위상 일관성은 제곱한 위상 고정값의 표본 수 편향을 줄입니다. 현재 엔진은 절댓값을 표시하므로, 유한 표본에서 생기는 음수 PPC도 양수로 보입니다.' },
  pli: { label: '위상 지연 지수(PLI)', explanation: 'Phase-lag index: 위상차가 한결같이 0의 한쪽에 놓이는가? 0° 의존성을 억제하지만, 위상차가 0 근처일 때 잡음에 민감합니다.' },
  wpli: { label: '가중 위상 지연 지수(wPLI)', explanation: 'Weighted PLI는 교차 스펙트럼 허수부의 크기로 가중해 작고 잡음 많은 위상차의 영향을 줄입니다. 직접 경로나 인과 경로를 증명하지는 않습니다.' },
} as const

export function GeneratingNetwork({ recipe, compact = false }: { recipe: ConnectivityRecipe; compact?: boolean }) {
  const coupled = recipe.coupling_strength > 0
  return <div className="conn-generator-view"><svg className={`generating-network ${compact ? 'compact' : ''}`} viewBox="0 -25 520 290" role="img" aria-label={`설정한 잠재 원천 네트워크: ${coupled ? `Frontal L과 Frontal R이 가중치 ${recipe.coupling_strength}로 알파를 공유` : '공유 알파 성분 없음'}; 독립적인 뒤쪽 원천; 장 퍼짐 ${recipe.volume_conduction.toFixed(2)}; ${phaseOffsetLabel(recipe)}`}>
    <SourceFieldHalos points={[{ x: 88, y: 50 }, { x: 432, y: 50 }, { x: 88, y: 155 }, { x: 432, y: 155 }]} spread={recipe.volume_conduction} />
    <ellipse cx="260" cy="126" rx="220" ry="104" fill="none" stroke="var(--line)" strokeDasharray="4 5" />
    <text x="260" y="16" textAnchor="middle" className="source-link-detail">앞(FRONT) · 위에서 본 도식</text>
    <text x="260" y="228" textAnchor="middle" className="source-link-detail">뒤(BACK) · 해부학 좌표가 아닌 가상 위치</text>
    {coupled && <line x1="110" y1="50" x2="410" y2="50" stroke="var(--accent)" strokeWidth={2 + recipe.coupling_strength * 6} />}
    <rect x="180" y="25" width="160" height="48" rx="5" fill="var(--paper)" />
    <text x="260" y="43" textAnchor="middle" className="source-link-label">{coupled ? `공유 가중치 ${recipe.coupling_strength.toFixed(2)}` : '위상이 서로 독립'}</text>
    <text x="260" y="61" textAnchor="middle" className="source-link-detail">{coupled ? `위상차 ${recipe.phase_lag_deg}°` : '설정한 연결 없음'}</text>
    {['Frontal L', 'Frontal R', 'Posterior L', 'Posterior R'].map((name, i) => {
      const x = i % 2 === 0 ? 88 : 432
      const y = i < 2 ? 50 : 155
      return <g key={name}>
        <circle cx={x} cy={y} r="24" fill="var(--paper)" stroke={i < 2 && coupled ? 'var(--accent)' : 'var(--line-strong)'} strokeWidth="2" />
        <text x={x} y={y + 4} textAnchor="middle" className="source-frequency">{recipe.alpha_frequency_hz} Hz</text>
        <text x={x} y={y + 42} textAnchor="middle" className="source-name">{name}</text>
      </g>
    })}
    <text x="260" y="138" textAnchor="middle" className="source-link-detail">장 퍼짐 {recipe.volume_conduction.toFixed(2)}</text>
    <text x="260" y="157" textAnchor="middle" className="source-link-detail">뒤쪽 원천의 위상은 독립</text>
  </svg>{!compact && <FieldSpreadCaption spread={recipe.volume_conduction} />}</div>
}

export function RecipeSummary({ recipe, includeMeasurement = true }: { recipe: ConnectivityRecipe; includeMeasurement?: boolean }) {
  return <p className="conn-recipe-summary">공유 가중치 {recipe.coupling_strength.toFixed(2)} · 위상차 {recipe.phase_lag_deg}° · 장 퍼짐 {recipe.volume_conduction.toFixed(2)} · {recipe.reference === 'average' ? '평균 기준' : '재기준화 없음'}<br />
    {includeMeasurement && <>{METRIC_GUIDE[recipe.metric].label} · {recipe.metric === 'pearson' ? '광대역' : `${recipe.band_low_hz}–${recipe.band_high_hz} Hz / ${recipe.spectral_mode}`} · </>}{recipe.epoch_count} × {recipe.epoch_duration_s} s · seed {recipe.seed}</p>
}

export function EstimatePanel({ result, label, space, view }: { result: ConnectivityResult; label: string; space: ConnectivitySpace; view: 'Matrix' | 'Network' }) {
  const matrix = result[space]
  const edges = result[`${space}_edges`]
  const threshold = result[`${space}_threshold`]
  return <article className="conn-estimate" aria-label={label}>
    <header><h3>{label}</h3><span>{METRIC_GUIDE[result.recipe.metric].label}</span></header>
    <GeneratingNetwork recipe={result.recipe} compact />
    <RecipeSummary recipe={result.recipe} />
    <div className="conn-estimate-plot">
      {view === 'Matrix' ? <ConnectivityHeatmap matrix={matrix} threshold={threshold} /> : space === 'sensor'
        ? <ScalpNetwork matrix={matrix} edges={edges} threshold={threshold} positions={result.sensor_positions} truthVisible={false} />
        : <CircleNetwork matrix={matrix} edges={edges} threshold={threshold} truthVisible recipe={result.recipe} />}
    </div>
    {view === 'Network' && space === 'sensor' && <div className="conn-network-scale"><i style={{ background: CONNECTIVITY_GRADIENT }} /><span>0 · 파랑 / 낮음</span><span>0.5</span><span>1 · 빨강 / 높음</span></div>}
    {view === 'Network' && <div className="conn-width-legend" aria-label="선 굵기는 고정된 비선형 척도로 세기에 따라 굵어집니다">{[0.25, 0.5, 0.75, 1].map(value => <span key={value}><svg viewBox="0 0 34 12" aria-hidden="true"><line x1="3" x2="31" y1="6" y2="6" stroke="currentColor" strokeWidth={connectivityLineWidth(value)} strokeLinecap="round" /></svg>{value.toFixed(2)}</span>)}</div>}
    <p className="conn-estimate-caption"><strong>연결 {edges.length}개 중 {edges.filter(edge => edge.detected).length}개</strong>가 이 실행의 {space === 'sensor' ? '센서' : '원천'} 귀무 임계값({threshold.toFixed(3)})을 넘었습니다.</p>
    {view === 'Network' && space === 'latent' && <FieldSpreadCaption spread={result.recipe.volume_conduction} />}
  </article>
}

const SETTING_LABELS: Partial<Record<keyof ConnectivityRecipe, string>> = {
  coupling_strength: '공유 알파 가중치', phase_lag_deg: '위상차(°)', volume_conduction: '장 퍼짐', reference: '기준전극', metric: '지표', noise_sd: '배경 잡음', epoch_count: 'Epoch 수', spectral_mode: '스펙트럼 방식', alpha_frequency_hz: '알파 주파수(Hz)',
}
export function ComparisonReadout({ a, b, space }: { a: ConnectivityResult; b: ConnectivityResult; space: ConnectivitySpace }) {
  const changed = (Object.keys(a.recipe) as (keyof ConnectivityRecipe)[]).filter(key => a.recipe[key] !== b.recipe[key])
  const sameMetric = a.recipe.metric === b.recipe.metric && a.recipe.band_low_hz === b.recipe.band_low_hz && a.recipe.band_high_hz === b.recipe.band_high_hz
  const deltas = a[`${space}_edges`].map(edge => {
    const other = b[`${space}_edges`].find(item => item.source === edge.source && item.target === edge.target)
    return { source: edge.source, target: edge.target, a: edge.weight, b: other?.weight ?? edge.weight, delta: (other?.weight ?? edge.weight) - edge.weight }
  }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
  return <div className="conn-comparison-readout">
    <h3>A에서 B로 무엇이 바뀌었나?</h3>
    {changed.length ? <table><thead><tr><th>설정</th><th>A</th><th>B</th></tr></thead><tbody>{changed.map(key => <tr key={key}><th>{SETTING_LABELS[key] ?? key}</th><td>{String(a.recipe[key])}</td><td>{String(b.recipe[key])}</td></tr>)}</tbody></table> : <p>설정이 같습니다. 결정론적 재실행이므로 같은 추정값이 나와야 합니다.</p>}
    <p>{changed.length > 1 ? '여러 설정이 바뀌어서 한 설정의 효과만 떼어 볼 수 없습니다. ' : ''}{a.recipe.seed === b.recipe.seed ? 'seed가 같습니다. ' : 'seed가 다릅니다. '}
      {['epoch_count', 'epoch_duration_s', 'sampling_rate_hz'].some(key => changed.includes(key as keyof ConnectivityRecipe)) ? '표본화 설정이 바뀌면 난수 추출도 바뀔 수 있어 표본 단위로 짝지어지지 않습니다.' : '표본화 설정이 같으므로 무작위 위상과 잡음 추출이 짝지어져 있습니다.'}</p>
    {sameMetric ? <><h4>{space === 'sensor' ? '센서' : '원천'} 차이 지도 · B − A</h4><ConnectivityDifference a={a[space]} b={b[space]} /><h4>가장 크게 바뀐 {space === 'sensor' ? '센서' : '원천'} 쌍 · B − A</h4><table><thead><tr><th>쌍</th><th>A</th><th>B</th><th>Δ</th></tr></thead><tbody>{deltas.slice(0, 3).map(edge => <tr key={`${edge.source}-${edge.target}`}><th>{edge.source} – {edge.target}</th><td>{edge.a.toFixed(3)}</td><td>{edge.b.toFixed(3)}</td><td>{edge.delta > 0 ? '+' : ''}{edge.delta.toFixed(3)}</td></tr>)}</tbody></table></> : <p>지표나 주파수 대역이 다르면 서로 다른 질문에 답합니다. 수치 크기를 맞바꿔 비교할 수 없으므로 B − A는 표시하지 않습니다.</p>}
    <p>A와 B는 고정된 0–1 척도를, 차이 지도는 별도의 대칭 −1–+1 척도를 씁니다. 실행마다 귀무 임계값을 새로 계산하므로, 연결이 임계값을 넘는 이유는 가중치가 바뀌었거나, 귀무 분포가 바뀌었거나, 둘 다일 수 있습니다.</p>
  </div>
}

export function ConnectivityDiagnostics({ result, space }: { result: ConnectivityResult; space: ConnectivitySpace }) {
  return <details className="conn-diagnostics"><summary>섞은 귀무 분포(shuffled null)와 원천 스펙트럼 살펴보기</summary>
    <div className="conn-diagnostic-grid"><div><h3>{space === 'sensor' ? '센서' : '원천'} 섞은 귀무 분포</h3><p>{result.recipe.surrogate_count}번의 섞기마다 노드별로 epoch 순서를 따로 섞고 가장 큰 연결값을 기록합니다. 선은 95번째 백분위수, ‘관측’ 표시는 이번 실행에서 가장 강한 연결입니다.</p>
      <SurrogateDistribution values={result[`${space}_surrogate_values`]} threshold={result[`${space}_threshold`]} estimate={result[`${space}_edges`][0]?.weight ?? 0} />
    </div><div><h3>Frontal L 원천 스펙트럼</h3><p>{result.recipe.alpha_frequency_hz} Hz 봉우리는 한 원천의 리듬 파워를 보여 줍니다. 봉우리만으로는 연결성을 말할 수 없습니다.</p>
      <LineChart x={result.spectrum.frequency_hz} series={[{ label: 'Welch PSD', values: result.spectrum.welch_power }, { label: 'Multitaper PSD', values: result.spectrum.multitaper_power }, { label: '스펙트럼 모형(specparam)', values: result.spectrum.parameterization.modeled_power }]} xLabel="주파수(Hz)" yLabel="파워 (a.u.²/Hz, 로그 척도)" xDomain={[2, 40]} logY ariaLabel="Frontal L source power spectrum" markers={[result.recipe.alpha_frequency_hz]} height={320} />
    </div></div>
    <p>실행 {result.run_id} · recipe {result.provenance.recipe_hash} · {result.estimator_backend}. epoch {result.n_epochs_used}개 사용. 유한한 대리자료로 근사한 임계값이며, 이 귀무 검정으로 해부학적 연결이나 인과를 말할 수는 없습니다.</p>
    <a href="https://mne.tools/mne-connectivity/stable/generated/mne_connectivity.spectral_connectivity_epochs.html" target="_blank" rel="noreferrer">지표 정의 · MNE-Connectivity 문서</a>
  </details>
}
