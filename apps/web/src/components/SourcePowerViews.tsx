import type { SourceModelResult, SourcePowerMap } from '../types'
import { LineChart } from './Charts'

export const coordinates = (point: number[]) => point.map((v) => v.toFixed(0)).join(', ')
export const powerLabel = (power: number) => power === 0 ? '0' : power.toPrecision(3)

export function SourcePowerView({ result, band, selected, onSelect, truthVisible }: {
  result: SourceModelResult; band: SourcePowerMap; selected: number;
  onSelect: (index: number) => void; truthVisible: boolean;
}) {
  const positions = result.candidate_positions_mm
  const selectedPosition = positions[selected]!
  const z = selectedPosition[2]
  const slices = [...new Set(positions.map((p) => p[2]))].sort((a, b) => a - b)
  const maximum = Math.max(...band.power_nam2)
  const peakIndices = new Set(band.peaks.map((p) => p.vertex_index))
  const truth = truthVisible ? result.rois.filter((r) => r.frequency_hz >= band.low_hz && r.frequency_hz < band.high_hz) : []
  const evaluation = truthVisible ? result.evaluation.bands.find((b) => b.band_id === band.id) : undefined
  const xy = (p: number[]) => ({ x: 200 + p[0]! * 2, y: 185 - p[1]! * 2 })
  function selectSlice(depth: number) {
    const candidates = positions.map((p, i) => ({ p, i })).filter(({ p }) => p[2] === depth)
    candidates.sort((a, b) => band.power_nam2[b.i]! - band.power_nam2[a.i]!)
    if (candidates[0]) onSelect(candidates[0].i)
  }
  return <div className="source-power-layout">
    <div className="source-slice-panel">
      <label className="source-select">수평 단면 · z = {z} mm
        <select aria-label="Source depth slice" value={z} onChange={(e) => selectSlice(Number(e.target.value))}>
          {slices.map((depth) => <option key={depth} value={depth}>{depth} mm</option>)}
        </select>
      </label>
      <svg viewBox="0 0 400 385" role="img" aria-label={`${band.label} source power at z ${z} mm`}>
        <circle cx="200" cy="185" r="174" className="localization-head" />
        <path d="M190 12 L200 0 L210 12" className="source-head-nose" />
        <text x="200" y="35" textAnchor="middle" className="source-slice-direction">앞 (+y)</text>
        <text x="200" y="375" textAnchor="middle" className="source-slice-direction">왼쪽 (−x) · 뒤 (−y) · 오른쪽 (+x)</text>
        {positions.map((position, index) => {
          if (position[2] !== z) return null
          const p = xy(position)
          const value = band.relative_power[index]!
          return <g key={index} role="button" tabIndex={0} aria-label={`Candidate ${index}, ${coordinates(position)} mm, power ${powerLabel(band.power_nam2[index]!)} nAm squared`} onClick={() => onSelect(index)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(index) } }}>
            <title>{`v${index} · ${coordinates(position)} mm · ${powerLabel(band.power_nam2[index]!)} nAm²`}</title>
            <circle cx={p.x} cy={p.y} r="12" fill={`color-mix(in srgb, #087f83 ${Math.round(value * 100)}%, #e7eeea)`} stroke={selected === index ? '#202d28' : '#aebcb5'} strokeWidth={selected === index ? 3 : 1} />
            {peakIndices.has(index) && <circle cx={p.x} cy={p.y} r="17" fill="none" stroke="#b4522b" strokeWidth="2" />}
          </g>
        })}
        {truth.map((roi) => {
          if (roi.position_mm[2] !== z) return null
          const p = xy(roi.position_mm)
          const match = evaluation?.matches.find((m) => m.roi_id === roi.id)
          const peak = band.peaks.find((candidate) => candidate.id === match?.peak_id)
          const end = peak ? xy(peak.position_mm) : null
          return <g key={roi.id}><title>{`${roi.label} 심은 위치 · ${coordinates(roi.position_mm)} mm`}</title>
            {end && peak?.position_mm[2] === z && <line x1={p.x} y1={p.y} x2={end.x} y2={end.y} className="source-match-line" />}
            <path d={`M${p.x} ${p.y - 8} l8 8 l-8 8 l-8 -8 Z`} fill="#f5dd91" stroke="#514119" strokeWidth="2" />
          </g>
        })}
      </svg>
      <div className="source-power-key"><span>낮은 파워</span><i /><span>{powerLabel(maximum)} nAm²</span></div>
      <p className="source-reading-note">색은 모든 깊이에 걸친 이 대역의 최댓값에 맞춥니다. 주황 고리는 검출된 봉우리, 진한 테두리는 내가 고른 지점입니다. {truthVisible ? '마름모는 이 단면의 심은 위치입니다. 다른 깊이의 봉우리는 목록에 남아 있습니다.' : '깊이 선택으로 모든 단면을 살펴보세요.'}</p>
    </div>
    <div className="source-peak-panel">
      <h3>검출된 봉우리 {band.peaks.length}개</h3>
      <p>원천 수를 미리 정하지 않습니다. 국소 극댓값이 이 대역 최댓값의 {Math.round(result.recipe.inverse.peak_threshold * 100)}% 이상이고 서로 {result.recipe.inverse.peak_separation_mm} mm 이상 떨어져야 합니다.</p>
      {band.peaks.length === 0 ? <p role="status">이 규칙을 통과한 봉우리가 없습니다. 위치를 억지로 정하지 않습니다.</p> : <ol className="source-peak-list">{band.peaks.map((peak, i) => <li key={peak.id}>
        <button className={selected === peak.vertex_index ? 'selected' : ''} onClick={() => onSelect(peak.vertex_index)}>
          <strong>봉우리 {i + 1} · v{peak.vertex_index}</strong><span>{coordinates(peak.position_mm)} mm</span>
          <small>{powerLabel(peak.power_nam2)} nAm² · 대역 최댓값의 {Math.round(peak.relative_power * 100)}%</small>
        </button>
      </li>)}</ol>}
      <p className="source-reading-note">봉우리는 공간 극댓값을 기술한 것이지 실제 원천의 증거가 아닙니다. 잡음도 봉우리를 만들고, 상관된 원천은 합쳐질 수 있습니다. 대역마다 색 척도가 따로입니다.</p>
      {truthVisible && <SourceBandScore result={result} band={band} />}
    </div>
  </div>
}

