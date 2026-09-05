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
      <label className="source-select">Horizontal slice · z = {z} mm
        <select aria-label="Source depth slice" value={z} onChange={(e) => selectSlice(Number(e.target.value))}>
          {slices.map((depth) => <option key={depth} value={depth}>{depth} mm</option>)}
        </select>
      </label>
      <svg viewBox="0 0 400 385" role="img" aria-label={`${band.label} source power at z ${z} mm`}>
        <circle cx="200" cy="185" r="174" className="localization-head" />
        <path d="M190 12 L200 0 L210 12" className="source-head-nose" />
        <text x="200" y="35" textAnchor="middle" className="source-slice-direction">FRONT (+y)</text>
        <text x="200" y="375" textAnchor="middle" className="source-slice-direction">LEFT (−x) · BACK (−y) · RIGHT (+x)</text>
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
          return <g key={roi.id}><title>{`${roi.label} planted · ${coordinates(roi.position_mm)} mm`}</title>
            {end && peak?.position_mm[2] === z && <line x1={p.x} y1={p.y} x2={end.x} y2={end.y} className="source-match-line" />}
            <path d={`M${p.x} ${p.y - 8} l8 8 l-8 8 l-8 -8 Z`} fill="#f5dd91" stroke="#514119" strokeWidth="2" />
          </g>
        })}
      </svg>
      <div className="source-power-key"><span>Low power</span><i /><span>{powerLabel(maximum)} nAm²</span></div>
      <p className="source-reading-note">Color scales to this band’s maximum across all depths. Orange rings mark detected peaks; a dark outline marks your selection. {truthVisible ? 'Diamonds show planted locations in this slice. Peaks at other depths remain in the list.' : 'Use the depth selector to inspect all slices.'}</p>
    </div>
    <div className="source-peak-panel">
      <h3>{band.peaks.length} detected {band.peaks.length === 1 ? 'peak' : 'peaks'}</h3>
      <p>No preset source count. Local maxima must reach {Math.round(result.recipe.inverse.peak_threshold * 100)}% of this band’s maximum and remain at least {result.recipe.inverse.peak_separation_mm} mm apart.</p>
      {band.peaks.length === 0 ? <p role="status">No distinct peak passed these rules. No location is forced.</p> : <ol className="source-peak-list">{band.peaks.map((peak, i) => <li key={peak.id}>
        <button className={selected === peak.vertex_index ? 'selected' : ''} onClick={() => onSelect(peak.vertex_index)}>
          <strong>Peak {i + 1} · v{peak.vertex_index}</strong><span>{coordinates(peak.position_mm)} mm</span>
          <small>{powerLabel(peak.power_nam2)} nAm² · {Math.round(peak.relative_power * 100)}% of band maximum</small>
        </button>
      </li>)}</ol>}
      <p className="source-reading-note">A peak is a descriptive spatial maximum, not proof of a real source. Noise can produce peaks; correlated sources may merge. Values from separate bands use separate color scales.</p>
      {truthVisible && <SourceBandScore result={result} band={band} />}
    </div>
  </div>
}

function SourceBandScore({ result, band }: { result: SourceModelResult; band: SourcePowerMap }) {
  const score = result.evaluation.bands.find((b) => b.band_id === band.id)
  if (!score) return <p>Broadband is exploratory. Scoring uses theta, alpha and beta once each to avoid counting the same source twice.</p>
  const name = (id: string) => result.rois.find((r) => r.id === id)?.label ?? id
  return <section className="source-band-score" aria-label="Revealed localization evaluation">
    <h4>After-reveal spatial comparison</h4>
    <p>{score.matches.length} matched · {score.missed_roi_ids.length} missed · {score.unmatched_peak_ids.length} unmatched peaks</p>
    <ul>{score.matches.map((match) => {
      const roi = result.rois.find((r) => r.id === match.roi_id)!
      const peak = band.peaks.find((p) => p.id === match.peak_id)!
      return <li key={match.roi_id}><strong>{name(match.roi_id)} → {match.peak_id} · {match.distance_mm.toFixed(1)} mm</strong><br />Planted ({coordinates(roi.position_mm)}) mm<br />Detected ({coordinates(peak.position_mm)}) mm</li>
    })}
      {score.missed_roi_ids.map((id) => <li key={id}>Missed: {name(id)}</li>)}
      {score.unmatched_peak_ids.map((id) => <li key={id}>Unmatched peak: {id}</li>)}
    </ul>
    <p>One-to-one matching within this band, at most {result.evaluation.match_radius_mm} mm away. A match means proximity within this tolerance. It does not mean exact recovery.</p>
    <p>Mean matched distance: {score.mean_error_mm === null ? 'not available (no matches)' : `${score.mean_error_mm.toFixed(1)} mm`}. Missed sources are reported separately.</p>
  </section>
}

