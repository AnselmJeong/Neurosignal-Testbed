import { useState, type ReactNode } from 'react'

import { LineChart } from '../../components/Charts'
import {
  channelLabels,
  datasetLabel,
  formatPercent,
  formatProbability,
  formatValue,
  matrixRange,
  netFlows,
  truthCells,
} from './model'
import {
  DirectedMatrix,
  Formula,
  PidLegend,
  PidStackedBar,
  SignedBars,
  SourceGraph,
  StatusBadge,
  StatusNote,
} from './Visuals'
import type {
  ActivityFlowMethod,
  ConceptCatalog,
  EffectiveMethod,
  FlowDataset,
  FlowResult,
  GcMethod,
  MethodBase,
  ModelComparison,
  PidMethod,
  SourceEvaluation,
  SourceScore,
  SpuriousCheck,
  TeGaussianMethod,
  TeKsgMethod,
  TimeReversedMethod,
} from './types'

// ------------------------------------------------------------------ shared pieces

interface CardProps {
  result: FlowResult
  dataset: FlowDataset
  catalog: ConceptCatalog | null
}

function Segmented<T extends string>({ label, options, value, onChange }: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flw-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={option.value === value} className={option.value === value ? 'active' : ''} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  )
}

function CardFrame({ conceptId, catalog, fallbackTitle, shortName, statuses, children }: {
  conceptId: string
  catalog: ConceptCatalog | null
  fallbackTitle: string
  shortName: string
  statuses: { label: string; status: string }[]
  children: ReactNode
}) {
  const concept = catalog?.entries.find((entry) => entry.id === conceptId) ?? null
  return (
    <article className="flw-card" aria-label={`${shortName} 방법 카드`} data-testid={`card-${conceptId}`}>
      <header className="flw-card-head">
        <span className="flw-card-id">{concept?.flow_id ?? concept?.short_name ?? shortName}</span>
        <div>
          <span className="eyebrow">{concept?.level ? `Level ${concept.level}` : 'Level —'}{concept?.related_metric_id ? ` · ${concept.related_metric_id}` : ''}</span>
          <h3>{concept?.title ?? fallbackTitle}</h3>
        </div>
        <div className="flw-card-statuses">
          {statuses.map((item) => <span key={item.label}><small>{item.label}</small><StatusBadge status={item.status} /></span>)}
        </div>
      </header>
      {concept ? (
        <div className="flw-card-concept">
          <div><span className="flw-k">답하는 질문</span><p>{concept.question_answered}</p></div>
          <div><span className="flw-k">수식</span><Formula latex={concept.formula} label={`${concept.short_name} 수식`} /></div>
          <div className="wide"><span className="flw-k">직관</span><p>{concept.intuition}</p></div>
        </div>
      ) : <p className="flw-note">개념 설명을 불러오지 못했습니다. 결과만 표시합니다.</p>}
      <section className="flw-card-result" aria-label={`${shortName} 결과`}>{children}</section>
      {concept && (
        <section className="flw-limits" aria-label={`${shortName}이 말해줄 수 있는 것과 없는 것`}>
          <div><strong>이 실습에서 보여줄 수 있는 것</strong><p>{concept.what_this_simulation_can_show}</p></div>
          <div><strong>말해줄 수 없는 것 · 한계</strong><ul>{concept.limitations.map((item) => <li key={item}>{item}</li>)}</ul></div>
        </section>
      )}
    </article>
  )
}

const methodOf = <T extends MethodBase>(dataset: FlowDataset, id: string) => dataset.methods[id] as T | undefined
const statusOf = (dataset: FlowDataset, id: string) => dataset.methods[id]?.status ?? 'missing'

function MissingOrStatus({ method }: { method: MethodBase | undefined }) {
  if (!method) return <StatusNote status="missing" reasonCode={null} message="이 결과에는 해당 방법의 출력이 없습니다." />
  return <StatusNote status={method.status} reasonCode={method.reason_code} message={method.message} />
}

