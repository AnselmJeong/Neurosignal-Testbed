import type { ConnectivityRecipe, ConnectivityResult, ConnectivitySpace } from '../types'
import { CircleNetwork, ConnectivityDifference, ConnectivityHeatmap, ScalpNetwork, SurrogateDistribution, CONNECTIVITY_GRADIENT, connectivityLineWidth } from './ConnectivityViews'
import { LineChart } from './Charts'
import { FieldSpreadCaption, SourceFieldHalos, phaseOffsetLabel } from './SourceSettingViews'

export const METRIC_GUIDE = {
  pearson: { label: 'Pearson |r|', explanation: 'Do the amplitudes rise and fall together? This app takes the absolute correlation across all samples and epochs, without an alpha band-pass. Negative and positive correlations therefore look equally strong.' },
  coh: { label: 'Coherence', explanation: 'How consistent is the cross-spectrum relative to each signal’s power? Both amplitude and phase contribute. This is coherency magnitude (0–1), not magnitude-squared coherence. Shared instantaneous sensor fields can produce high coherence.' },
  plv: { label: 'PLV', explanation: 'Phase-locking value: how consistent is the phase difference across epochs? Amplitude is normalized out. A constant nonzero phase difference can still give high PLV; matching frequency alone is not enough.' },
  imcoh: { label: '|Imag. coherence|', explanation: 'The magnitude of the imaginary part of coherency emphasizes nonzero phase offsets. It suppresses ideal instantaneous mixing, but also misses genuine zero-lag relationships.' },
  ppc: { label: 'PPC magnitude', explanation: 'Pairwise phase consistency reduces sample-count bias in squared phase locking. The current engine displays its absolute value, so negative finite-sample PPC values also appear positive.' },
  pli: { label: 'PLI', explanation: 'Phase-lag index asks whether phase differences consistently fall on one side of zero. It suppresses zero-lag dependence, but is sensitive to noise near zero lag.' },
  wpli: { label: 'wPLI', explanation: 'Weighted phase-lag index weights the imaginary cross-spectrum to reduce the influence of small, noisy phase differences. It does not prove a direct or causal pathway.' },
} as const

export function GeneratingNetwork({ recipe, compact = false }: { recipe: ConnectivityRecipe; compact?: boolean }) {
  const coupled = recipe.coupling_strength > 0
  return <div className="conn-generator-view"><svg className={`generating-network ${compact ? 'compact' : ''}`} viewBox="0 -25 520 290" role="img" aria-label={`Configured latent network: ${coupled ? `Frontal L and Frontal R share alpha with weight ${recipe.coupling_strength}` : 'no shared alpha component'}; independent posterior sources; field spread ${recipe.volume_conduction.toFixed(2)}; ${phaseOffsetLabel(recipe)}`}>
    <SourceFieldHalos points={[{ x: 88, y: 50 }, { x: 432, y: 50 }, { x: 88, y: 155 }, { x: 432, y: 155 }]} spread={recipe.volume_conduction} />
    <ellipse cx="260" cy="126" rx="220" ry="104" fill="none" stroke="var(--line)" strokeDasharray="4 5" />
    <text x="260" y="16" textAnchor="middle" className="source-link-detail">FRONT · schematic top view</text>
    <text x="260" y="228" textAnchor="middle" className="source-link-detail">BACK · virtual locations, not anatomical coordinates</text>
    {coupled && <line x1="110" y1="50" x2="410" y2="50" stroke="var(--accent)" strokeWidth={2 + recipe.coupling_strength * 6} />}
    <rect x="180" y="25" width="160" height="48" rx="5" fill="var(--paper)" />
    <text x="260" y="43" textAnchor="middle" className="source-link-label">{coupled ? `Shared weight ${recipe.coupling_strength.toFixed(2)}` : 'Independent phases'}</text>
    <text x="260" y="61" textAnchor="middle" className="source-link-detail">{coupled ? `${recipe.phase_lag_deg}° phase offset` : 'No configured edge'}</text>
    {['Frontal L', 'Frontal R', 'Posterior L', 'Posterior R'].map((name, i) => {
      const x = i % 2 === 0 ? 88 : 432
      const y = i < 2 ? 50 : 155
      return <g key={name}>
        <circle cx={x} cy={y} r="24" fill="var(--paper)" stroke={i < 2 && coupled ? 'var(--accent)' : 'var(--line-strong)'} strokeWidth="2" />
        <text x={x} y={y + 4} textAnchor="middle" className="source-frequency">{recipe.alpha_frequency_hz} Hz</text>
        <text x={x} y={y + 42} textAnchor="middle" className="source-name">{name}</text>
      </g>
    })}
    <text x="260" y="138" textAnchor="middle" className="source-link-detail">Field spread {recipe.volume_conduction.toFixed(2)}</text>
    <text x="260" y="157" textAnchor="middle" className="source-link-detail">Independent posterior phases</text>
  </svg>{!compact && <FieldSpreadCaption spread={recipe.volume_conduction} />}</div>
}