export function CandidateTraces({ result, selected }: { result: SourceModelResult; selected: number }) {
  const trace = result.candidate_time_courses
  return <div className="source-chart"><LineChart x={trace.x} series={[{ label: `Candidate v${selected} · ${coordinates(result.candidate_positions_mm[selected]!)} mm`, values: trace.series[`v${selected}`]!, color: '#087f83' }]} xLabel="Time (s)" yLabel="Estimated current (nAm)" ariaLabel="Selected candidate current estimated from EEG" /></div>
}

export function CandidateForwardMap({ result, selected }: { result: SourceModelResult; selected: number }) {
  const topography = result.sensor_topographies[selected]!
  const channels = Object.keys(result.sensor_trace.series)
  return <div className="source-forward-single"><h3>Candidate v{selected} · {coordinates(result.candidate_positions_mm[selected]!)} mm</h3>
    <div className="topography-card"><div className="topography-bars">{topography.values.map((value, i) => {
      const height = Math.abs(value) * 42
      return <span className="topography-bar" key={channels[i]} title={`${channels[i]}: ${value.toFixed(3)}`}><i style={{ height: `${height}%`, top: value >= 0 ? `${50 - height}%` : '50%', background: value >= 0 ? '#087f83' : '#c7653c' }} /><small>{channels[i]}</small></span>
    })}</div></div>
    <p>The average-referenced lead field predicts the signed sensor pattern from a unit current at this candidate. Bars are normalized to the largest absolute contribution. Teal is positive; orange is negative. This model is an input to the inverse.</p>
  </div>
}

export function TruthDiagnostics({ result }: { result: SourceModelResult }) {
  return <div className="source-diagnostics"><h3>Activity sampled at the known planted coordinates</h3>
    <p>These locations come from the simulation answer. This diagnostic measures waveform recovery at those locations; it never selects detected peaks.</p>
    <div className="source-chart"><LineChart x={result.latent_roi_time_courses.x} series={result.rois.flatMap((roi, index) => {
      const color = ['#087f83', '#c7653c', '#615b91', '#9b7b27'][index]!
      return [{ label: `${roi.label} estimated at truth`, values: result.reconstructed_roi_time_courses.series[roi.label]!, color }, { label: `${roi.label} planted`, values: result.latent_roi_time_courses.series[roi.label]!, color, dashed: true }]
    })} xLabel="Time (s)" yLabel="Current (nAm)" ariaLabel="Truth-coordinate waveform diagnostic after reveal" /></div>
    <h3>Spatial leakage between planted points</h3><p>Read a planted-source column downward to see its reconstructed spread. Diagonal values are normalized to 100%, not perfect recovery.</p>
    <table><caption>Absolute resolution-matrix response relative to the source’s own ROI</caption><thead><tr><th scope="col">Reconstructed ↓ / Planted →</th>{result.rois.map((roi) => <th scope="col" key={roi.id}>{roi.label}</th>)}</tr></thead><tbody>{result.rois.map((roi, row) => <tr key={roi.id}><th scope="row">{roi.label}</th>{result.scores.leakage_matrix[row]!.map((value, column) => <td key={column}>{Math.round(value * 100)}%</td>)}</tr>)}</tbody></table>
  </div>
}