const sourceEvaluation = (result: FlowResult, dataset: FlowDataset): SourceEvaluation | undefined =>
  dataset.space === 'source' ? result.evaluation?.source.find((item) => item.dataset_id === dataset.dataset_id) : undefined

/** Truth-based scores — only ever shown for source-space datasets, after results were frozen. */
function SourceScoreSummary({ score, G }: { score: SourceScore | undefined; G: number }) {
  if (!score) return null
  const auc = score.edge_auc
  const sig = score.significance
  return (
    <div className="flw-score" aria-label={`${score.label} 정답 비교`}>
      <span className="eyebrow">정답 비교 · 소스 공간</span>
      <dl>
        <div><dt>간선 AUC</dt><dd>{auc && typeof auc.auc === 'number' ? auc.auc.toFixed(2) : auc?.status === 'not_applicable' ? '해당 없음' : '—'}</dd></div>
        {score.direction && <div><dt>방향 정확도</dt><dd>{formatPercent(score.direction.accuracy)}</dd></div>}
        {sig && <div><dt>참 양성</dt><dd>{sig.true_positives} / {sig.n_edges_tested}</dd></div>}
        {sig && <div><dt>거짓 양성</dt><dd data-testid={`fp-${score.label}`}>{sig.false_positives} / {sig.n_non_edges_tested}</dd></div>}
      </dl>
      {auc?.note && <p className="flw-muted">{auc.note}</p>}
      {G === 0 && sig && <p className="flw-muted">G=0에서는 활성 간선이 없으므로 유의한 쌍은 모두 거짓 양성입니다.</p>}
    </div>
  )
}

const yesNo = (value: boolean | null | undefined) => (value === true ? '검출' : value === false ? '미검출' : '—')