export function RecipeSummary({ recipe, includeMeasurement = true }: { recipe: ConnectivityRecipe; includeMeasurement?: boolean }) {
  return <p className="conn-recipe-summary">Shared weight {recipe.coupling_strength.toFixed(2)} · phase {recipe.phase_lag_deg}° · spread {recipe.volume_conduction.toFixed(2)} · {recipe.reference === 'average' ? 'average reference' : 'no re-reference'}<br />
    {includeMeasurement && <>{METRIC_GUIDE[recipe.metric].label} · {recipe.metric === 'pearson' ? 'broadband' : `${recipe.band_low_hz}–${recipe.band_high_hz} Hz / ${recipe.spectral_mode}`} · </>}{recipe.epoch_count} × {recipe.epoch_duration_s} s · seed {recipe.seed}</p>
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
    {view === 'Network' && space === 'sensor' && <div className="conn-network-scale"><i style={{ background: CONNECTIVITY_GRADIENT }} /><span>0 · blue / low</span><span>0.5</span><span>1 · red / high</span></div>}
    {view === 'Network' && <div className="conn-width-legend" aria-label="Line width increases with strength on a fixed nonlinear scale">{[0.25, 0.5, 0.75, 1].map(value => <span key={value}><svg viewBox="0 0 34 12" aria-hidden="true"><line x1="3" x2="31" y1="6" y2="6" stroke="currentColor" strokeWidth={connectivityLineWidth(value)} strokeLinecap="round" /></svg>{value.toFixed(2)}</span>)}</div>}
    <p className="conn-estimate-caption"><strong>{edges.filter(edge => edge.detected).length} / {edges.length} edges</strong> above this run’s {space} null threshold ({threshold.toFixed(3)}).</p>
    {view === 'Network' && space === 'latent' && <FieldSpreadCaption spread={result.recipe.volume_conduction} />}
  </article>
}