function SourceBandScore({ result, band }: { result: SourceModelResult; band: SourcePowerMap }) {
  const score = result.evaluation.bands.find((b) => b.band_id === band.id)
  if (!score) return <p>광대역은 탐색용입니다. 같은 원천을 두 번 세지 않도록 채점은 세타, 알파, 베타를 한 번씩만 씁니다.</p>
  const name = (id: string) => result.rois.find((r) => r.id === id)?.label ?? id
  return <section className="source-band-score" aria-label="공개된 국소화 평가">
    <h4>공개 후 공간 비교</h4>
    <p>짝지음 {score.matches.length} · 놓침 {score.missed_roi_ids.length} · 짝 없는 봉우리 {score.unmatched_peak_ids.length}</p>
    <ul>{score.matches.map((match) => {
      const roi = result.rois.find((r) => r.id === match.roi_id)!
      const peak = band.peaks.find((p) => p.id === match.peak_id)!
      return <li key={match.roi_id}><strong>{name(match.roi_id)} → {match.peak_id} · {match.distance_mm.toFixed(1)} mm</strong><br />심은 위치 ({coordinates(roi.position_mm)}) mm<br />검출 위치 ({coordinates(peak.position_mm)}) mm</li>
    })}
      {score.missed_roi_ids.map((id) => <li key={id}>놓침: {name(id)}</li>)}
      {score.unmatched_peak_ids.map((id) => <li key={id}>짝 없는 봉우리: {id}</li>)}
    </ul>
    <p>이 대역 안에서 최대 {result.evaluation.match_radius_mm} mm 거리로 일대일 짝을 짓습니다. 짝지음은 허용 거리 안에 가깝다는 뜻이지 정확히 되찾았다는 뜻이 아닙니다.</p>
    <p>짝지은 평균 거리: {score.mean_error_mm === null ? '없음(짝 없음)' : `${score.mean_error_mm.toFixed(1)} mm`}. 놓친 원천은 따로 보고합니다.</p>
  </section>
}