function SpuriousTable({ checks }: { checks: SpuriousCheck[] }) {
  if (!checks.length) return null
  return (
    <div className="flw-table-wrap">
      <table className="flw-small-table" aria-label="직접 간선이 없는 쌍에서의 허위 GC">
        <caption>직접 간선이 없는 쌍 · 쌍별 GC는 공통 입력·간접 경로를 걸러내지 못합니다</caption>
        <thead><tr><th scope="col">쌍</th><th scope="col">구조</th><th scope="col">쌍별 GC</th><th scope="col">조건부 GC</th></tr></thead>
        <tbody>
          {checks.map((check) => (
            <tr key={`${check.kind}-${check.pair.join('-')}`}>
              <th scope="row">{check.pair.join(' ↔ ')}</th>
              <td>{check.kind === 'fork_siblings' ? `공통 구동자 ${check.driver ?? '?'}` : `간접 경로 (경유 ${check.via ?? '?'})`}</td>
              <td className={check.spurious_detected_pairwise ? 'bad' : ''}>{yesNo(check.spurious_detected_pairwise)}</td>
              <td className={check.spurious_detected_conditional ? 'bad' : ''}>{yesNo(check.spurious_detected_conditional)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SensorMappingNote({ result, dataset }: { result: FlowResult; dataset: FlowDataset }) {
  if (dataset.space === 'source') return null
  const mapping = result.display_channels?.mapping ?? {}
  return (
    <p className="flw-note">
      센서 채널은 소스가 아니므로 정답 테두리·그래프 화살표를 그리지 않습니다. 소스에서 가장 가까운 전극: {Object.entries(mapping).map(([node, item]) => `${node}→${item.channel}`).join(', ') || '—'}
      {result.display_channels?.has_duplicate_channels ? ' (서로 다른 소스가 같은 전극에 대응합니다)' : ''}.
    </p>
  )
}

// ------------------------------------------------------------------ Granger causality

type GcVariant = 'gc_conditional' | 'gc_pairwise' | 'gc_time_reversed'
const GC_LABELS: Record<GcVariant, string> = { gc_conditional: '조건부 GC', gc_pairwise: '쌍별 GC', gc_time_reversed: '시간 역전 net' }

export function GrangerCard({ result, dataset, catalog }: CardProps) {
  const [variant, setVariant] = useState<GcVariant>('gc_conditional')
  const method = methodOf<GcMethod & TimeReversedMethod>(dataset, variant)
  const evaluation = sourceEvaluation(result, dataset)
  const ok = method?.status === 'ok' && method.values
  const signed = variant === 'gc_time_reversed'
  const threshold = method?.significance?.bonferroni_threshold ?? null
  const truth = truthCells(dataset, result.recipe.graph.edges)
  return (
    <CardFrame conceptId="granger_causality" catalog={catalog} shortName="GC" fallbackTitle="Granger causality"
      statuses={(Object.keys(GC_LABELS) as GcVariant[]).map((id) => ({ label: GC_LABELS[id], status: statusOf(dataset, id) }))}>
      <Segmented label="GC 변형" value={variant} onChange={setVariant} options={(Object.keys(GC_LABELS) as GcVariant[]).map((id) => ({ value: id, label: GC_LABELS[id] }))} />
      {!ok ? <MissingOrStatus method={method} /> : (
        <div className="flw-result-grid">
          <DirectedMatrix values={method.values!} labels={channelLabels(dataset)} range={matrixRange(method.values, signed)} pValues={method.p_values} threshold={threshold}
            truth={truth} units={method.units} ariaLabel={`${GC_LABELS[variant]} 행렬 [target × source] · ${datasetLabel(dataset.dataset_id)}`} />
          <div className="flw-result-side">
            {dataset.space === 'source' && !signed && (
              <SourceGraph nodes={result.recipe.graph.nodes.map((node) => node.id)} edges={result.recipe.graph.edges} truthStyle="dashed"
                flows={netFlows(dataset, method.values, method.p_values, threshold)} ariaLabel={`${GC_LABELS[variant]} 순 흐름 화살표`}
                caption="회색 점선 = 정답 그래프 · 청록 화살표 = 우세 방향이 Bonferroni 유의한 쌍 (굵기 ∝ 순 흐름)" />
            )}
            <SensorMappingNote result={result} dataset={dataset} />
            <dl className="flw-stats">
              {method.order != null && <div><dt>VAR 차수 p</dt><dd>{method.order}</dd></div>}
              {method.significance && <div><dt>유의 쌍 (Bonferroni)</dt><dd data-testid="gc-significant">{method.significance.n_significant_bonferroni} / {method.significance.n_tested}</dd></div>}
              {method.conditioning && <div><dt>조건화</dt><dd>{method.conditioning}</dd></div>}
              {method.order_policy && <div><dt>차수 정책</dt><dd>{method.order_policy}</dd></div>}
            </dl>
            {signed && <p className="flw-muted">{method.reading ?? 'net = GC(정방향) − GC(시간 역전).'} 순간 혼합(볼륨 전도)만 있는 쌍은 시간을 뒤집어도 방향이 바뀌지 않아 net ≈ 0에 가깝습니다.</p>}
            {!signed && <SourceScoreSummary score={evaluation?.scores[variant]} G={dataset.G} />}
          </div>
        </div>
      )}
      {evaluation && variant !== 'gc_time_reversed' && <SpuriousTable checks={[...(evaluation.fork_spurious ?? []), ...(evaluation.chain_indirect ?? [])]} />}
    </CardFrame>
  )
}

// ------------------------------------------------------------------ transfer entropy

type TeVariant = 'te_gaussian' | 'te_ksg'
const TE_LABELS: Record<TeVariant, string> = { te_gaussian: 'Gaussian TE', te_ksg: 'KSG TE' }
const KSG_FLAGS: Record<string, string> = {
  no_surrogate_test: '대리자료(surrogate) 검정을 하지 않아 p값이 없습니다. 유의성은 판정하지 않습니다.',
  underpowered_surrogate_test: '대리자료 수가 적어 최소 p값이 Bonferroni 기준에 닿을 수 없습니다 (검정력 부족). 유의성을 읽으려면 ≥ 499개가 필요합니다.',
  ksg_finite_sample_bias_uncorrected: 'KSG 추정치는 유한 표본 편향을 보정하지 않았습니다. 값을 절대 정보량으로 읽지 마세요.',
}

export function TransferEntropyCard({ result, dataset, catalog }: CardProps) {
  const [variant, setVariant] = useState<TeVariant>('te_gaussian')
  const method = methodOf<TeGaussianMethod & TeKsgMethod>(dataset, variant)
  const evaluation = sourceEvaluation(result, dataset)
  const ok = method?.status === 'ok' && method.values
  const threshold = method?.significance?.bonferroni_threshold ?? null
  const identity = method?.gc_te_identity
  return (
    <CardFrame conceptId="transfer_entropy" catalog={catalog} shortName="TE" fallbackTitle="Transfer entropy"
      statuses={(Object.keys(TE_LABELS) as TeVariant[]).map((id) => ({ label: TE_LABELS[id], status: statusOf(dataset, id) }))}>
      <Segmented label="TE 추정기" value={variant} onChange={setVariant} options={(Object.keys(TE_LABELS) as TeVariant[]).map((id) => ({ value: id, label: TE_LABELS[id] }))} />
      {!ok ? <MissingOrStatus method={method} /> : (
        <div className="flw-result-grid">
          <DirectedMatrix values={method.values!} labels={channelLabels(dataset)} range={matrixRange(method.values, false)} pValues={method.p_values} threshold={threshold}
            truth={truthCells(dataset, result.recipe.graph.edges)} units={method.units} ariaLabel={`${TE_LABELS[variant]} 행렬 [target × source] · ${datasetLabel(dataset.dataset_id)}`} />
          <div className="flw-result-side">
            <SensorMappingNote result={result} dataset={dataset} />
            <dl className="flw-stats">
              {method.parameters && <div><dt>임베딩</dt><dd>k={String(method.parameters.k_hist)}, l={String(method.parameters.l_hist)}, lag={String(method.parameters.lag)}</dd></div>}
              <div><dt>p값</dt><dd>{method.p_value_method === 'none' ? '계산 안 함' : method.p_value_method ?? '—'}</dd></div>
              {method.significance && <div><dt>유의 쌍 (Bonferroni)</dt><dd>{method.significance.n_significant_bonferroni} / {method.significance.n_tested}</dd></div>}
              {method.pairs && <div><dt>계산한 쌍</dt><dd>{method.pairs.length}개 (선언한 모티프 쌍만)</dd></div>}
            </dl>
            {variant === 'te_gaussian' && identity?.status === 'ok' && (
              <p className="flw-muted">선형 Gaussian 검산 ({identity.pair}, p={identity.order}): TE = {formatValue(identity.gaussian_te_k_eq_l_eq_order, 4)} · GC/2 = {formatValue(identity.half_pairwise_gc, 4)}. 같은 차수면 Gaussian TE는 GC의 절반과 같습니다.</p>
            )}
            {variant === 'te_gaussian' && <p className="flw-muted">짧은 임베딩(k=l=2)에 분석적 χ² p값을 쓰면 목표의 자기상관이 남아 G=0에서도 거짓 양성이 많아집니다.</p>}
            {variant === 'te_ksg' && method.pair_selection && <p className="flw-muted">{method.pair_selection}</p>}
            {variant === 'te_ksg' && (method.flags ?? []).length > 0 && (
              <ul className="flw-flags" aria-label="KSG 주의 플래그">
                {method.flags!.map((flag) => <li key={flag}><code>{flag}</code> {KSG_FLAGS[flag] ?? ''}</li>)}
              </ul>
            )}
            <SourceScoreSummary score={evaluation?.scores[variant]} G={dataset.G} />
          </div>
        </div>
      )}
    </CardFrame>
  )
}

// ------------------------------------------------------------------ effective model (DCM-style)

const MODEL_LABELS: Record<string, string> = { forward: '정방향', backward: '역방향', bidirectional: '양방향', none: '간선 없음', common_input: '공통 입력' }

function ModelComparisonView({ comparison, expected }: {
  comparison: ModelComparison
  expected: { expected_model: string; match: boolean | null; posterior_of_expected: number | null } | undefined
}) {
  const bics = comparison.models.map((model) => model.bic).filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const best = bics.length ? Math.min(...bics) : null
  return (
    <section className="flw-model" aria-label={`모델 비교 ${comparison.name}`}>
      <div className="flw-model-head">
        <strong>{comparison.name}</strong>
        <span>{comparison.nodes.join(' · ')}{comparison.driver_node ? ` (구동자 후보 ${comparison.driver_node})` : ''}</span>
        {comparison.var_order != null && <small>VAR(p={comparison.var_order}) · BIC 선택</small>}
      </div>
      {comparison.status !== 'ok' ? <StatusNote status={comparison.status} reasonCode={comparison.reason_code} message={comparison.message} /> : (
        <>
          <ul className="flw-evidence" aria-label={`${comparison.name} 모델 사후확률`}>
            {comparison.models.map((model) => (
              <li key={model.name} className={model.name === comparison.best_model ? 'best' : ''}>
                <span className="flw-evidence-label">{MODEL_LABELS[model.name] ?? model.name}<small>{comparison.hypothesis_labels[model.name] ?? ''}</small></span>
                {model.status === 'ok' && typeof model.posterior === 'number'
                  ? <span className="flw-evidence-track"><i style={{ width: `${model.posterior * 100}%` }} /></span>
                  : <span className="flw-evidence-track"><StatusBadge status={model.status} /></span>}
                <span className="flw-evidence-value">{formatProbability(model.posterior)}<small>ΔBIC {best !== null && typeof model.bic === 'number' ? (model.bic - best).toFixed(1) : '—'}</small></span>
              </li>
            ))}
          </ul>
          <p className="flw-model-verdict">
            선택: <b data-testid={`best-${comparison.name}`}>{MODEL_LABELS[comparison.best_model ?? ''] ?? comparison.best_model ?? '—'}</b>
            {expected && <> · 정답: <b>{MODEL_LABELS[expected.expected_model] ?? expected.expected_model}</b> <span className={expected.match ? 'flw-match ok' : 'flw-match bad'}>{expected.match ? '일치' : '불일치'}</span></>}
          </p>
        </>
      )}
    </section>
  )
}

export function EffectiveModelCard({ result, dataset, catalog }: CardProps) {
  const method = methodOf<EffectiveMethod>(dataset, 'effective_model')
  const evaluation = sourceEvaluation(result, dataset)
  const mismatches = (evaluation?.model_comparisons ?? []).filter((item) => item.match === false)
  return (
    <CardFrame conceptId="effective_model" catalog={catalog} shortName="DCM-style" fallbackTitle="DCM 정신의 선형 유효 연결 모델"
      statuses={[{ label: '모델 비교', status: statusOf(dataset, 'effective_model') }]}>
      {method?.status !== 'ok' ? <MissingOrStatus method={method} /> : (
        <>
          <div className="flw-models">
            {(method.comparisons ?? []).map((comparison) => (
              <ModelComparisonView key={comparison.name} comparison={comparison} expected={evaluation?.model_comparisons?.find((item) => item.name === comparison.name)} />
            ))}
          </div>
          {dataset.space === 'source' && dataset.G > 0 && (
            <p className={mismatches.length ? 'flw-lesson warn' : 'flw-lesson'} data-testid="effective-lesson">
              {mismatches.length
                ? `이 실행에서 선형 VAR(p) 모델 비교는 ${mismatches.map((item) => `${item.name}(${MODEL_LABELS[item.best_model ?? ''] ?? item.best_model}≠${MODEL_LABELS[item.expected_model] ?? item.expected_model})`).join(', ')}에서 정답과 다른 모델을 골랐습니다. 비선형 Jansen-Rit 결합을 선형 모델로 근사하면 사후확률이 높아도 방향을 잘못 귀속할 수 있습니다.`
                : '이 실행에서는 모든 비교가 정답 모델을 골랐습니다. 다만 후보에 없는 모델(숨은 입력, 비선형성)은 평가되지 않았습니다.'}
            </p>
          )}
          {dataset.space === 'source' && dataset.G === 0 && <p className="flw-lesson">G=0 대조: 정답은 모든 모티프에서 ‘간선 없음’입니다.</p>}
          {dataset.space !== 'source' && <p className="flw-lesson warn">센서 채널에서의 모델 비교는 볼륨 전도가 섞인 신호를 잠재 상태로 간주하므로 방향 결론을 내리면 안 됩니다. 정답 비교는 하지 않습니다.</p>}
          {(method.flags ?? []).includes('var1_residuals_not_white') && <p className="flw-muted">잔차가 백색 잡음이 아닙니다 (Ljung-Box) — 모델 오지정의 신호입니다. 오지정 비교: {(method.misspecified_comparisons ?? []).join(', ') || '—'}.</p>}
          {method.values && (
            <details className="flw-details">
              <summary>연속시간 유효 연결 A[target × source] ({method.units ?? '1/s'})</summary>
              <DirectedMatrix values={method.values} labels={channelLabels(dataset)} range={matrixRange(method.values, true)} truth={truthCells(dataset, result.recipe.graph.edges)}
                units={method.units} ariaLabel={`유효 연결 행렬 A · ${datasetLabel(dataset.dataset_id)}`} />
            </details>
          )}
          {method.method_note && <p className="flw-muted">{method.method_note}</p>}
        </>
      )}
    </CardFrame>
  )
}

// ------------------------------------------------------------------ activity flow

type Estimator = 'pearson' | 'regression'
const ESTIMATOR_LABELS: Record<Estimator, string> = { pearson: 'Pearson FC', regression: '다중회귀 FC' }

export function ActivityFlowCard({ dataset, catalog }: CardProps) {
  const [estimator, setEstimator] = useState<Estimator>('pearson')
  const method = methodOf<ActivityFlowMethod>(dataset, 'activity_flow')
  const summary = method?.summary
  const prediction = summary?.predictions[estimator]
  const labels = channelLabels(dataset)
  const exampleLabel = summary ? labels[summary.example_channel] ?? `ch ${summary.example_channel}` : ''
  const actual = (summary?.example_actual ?? []).map((value) => value ?? Number.NaN)
  const predicted = (summary?.example_predicted[estimator] ?? []).map((value) => value ?? Number.NaN)
  const without = method?.without_neighbor_exclusion?.comparison
  return (
    <CardFrame conceptId="activity_flow" catalog={catalog} shortName="Activity flow" fallbackTitle="Activity flow mapping"
      statuses={[{ label: '예측', status: statusOf(dataset, 'activity_flow') }]}>
      {method?.status !== 'ok' || !summary ? <MissingOrStatus method={method} /> : (
        <>
          <Segmented label="FC 추정기" value={estimator} onChange={setEstimator} options={(Object.keys(ESTIMATOR_LABELS) as Estimator[]).map((id) => ({ value: id, label: ESTIMATOR_LABELS[id] }))} />
          <div className="flw-result-stack">
            <div className="flw-trace">
              <LineChart x={actual.map((_, i) => i / dataset.sfreq)} height={230}
                series={[{ label: `실제 ${exampleLabel}`, values: actual, color: '#7d817a' }, { label: `예측 (${ESTIMATOR_LABELS[estimator]})`, values: predicted, color: '#087f83', dashed: true }]}
                xLabel="TEST 구간 시간 (s)" yLabel={`${method.activity ?? 'activity'} (z)`} ariaLabel={`${exampleLabel} 실제 활동과 ${ESTIMATOR_LABELS[estimator]} 예측`} />
            </div>
            <div className="flw-result-side">
              <dl className="flw-stats">
                <div><dt>평균 r (예측–실제)</dt><dd data-testid="af-mean-r">{formatValue(prediction?.mean_r, 2)}</dd></div>
                <div><dt>평균 R²</dt><dd>{formatValue(prediction?.mean_r2, 2)}</dd></div>
                <div><dt>활동</dt><dd>{method.activity}{method.band ? ` ${method.band.join('–')} Hz` : ''}</dd></div>
                <div><dt>TRAIN / TEST</dt><dd>{summary.train_samples.join('–')} / {summary.test_samples.join('–')}</dd></div>
              </dl>
              <p className="flw-lesson" data-testid="af-why-r">
                {estimator === 'pearson'
                  ? 'Pearson FC 예측은 상관계수를 그대로 더하므로 예측의 크기(scale)가 실제와 어긋납니다. 그래서 R²는 크게 음수가 될 수 있고, 모양이 맞는지를 보는 r(예측–실제 상관)로 판단합니다.'
                  : '다중회귀 FC는 TRAIN 구간에서 크기까지 맞춰 적합하므로 R²도 의미가 있습니다. 그래도 비교 기준은 r입니다.'}
              </p>
              {dataset.space !== 'source' && (
                <p className="flw-muted">
                  {method.neighbor_exclusion ? `반경 ${(method.neighbor_exclusion.radius_m * 100).toFixed(0)} cm 이내 이웃 전극을 예측변수에서 뺐습니다 (${summary.n_excluded_predictors}개).` : '이웃 전극 제외 없음.'}
                  {without ? ` 제외하지 않으면 평균 r: Pearson ${formatValue(without.pearson?.mean_r, 2)}, 회귀 ${formatValue(without.regression?.mean_r, 2)}.` : ''}
                  {' '}센서에서는 같은 소스가 여러 전극에 섞여 G=0에서도 예측이 잘 됩니다 — 이것은 정보 흐름의 증거가 아닙니다.
                </p>
              )}
            </div>
          </div>
          {prediction && (
            <SignedBars ariaLabel={`채널별 r · ${ESTIMATOR_LABELS[estimator]}`}
              items={labels.map((label, i) => ({ label, value: prediction.r[i] ?? null, note: prediction.channel_status[i] ?? '계산 안 됨' }))} />
          )}
        </>
      )}
    </CardFrame>
  )
}

// ------------------------------------------------------------------ PID

const TEACHING_ORDER = ['xor', 'redundant', 'unique', 'and', 'copy']

export function PidCard({ result, dataset, catalog }: CardProps) {
  const method = methodOf<PidMethod>(dataset, 'pid')
  const evaluation = sourceEvaluation(result, dataset)
  const triplets = method?.triplets ?? []
  const scale = Math.max(1e-12, ...triplets.map((triplet) => triplet.bits?.i_s12_t ?? 0))
  const teaching = result.pid_teaching?.discrete_williams_beer ?? {}
  return (
    <CardFrame conceptId="pid" catalog={catalog} shortName="PID" fallbackTitle="Partial information decomposition"
      statuses={[{ label: '시간지연 PID', status: statusOf(dataset, 'pid') }]}>
      <PidLegend />
      {method?.status !== 'ok' ? <MissingOrStatus method={method} /> : (
        <div className="flw-pid-block" aria-label="시뮬레이션 데이터 PID">
          <span className="eyebrow">시뮬레이션 · 측도 {method.measure?.toUpperCase() ?? '—'} (Gaussian) · 소스 과거 → 목표 미래 · bits</span>
          {triplets.map((triplet) => {
            const truth = evaluation?.pid?.find((item) => item.name === triplet.name)
            return triplet.status !== 'ok' || !triplet.bits
              ? <StatusNote key={triplet.name} status={triplet.status} reasonCode={triplet.reason_code} message={triplet.message} />
              : (
                <div key={triplet.name}>
                  <PidStackedBar label={triplet.name} units="bits" scale={scale} sourceLabels={[triplet.source_nodes[0] ?? 'S1', triplet.source_nodes[1] ?? 'S2']}
                    note={`${triplet.source_nodes.join(', ')} → ${triplet.target_node} · I(S1,S2;T) = ${formatValue(triplet.bits.i_s12_t, 4)} bits`}
                    parts={{ redundancy: triplet.bits.redundancy, unique1: triplet.bits.unique_s1, unique2: triplet.bits.unique_s2, synergy: triplet.bits.synergy }} />
                  {truth && dataset.G > 0 && <p className="flw-muted">정답 그래프: {Object.entries(truth.target_receives_from).map(([node, receives]) => `${triplet.target_node}는 ${node}에게서 ${receives ? '받음' : '받지 않음'}`).join(' · ')}</p>}
                </div>
              )
          })}
          {dataset.space !== 'source' && <p className="flw-muted">센서 공간에서는 볼륨 전도가 채널 사이에 공유 정보를 만들어 중복정보(R)를 부풀립니다.</p>}
        </div>
      )}
      {Object.keys(teaching).length > 0 && (
        <div className="flw-pid-block" aria-label="이산 교육용 PID 예시">
          <span className="eyebrow">교육용 이산 예시 · 측도 Williams-Beer I_min · bits</span>
          {TEACHING_ORDER.filter((key) => teaching[key]).map((key) => {
            const example = teaching[key]!
            return (
              <div key={key}>
                {example.status !== 'ok' || !example.bits
                  ? <StatusNote status={example.status} reasonCode={example.reason_code} message={example.message} />
                  : <PidStackedBar label={key.toUpperCase()} units="bits" scale={2} note={example.description}
                    parts={{ redundancy: example.bits.redundancy, unique1: example.bits.unique_s1, unique2: example.bits.unique_s2, synergy: example.bits.synergy }} />}
                {key === 'copy' && (
                  <PidStackedBar label="COPY · BROJA/I_ccs" units="bits" scale={2}
                    note="문헌 값 (Harder et al. 2013) · 이 앱이 계산한 값이 아닙니다"
                    parts={{ redundancy: 0, unique1: 1, unique2: 1, synergy: 0 }} />
                )}
              </div>
            )
          })}
          <p className="flw-lesson warn" data-testid="pid-measure-lesson">
            같은 COPY 데이터 T=(X1, X2)인데 I_min은 R=1, S=1비트(U1=U2=0)를, BROJA·I_ccs는 U1=U2=1비트를 줍니다. PID 분할은 중복정보 측도에 따라 달라지므로 결과에는 항상 측도 이름을 함께 적어야 합니다.
          </p>
        </div>
      )}
    </CardFrame>
  )
}

// ------------------------------------------------------------------ Level 2

export function ContentLevelCard({ dataset, catalog }: CardProps) {
  const method = methodOf<MethodBase>(dataset, 'level2_content_decoding')
  return (
    <CardFrame conceptId="level2_content" catalog={catalog} shortName="Level 2" fallbackTitle="Level 2. 정보 전송 (Content)"
      statuses={[{ label: '내용 디코딩', status: statusOf(dataset, 'level2_content_decoding') }]}>
      <MissingOrStatus method={method} />
    </CardFrame>
  )
}

/** One card per method family, in the order of the source document. */
export function MethodCards(props: CardProps) {
  return (
    <div className="flw-cards">
      <GrangerCard {...props} />
      <TransferEntropyCard {...props} />
      <EffectiveModelCard {...props} />
      <ActivityFlowCard {...props} />
      <PidCard {...props} />
      <ContentLevelCard {...props} />
    </div>
  )
}