const SETTING_LABELS: Partial<Record<keyof ConnectivityRecipe, string>> = {
  coupling_strength: 'Shared alpha weight', phase_lag_deg: 'Phase offset (°)', volume_conduction: 'Field spread', reference: 'Reference', metric: 'Metric', noise_sd: 'Background noise', epoch_count: 'Epochs', spectral_mode: 'Spectral mode', alpha_frequency_hz: 'Alpha frequency (Hz)',
}
export function ComparisonReadout({ a, b, space }: { a: ConnectivityResult; b: ConnectivityResult; space: ConnectivitySpace }) {
  const changed = (Object.keys(a.recipe) as (keyof ConnectivityRecipe)[]).filter(key => a.recipe[key] !== b.recipe[key])
  const sameMetric = a.recipe.metric === b.recipe.metric && a.recipe.band_low_hz === b.recipe.band_low_hz && a.recipe.band_high_hz === b.recipe.band_high_hz
  const deltas = a[`${space}_edges`].map(edge => {
    const other = b[`${space}_edges`].find(item => item.source === edge.source && item.target === edge.target)
    return { source: edge.source, target: edge.target, a: edge.weight, b: other?.weight ?? edge.weight, delta: (other?.weight ?? edge.weight) - edge.weight }
  }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
  return <div className="conn-comparison-readout">
    <h3>What changed from A to B?</h3>
    {changed.length ? <table><thead><tr><th>Setting</th><th>A</th><th>B</th></tr></thead><tbody>{changed.map(key => <tr key={key}><th>{SETTING_LABELS[key] ?? key}</th><td>{String(a.recipe[key])}</td><td>{String(b.recipe[key])}</td></tr>)}</tbody></table> : <p>Identical settings: deterministic reruns should reproduce the same estimates.</p>}
    <p>{changed.length > 1 ? 'Several settings changed; this comparison cannot isolate one setting’s effect. ' : ''}{a.recipe.seed === b.recipe.seed ? 'Same seed. ' : 'Different random seeds. '}
      {['epoch_count', 'epoch_duration_s', 'sampling_rate_hz'].some(key => changed.includes(key as keyof ConnectivityRecipe)) ? 'Sampling changes can also change the random draws; these are not matched sample-by-sample.' : 'Random phases and noise draws are matched when sampling settings stay fixed.'}</p>
    {sameMetric ? <><h4>{space === 'sensor' ? 'Sensor' : 'Source'} difference map · B − A</h4><ConnectivityDifference a={a[space]} b={b[space]} /><h4>Largest {space} changes · B − A</h4><table><thead><tr><th>Pair</th><th>A</th><th>B</th><th>Δ</th></tr></thead><tbody>{deltas.slice(0, 3).map(edge => <tr key={`${edge.source}-${edge.target}`}><th>{edge.source} – {edge.target}</th><td>{edge.a.toFixed(3)}</td><td>{edge.b.toFixed(3)}</td><td>{edge.delta > 0 ? '+' : ''}{edge.delta.toFixed(3)}</td></tr>)}</tbody></table></> : <p>Different metrics or frequency bands answer different questions. Their numerical magnitudes are not interchangeable, so no B − A score is shown.</p>}
    <p>A and B use a fixed 0–1 scale; the difference map uses a separate, symmetric −1 to +1 scale. Each run recalculates its own null threshold; an edge can cross the threshold because its weight, the null distribution, or both changed.</p>
  </div>
}

export function ConnectivityDiagnostics({ result, space }: { result: ConnectivityResult; space: ConnectivitySpace }) {
  return <details className="conn-diagnostics"><summary>Inspect the shuffled nulls and source spectrum</summary>
    <div className="conn-diagnostic-grid"><div><h3>{space} shuffled null</h3><p>Each of {result.recipe.surrogate_count} shuffles permutes epochs independently per node and records the largest edge. The line marks the 95th percentile; the observed marker is this run’s strongest edge.</p>
      <SurrogateDistribution values={result[`${space}_surrogate_values`]} threshold={result[`${space}_threshold`]} estimate={result[`${space}_edges`][0]?.weight ?? 0} />
    </div><div><h3>Frontal L source spectrum</h3><p>The {result.recipe.alpha_frequency_hz} Hz peak describes rhythmic power in one source. A peak alone does not establish connectivity.</p>
      <LineChart x={result.spectrum.frequency_hz} series={[{ label: 'Welch PSD', values: result.spectrum.welch_power }, { label: 'Multitaper PSD', values: result.spectrum.multitaper_power }, { label: 'Spectral model', values: result.spectrum.parameterization.modeled_power }]} xLabel="Frequency (Hz)" yLabel="Power (a.u.²/Hz, log scale)" xDomain={[2, 40]} logY ariaLabel="Frontal L source power spectrum" markers={[result.recipe.alpha_frequency_hz]} height={320} />
    </div></div>
    <p>Run {result.run_id} · recipe {result.provenance.recipe_hash} · {result.estimator_backend}. {result.n_epochs_used} epochs used. Approximate finite-surrogate threshold; this null test cannot establish anatomical or causal links.</p>
    <a href="https://mne.tools/mne-connectivity/stable/generated/mne_connectivity.spectral_connectivity_epochs.html" target="_blank" rel="noreferrer">Metric definitions · MNE-Connectivity documentation</a>
  </details>
}