export function CandidateTraces({ result, selected }: { result: SourceModelResult; selected: number }) {
  const trace = result.candidate_time_courses
  return <div className="source-chart"><LineChart x={trace.x} series={[{ label: `후보 v${selected} · ${coordinates(result.candidate_positions_mm[selected]!)} mm`, values: trace.series[`v${selected}`]!, color: '#087f83' }]} xLabel="시간(s)" yLabel="추정 전류(nAm)" ariaLabel="Selected candidate current estimated from EEG" /></div>
}

export function CandidateForwardMap({ result, selected }: { result: SourceModelResult; selected: number }) {
  const topography = result.sensor_topographies[selected]!
  const channels = Object.keys(result.sensor_trace.series)
  return <div className="source-forward-single"><h3>후보 v{selected} · {coordinates(result.candidate_positions_mm[selected]!)} mm</h3>
    <div className="topography-card"><div className="topography-bars">{topography.values.map((value, i) => {
      const height = Math.abs(value) * 42
      return <span className="topography-bar" key={channels[i]} title={`${channels[i]}: ${value.toFixed(3)}`}><i style={{ height: `${height}%`, top: value >= 0 ? `${50 - height}%` : '50%', background: value >= 0 ? '#087f83' : '#c7653c' }} /><small>{channels[i]}</small></span>
    })}</div></div>
    <p>평균 기준을 적용한 lead field는 이 후보의 단위 전류가 만드는 부호 있는 센서 패턴을 예측합니다. 막대는 절댓값이 가장 큰 기여에 맞춰 정규화했습니다. 청록은 양수, 주황은 음수입니다. 이 모형은 역해의 입력입니다.</p>
  </div>
}

export function TruthDiagnostics({ result }: { result: SourceModelResult }) {
  return <div className="source-diagnostics"><h3>알려진 심은 좌표에서 뽑은 활동</h3>
    <p>이 위치는 시뮬레이션 정답에서 옵니다. 이 진단은 그 위치에서 파형이 얼마나 되살아났는지 잴 뿐, 검출된 봉우리를 고르지 않습니다.</p>
    <div className="source-chart"><LineChart x={result.latent_roi_time_courses.x} series={result.rois.flatMap((roi, index) => {
      const color = ['#087f83', '#c7653c', '#615b91', '#9b7b27'][index]!
      return [{ label: `${roi.label} 정답 위치에서 추정`, values: result.reconstructed_roi_time_courses.series[roi.label]!, color }, { label: `${roi.label} 심은 신호`, values: result.latent_roi_time_courses.series[roi.label]!, color, dashed: true }]
    })} xLabel="시간(s)" yLabel="전류(nAm)" ariaLabel="Truth-coordinate waveform diagnostic after reveal" /></div>
    <h3>심은 지점 사이의 공간 누설(leakage)</h3><p>심은 원천의 열을 아래로 읽으면 재구성된 퍼짐이 보입니다. 대각선 값은 100%로 정규화한 것이지 완벽한 복원을 뜻하지 않습니다.</p>
    <table><caption>원천 자신의 ROI 대비 해상도 행렬 응답의 절댓값</caption><thead><tr><th scope="col">재구성 ↓ / 심은 원천 →</th>{result.rois.map((roi) => <th scope="col" key={roi.id}>{roi.label}</th>)}</tr></thead><tbody>{result.rois.map((roi, row) => <tr key={roi.id}><th scope="row">{roi.label}</th>{result.scores.leakage_matrix[row]!.map((value, column) => <td key={column}>{Math.round(value * 100)}%</td>)}</tr>)}</tbody></table>
  </div>
}
