import { useEffect, useState } from 'react'
import { Activity, Brain, ChartNoAxesCombined, Download, Map, Play, Users } from 'lucide-react'
import { defaultQeegRecipe, simulateQeeg, type QeegRecipe, type QeegResult } from '../lib/qeeg'
import { LabNavigator, type LabId } from './LabNavigator'
import { ImportedQeegWorkbench } from './ImportedQeegWorkbench'
import { LineChart } from './Charts'
import { StackedEegBrowser } from './StackedEegBrowser'
import { ConnectivityHeatmap } from './ConnectivityViews'
import { QeegTopomap } from './QeegTopomap'
import './qeeg-lab.css'

const STEPS = [
  { label: 'Generate', description: 'Oscillations + 1/f background → EEG.', icon: Activity },
  { label: 'Geometry', description: 'Separate head physics from electrode layout.', icon: Brain },
  { label: 'Map', description: 'Turn channel spectra into a frequency atlas.', icon: Map },
  { label: 'Quantify', description: 'Inspect formulas and channel values.', icon: ChartNoAxesCombined },
  { label: 'Compare', description: 'Calculate z scores against synthetic peers.', icon: Users },
]
const VIEWS = ['EEG', 'Geometry', 'Atlas', 'Metrics', 'Norms'] as const
type View = typeof VIEWS[number]
const LESSONS: Record<View, { title: string; text: string; experiment: string }> = {
  EEG: { title: 'Every channel is a mixture.', text: 'Six radial dipoles carry posterior alpha, frontal theta and central beta, plus independent 1/f backgrounds. The leadfield mixes them at the electrodes, then sensor noise and the chosen reference are applied. The trace preview shows 10 s; metrics use all 32 s.', experiment: 'Increase posterior alpha amplitude. Predict which channels will gain alpha power before opening the atlas.' },
  Geometry: { title: 'A scalp map is not a brain slice.', text: 'The head model computes how dipoles project to electrodes. The montage supplies electrode coordinates; the reference defines voltage differences. Scalp interpolation fills between those measurements. It does not reconstruct cortical sources.', experiment: 'Change skull conductivity, regenerate, and compare the maps. Then change only the reference. Both can alter power without changing the planted sources.' },
  Atlas: { title: 'One number per electrode.', text: 'Split EEG into 4 s Hann windows with 50% overlap. Average the FFT power spectra (Welch), sum the 0.25 Hz bins inside each interval, then interpolate channel values onto the scalp. Per-map scales reveal spatial patterns; a shared scale compares power across frequencies. Color alone does not compare a channel with normative data.', experiment: 'Switch absolute to relative power: the latter divides by each channel’s total 1–45 Hz power. A larger alpha denominator can reduce relative theta without reducing absolute theta.' },
  Metrics: { title: 'Start with the definition.', text: 'Each metric answers a different question. Band power measures spectral energy; ratios compare energies; peak and edge frequencies describe spectral location. Connectivity compares pairs of sensor signals and is affected by shared sources and reference.', experiment: 'Select O1, F3 and C3. Compare their PSD and numerical metrics. Positive F4−F3 alpha asymmetry means more right alpha power, not necessarily more right neural activation.' },
  Norms: { title: 'A z score needs a population.', text: 'Each synthetic peer has its own EEG, phases, background and noise. Amplitudes vary lognormally, alpha frequency varies around 10 Hz, and right/left gain varies. All peers use the same montage, head model, reference, duration and spectral recipe as this subject.', experiment: 'Increase the subject’s alpha amplitude. The reference cohort stays fixed. Change the cohort seed or size to see sampling variability. These peers have no age, diagnosis or population validity.' },
}

export function QeegWorkbench(props: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const [recipe, setRecipe] = useState<QeegRecipe>({ ...defaultQeegRecipe })
  const [result, setResult] = useState<QeegResult | null>(null)
  const [view, setView] = useState<View>('Atlas')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [imported, setImported] = useState(false)
  const [channel, setChannel] = useState('O1')
  const [power, setPower] = useState<'absolute' | 'relative'>('relative')
  const [group, setGroup] = useState('frequency')
  const [page, setPage] = useState(0)
  const [colorScale, setColorScale] = useState<'per_map' | 'shared'>('per_map')
  const [normMetric, setNormMetric] = useState<'absolute' | 'relative' | 'theta_beta'>('absolute')
  const [band, setBand] = useState(2)
  const [connection, setConnection] = useState<'coherence' | 'plv'>('coherence')
  const dirty = !!result && JSON.stringify(recipe) !== JSON.stringify(result.recipe)
  async function run() {
    setBusy(true); setError('')
    try { setResult(await simulateQeeg(recipe)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Simulation failed.') }
    finally { setBusy(false) }
  }
  useEffect(() => {
    let active = true
    setBusy(true)
    simulateQeeg(defaultQeegRecipe).then((next) => { if (active) setResult(next) })
      .catch((cause: Error) => { if (active) setError(cause.message) })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [])
  function update<K extends keyof QeegRecipe>(key: K, value: QeegRecipe[K]) { setRecipe((current) => ({ ...current, [key]: value })) }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = `qeeg-simulation-${result?.recipe.seed}.json`; a.click(); URL.revokeObjectURL(url)
  }
  if (imported) return <><div className="ql-legacy"><button onClick={() => setImported(false)}>← Back to simulation lesson</button><span>Advanced · imported recording derivative</span></div><ImportedQeegWorkbench {...props} /></>
  const c = result ? Math.max(0, result.channel_names.indexOf(channel)) : 0
  const lesson = LESSONS[view]
  return <>
    <main className="workspace qeeg-workspace ql-workspace">
      <LabNavigator {...props} steps={STEPS} step={VIEWS.indexOf(view)} />
      <aside className="control-panel ql-controls">
        <div className="panel-heading"><span className="eyebrow">QEEG · simulation studio</span><h1>From signals<br />to scalp maps.</h1><p>Build an EEG. Follow its numbers into the image.</p></div>
        <fieldset disabled={busy}>
          <section className="control-section"><div className="section-title"><span>Virtual sources</span><small>nAm</small></div>
            <Slider label="Posterior alpha" value={recipe.alpha_amplitude} min={2} max={45} onChange={(v) => update('alpha_amplitude', v)} />
            <Slider label="Frontal theta" value={recipe.theta_amplitude} min={2} max={35} onChange={(v) => update('theta_amplitude', v)} />
            <Slider label="Central beta" value={recipe.beta_amplitude} min={2} max={30} onChange={(v) => update('beta_amplitude', v)} />
            <Slider label="Alpha frequency · Hz" value={recipe.alpha_hz} min={8} max={12} step={.25} onChange={(v) => update('alpha_hz', v)} />
            <Slider label="Right alpha gain · ×" value={recipe.right_alpha_gain} min={.25} max={2.5} step={.05} onChange={(v) => update('right_alpha_gain', v)} />
          </section>
          <section className="control-section"><div className="section-title"><span>Measurement geometry</span></div>
            <Select label="Electrode montage" value={recipe.montage} options={['19', '32']} labels={['10–20 · 19 channels', '10–20 + intermediate · 32']} onChange={(v) => update('montage', v as QeegRecipe['montage'])} />
            <Select label="Voltage reference" value={recipe.reference} options={['average', 'linked_mastoids']} labels={['Average of EEG channels', 'Linked mastoids · (A1 + A2)/2']} onChange={(v) => update('reference', v as QeegRecipe['reference'])} />
            <Select label="Four-layer head model" value={recipe.head_model} options={['standard', 'conductive_skull']} labels={['Skull conductivity · 0.004 S/m', 'Skull conductivity · 0.012 S/m']} onChange={(v) => update('head_model', v as QeegRecipe['head_model'])} />
          </section>
          <section className="control-section"><div className="section-title"><span>Synthetic reference cohort</span></div>
            <Select label="Number of peers" value={String(recipe.cohort_size)} options={['20', '80', '200']} onChange={(v) => update('cohort_size', Number(v))} />
            <label className="ql-number">Subject seed<input type="number" min={0} max={4294967295} value={recipe.seed} onChange={(e) => update('seed', Math.max(0, Math.min(4294967295, Math.round(Number(e.target.value)))))} /></label>
            <label className="ql-number">Cohort seed<input type="number" min={0} max={4294967295} value={recipe.cohort_seed} onChange={(e) => update('cohort_seed', Math.max(0, Math.min(4294967295, Math.round(Number(e.target.value)))))} /></label>
          </section>
        </fieldset>
        <button className="primary-button ql-run" disabled={busy} onClick={run}><Play size={14} />{busy ? 'Simulating EEG + peers…' : dirty ? 'Regenerate with changes' : 'Generate EEG + maps'}</button>
        <p className="ql-fixed">128 Hz · 32 s · 1/f background<br />Artifact-free teaching example; no ICA needed.</p>
        <button className="quiet-button" onClick={() => setImported(true)}>Advanced: imported EEG</button>
      </aside>
      <section className="canvas-panel ql-canvas">
        <header className="ql-toolbar"><div><span className="eyebrow">Synthetic EEG · educational use</span><h2>{view === 'Atlas' ? 'The frequency atlas' : view === 'Norms' ? 'A reference built in the open' : view === 'Geometry' ? 'From dipoles to electrodes' : view === 'Metrics' ? 'Inside the calculation' : 'The multichannel recording'}</h2></div><button className="quiet-button" disabled={!result || busy} onClick={download}><Download size={14} /> JSON</button></header>
        <div className="ql-tabs" role="tablist" aria-label="QEEG lesson views">{VIEWS.map((item, i) => <button role="tab" aria-selected={item === view} key={item} onClick={() => setView(item)}>{String(i + 1).padStart(2, '0')} {item}</button>)}</div>
        {dirty && <p className="ql-status" role="status">Controls changed. The figures still show the last generated recipe; regenerate to apply.</p>}
        {error && <p className="ql-error" role="alert">{error} <button onClick={run} disabled={busy}>Retry</button></p>}
        <div className="ql-stage" aria-busy={busy}>
          {!result && <div className="ql-loading"><Activity size={28} /><h3>{busy ? 'Generating the subject and reference peers…' : 'Ready to build a virtual recording.'}</h3><p>Six dipoles, a spherical head model, and a reproducible spectral recipe.</p></div>}
          {result && view === 'EEG' && <><p className="ql-caption">First 10 s of {result.channel_names.length}-channel simulated EEG · µV · {result.recipe.reference.replace('_', ' ')}</p><StackedEegBrowser x={result.time_s} series={Object.fromEntries(result.channel_names.map((name, i) => [name, result.eeg_uv[i]!]))} ariaLabel="Simulated QEEG multichannel recording" /></>}
          {result && view === 'Geometry' && <Geometry result={result} />}
          {result && view === 'Atlas' && <>
            <div className="ql-options"><Select label="Map quantity" value={power} options={['relative', 'absolute']} labels={['Relative power · %', 'Absolute power · µV²']} onChange={(v) => setPower(v as typeof power)} /><Select label="Frequency grouping" value={group} options={['frequency', 'bands']} labels={['1 Hz frequency atlas', 'Canonical bands']} onChange={setGroup} />{group === 'frequency' && <Select label="Frequency range" value={String(page)} options={['0', '1', '2']} labels={['1–16 Hz', '16–31 Hz', '31–45 Hz']} onChange={(v) => setPage(Number(v))} />}<Select label="Color scale" value={colorScale} options={['per_map', 'shared']} labels={['Per map · spatial pattern', 'Shared · compare power']} onChange={(v) => setColorScale(v as typeof colorScale)} /></div>
            <Atlas result={result} power={power} group={group} page={page} colorScale={colorScale} />
            <p className="ql-caption">Nose up · left of image = left hemisphere · dots = electrodes. Smooth fill uses inverse-distance weighting on projected template coordinates; peripheral colors are extrapolated. Color ranges are recalculated for each generated recipe. Blue and red indicate values within the displayed range, not below or above a normative population.</p>
          </>}
          {result && view === 'Metrics' && <>
            <div className="ql-options"><Select label="Inspect channel" value={channel} options={result.channel_names} onChange={setChannel} /></div>
            <LineChart x={result.metrics.frequency_hz} series={[{ label: `${channel} PSD`, values: result.metrics.psd[c]! }]} xLabel="Frequency (Hz)" yLabel="µV²/Hz (log scale)" logY height={240} ariaLabel={`${channel} power spectrum`} />
            <MetricTable result={result} c={c} />
            <div className="ql-options"><Select label="Alpha connectivity · 8–13 Hz" value={connection} options={['coherence', 'plv']} labels={['Magnitude-squared coherence', 'Phase locking value']} onChange={(v) => setConnection(v as typeof connection)} /></div>
            <p className="ql-caption">{connection === 'coherence' ? '|mean(Sxy)|² / [mean(Sxx) mean(Syy)], per frequency then band averaged; 15 overlapping Welch windows.' : '|mean(exp(i × phase difference))| over time after 8–13 Hz filtering and Hilbert transform; 1 s trimmed at each edge.'} Range 0–1; diagonal = 1. Shared sources and reference can create high values without direct coupling.</p>
            <ConnectivityHeatmap matrix={{ node_names: result.channel_names, values: result[connection], space: 'sensor', metric: connection === 'coherence' ? 'coh' : 'plv', band_hz: [8, 13] }} threshold={1.1} />
          </>}
          {result && view === 'Norms' && <>
            <div className="ql-options"><Select label="Metric" value={normMetric} options={['absolute', 'relative', 'theta_beta']} labels={['Log absolute power', 'Logit relative power', 'Log theta/beta ratio']} onChange={(v) => setNormMetric(v as typeof normMetric)} />{normMetric !== 'theta_beta' && <Select label="Band" value={String(band)} options={result.bands.map((_, i) => String(i))} labels={result.bands.map((b) => b.name)} onChange={(v) => setBand(Number(v))} />}<Select label="Channel" value={channel} options={result.channel_names} onChange={setChannel} /></div>
            <NormView result={result} metric={normMetric} band={normMetric === 'theta_beta' ? 0 : band} c={c} />
          </>}
        </div>
        <footer className="ql-provenance">{result ? `${result.channel_names.length} electrodes · ${result.recipe.reference.replace('_', ' ')} · seed ${result.recipe.seed} · ${result.recipe.cohort_size} synthetic peers · MNE ${result.provenance.mne}` : 'Local scientific engine'}{busy && result && ' · Regenerating…'}</footer>
      </section>
      <aside className="inspector-panel ql-inspector"><span className="eyebrow">Read the image</span><h2>{lesson.title}</h2><p>{lesson.text}</p><section><span className="eyebrow">Try one change</span><p>{lesson.experiment}</p></section><section><span className="eyebrow">The calculation chain</span><ol><li>Known source activity · nAm</li><li>Forward model → electrode EEG · µV</li><li>Reference → Welch PSD · µV²/Hz</li><li>Integrate → power · µV² or %</li><li>Interpolate → scalp image</li><li>Transform → synthetic-cohort z</li></ol></section><details><summary>Assumptions & sources</summary><p>Template positions, six radial dipoles and concentric 90 mm head spheres. No individual MRI or cortical localization. All spectra use [1, 45) Hz; band upper limits are excluded.</p><p>Norms are generated examples, not clinical norms. ±2 SD is a descriptive marker, not a corrected significance threshold or diagnosis. Testing many electrodes and bands creates multiple comparisons.</p><a href="https://mne.tools/stable/generated/mne.make_forward_solution.html" target="_blank" rel="noreferrer">MNE forward model</a><a href="https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.welch.html" target="_blank" rel="noreferrer">Welch power spectra</a><a href="https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.coherence.html" target="_blank" rel="noreferrer">Magnitude-squared coherence</a></details><p className="ql-norm-label">SIMULATED DATA<br />Educational reference only.</p></aside>
    </main>
  </>
}

function Slider({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return <label className="ql-slider"><span>{label}<b>{Number(value.toFixed(2))}</b></span><input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} /></label>
}
function Select({ label, value, options, labels, onChange }: { label: string; value: string; options: string[]; labels?: string[]; onChange: (value: string) => void }) {
  return <label className="select-field"><span>{label}</span><select value={value} onChange={(e) => onChange(e.target.value)}>{options.map((item, i) => <option key={item} value={item}>{labels?.[i] ?? item}</option>)}</select></label>
}
function Scale({ low = 0, high, unit, divergent = false }: { low?: number; high: number; unit: string; divergent?: boolean }) {
  return <div className="ql-scale"><span>{low.toFixed(1)}</span><i className={divergent ? 'divergent' : ''} /><span>{high.toFixed(1)} {unit}</span></div>
}
function Atlas({ result, power, group, page, colorScale }: {
  result: QeegResult; power: 'absolute' | 'relative'; group: string; page: number
  colorScale: 'per_map' | 'shared'
}) {
  const multiplier = power === 'relative' ? 100 : 1
  const all = (group === 'bands' ? result.metrics[power] : result[`atlas_${power}`])
    .map((row) => row.map((v) => v * multiplier))
  const sharedHigh = Math.max(...all.flat(), .001)
  const start = group === 'bands' ? 0 : page * 15
  const values = group === 'bands' ? all : all.slice(start, start + 15)
  const unit = power === 'relative' ? '%' : 'µV²'
  const local = colorScale === 'per_map'
  return <>
    <p className="ql-scale-note" role="note">{local
      ? 'Per-map scales · each map spans its own electrode minimum to maximum. Compare spatial patterns; equal colors across maps do not mean equal power. Small differences are also amplified.'
      : 'Shared scale · equal colors mean equal power across all frequency pages. A strong alpha peak can make weaker frequencies mostly blue.'}</p>
    {!local && <Scale high={sharedHigh} unit={unit} />}
    <div className={`ql-atlas ${group === 'bands' ? 'bands' : ''}`}>
      {values.map((row, i) => {
        const title = group === 'bands'
          ? `${result.bands[i]!.name} · ${result.bands[i]!.low}–${result.bands[i]!.high} Hz`
          : `${start + i + 1}–${start + i + 2} Hz`
        const low = local ? Math.min(...row) : 0
        const high = local ? Math.max(...row) : sharedHigh
        return <figure key={title}>
          <figcaption>{title}</figcaption>
          <QeegTopomap positions={result.positions_2d} names={result.channel_names}
            values={row} low={low} high={high} label={`${title} ${power} power, range ${low.toPrecision(3)} to ${high.toPrecision(3)} ${unit}`} />
          {local && <div className="ql-local-scale" aria-label={`${title} color range`}>
            <i /><span>{low.toPrecision(3)} – {high.toPrecision(3)} {unit}</span>
          </div>}
          <small>Mean {(row.reduce((a, b) => a + b, 0) / row.length).toFixed(2)} {unit}</small>
        </figure>
      })}
    </div>
  </>
}

function Geometry({ result }: { result: QeegResult }) {
  return <div className="ql-geometry"><div className="ql-geometry-pair"><figure><svg viewBox="0 0 250 250" role="img" aria-label="Concentric head model and six dipoles, superior view">{[100, 97, 92, 90].map((r, i) => <circle key={r} cx="125" cy="125" r={r} fill={['#e8d8c2', '#bfa992', '#d8e8e6', '#eef3ef'][i]} stroke="#7b918c" />)}<path d="M117 25 L125 12 L133 25" fill="none" stroke="#526e69" />{result.source_positions_m.map(([x = 0, y = 0], i) => <g key={i}><circle cx={125 + x / .09 * 100} cy={125 - y / .09 * 100} r="7" fill={i < 2 ? '#087f83' : i < 4 ? '#b96139' : '#685e93'} /><text x={125 + x / .09 * 100} y={110 - y / .09 * 100} fontSize="10" textAnchor="middle">{['α L', 'α R', 'θ L', 'θ R', 'β L', 'β R'][i]}</text></g>)}</svg><figcaption>Forward model · top view<br />Brain / CSF / skull / scalp</figcaption></figure><figure><QeegTopomap positions={result.positions_2d} names={result.channel_names} values={result.channel_names.map(() => 0)} low={-1} high={1} divergent labels label="Template electrode positions on scalp" /><figcaption>{result.channel_names.length} electrodes · standard_1020 template<br />Azimuthal equidistant projection</figcaption></figure></div><h3>EEG(t) = reference[G × sources(t) + noise(t)]</h3><p>G is computed with MNE’s spherical forward solver, using each dipole’s radial orientation and electrode coordinates in head space. The six source amplitudes are in nAm; sensor outputs are converted to µV.</p><dl className="ql-facts"><div><dt>Layer radii</dt><dd>81 / 82.8 / 87.3 / 90 mm</dd></div><div><dt>Conductivity · S/m</dt><dd>{result.conductivities_s_m.join(' / ')}</dd></div><div><dt>Reference equation</dt><dd>{result.recipe.reference === 'average' ? 'V′c = Vc − mean(all EEG channels)' : 'V′c = Vc − (VA1 + VA2) / 2'}</dd></div></dl><p>Template electrode coordinates are used as supplied; the head drawing is schematic. A1/A2 are simulated reference electrodes and are not atlas channels. The head model generates the EEG; the atlas only needs electrode positions and a channel metric.</p></div>
}
function MetricTable({ result: r, c }: { result: QeegResult; c: number }) {
  const m = r.metrics
  const rows = [
    ...r.bands.map((b, i) => [b.name + ' power', `Σ PSD(f) × 0.25 Hz; ${b.low} ≤ f < ${b.high}`, `${m.absolute[i]![c]!.toFixed(2)} µV²`, `${(m.relative[i]![c]! * 100).toFixed(2)}% of 1–45 Hz`]),
    ['Theta / beta', 'P[4,8) / P[13,30)', m.theta_beta[c]!.toFixed(3), 'Dimensionless; no diagnostic cutoff'],
    ['Alpha peak', 'argmax PSD in [8,13) Hz', `${m.alpha_peak_hz[c]!.toFixed(2)} Hz`, 'Maximum bin; no peak prominence test'],
    ['Median frequency', 'First bin reaching 50% of 1–45 Hz power', `${m.median_hz[c]!.toFixed(2)} Hz`, 'Spectral median'],
    ['SEF95', 'First bin reaching 95% of 1–45 Hz power', `${m.sef95_hz[c]!.toFixed(2)} Hz`, 'Spectral edge frequency'],
    ['Spectral entropy', '−Σ p(f) ln p(f) / ln(number of bins)', m.entropy[c]!.toFixed(3), '0 concentrated → 1 uniform spectrum'],
    ['Frontal alpha asymmetry', 'ln Pα(F4) − ln Pα(F3)', r.frontal_alpha_asymmetry.toFixed(3), 'Fixed F4/F3 pair; positive = more right power'],
  ]
  return <table className="ql-table"><caption>Channel {r.channel_names[c]} · definitions and values</caption><thead><tr><th>Metric</th><th>Calculation</th><th>Value</th><th>Meaning / relative value</th></tr></thead><tbody>{rows.map(([name, formula, value, note]) => <tr key={name}><th>{name}</th><td>{formula}</td><td>{value}</td><td>{note}</td></tr>)}</tbody></table>
}
function NormView({ result: r, metric, band, c }: { result: QeegResult; metric: 'absolute' | 'relative' | 'theta_beta'; band: number; c: number }) {
  const n = r.norms[metric]; const subject = n.subject[band]![c]!; const mean = n.mean[band]![c]!; const sd = n.sd[band]![c]!
  const values = n.cohort_values.map((v) => v[band]![c]!); const low = Math.min(...values, subject) - .1; const high = Math.max(...values, subject) + .1
  const sx = (v: number) => 30 + (v - low) / (high - low) * 540
  const transform = metric === 'absolute' ? 'ln(power in µV²)' : metric === 'relative' ? 'ln(p / (1 − p)), p = relative fraction' : 'ln(theta/beta)'
  return <div className="ql-norms"><p className="ql-synthetic">SYNTHETIC NORMATIVE EXAMPLE · N = {r.recipe.cohort_size} · no clinical population</p><div className="ql-norm-pair"><figure><QeegTopomap positions={r.positions_2d} names={r.channel_names} values={n.z[band]!} low={-3} high={3} divergent labels label="Synthetic normative z score scalp map" /><Scale low={-3} high={3} unit="z" divergent /><figcaption>Fixed ±3 scale; colors saturate outside this range.</figcaption></figure><div><span className="eyebrow">{r.channel_names[c]} · {metric === 'theta_beta' ? 'Theta / beta' : r.bands[band]!.name}</span><h3>z = (subject − mean) / SD</h3><p className="ql-equation">({subject.toFixed(3)} − {mean.toFixed(3)}) / {sd.toFixed(3)}<br /><strong>= {n.z[band]![c]!.toFixed(2)}</strong></p><p>Empirical percentile: <b>{n.percentile[band]![c]!.toFixed(1)}%</b><br />Transform: {transform}<br />SD uses N − 1 in the denominator.</p></div></div><figure className="ql-distribution"><figcaption>{r.channel_names[c]} · individual peers on the transformed scale</figcaption><svg viewBox="0 0 600 140" role="img" aria-label="Synthetic cohort distribution with subject and cohort mean"><line x1="30" x2="570" y1="100" y2="100" stroke="#bdc9c5" />{values.map((v, i) => <circle key={i} cx={sx(v)} cy={55 + (i % 5) * 8} r="3" fill="#527f7a" opacity=".6"><title>Peer {i + 1}: {v.toFixed(3)}</title></circle>)}<line x1={sx(mean)} x2={sx(mean)} y1="40" y2="103" stroke="#253f3e" strokeDasharray="3 3" /><line x1={sx(subject)} x2={sx(subject)} y1="24" y2="103" stroke="#c05d38" strokeWidth="2" /><text x={Math.max(60, Math.min(540, sx(subject)))} y="17" textAnchor="middle" fill="#a44220" fontSize="12">Subject</text><text x="30" y="124" fontSize="11">{low.toFixed(2)}</text><text x="570" y="124" textAnchor="end" fontSize="11">{high.toFixed(2)}</text></svg><p className="ql-caption">Dots: independent simulated peers · dashed line: cohort mean · orange line: subject. Percentile = fraction below + half of ties; no Gaussian tail probability assumed.</p></figure><details><summary>How the reference population is generated</summary><p>For each peer: source alpha/theta/beta amplitudes = (18, 9, 7) nAm × lognormal(0, 0.22); alpha peak = clipped Normal(10, 0.45) Hz within 8–12 Hz; right alpha gain = lognormal(0, 0.12). New phases, independent 1/f background and 0.7 µV sensor noise are sampled for every recording.</p><p>Every peer passes through the same forward model, reference and Welch pipeline. These assumed distributions are teaching choices. Transformations reduce skew but do not guarantee Gaussianity. A real normative study must justify population, age/state matching, acquisition and reference compatibility, quality criteria, external validation and multiple-testing decisions.</p></details></div>
}
