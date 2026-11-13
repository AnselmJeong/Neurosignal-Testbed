import { useState } from 'react'

import {
  channelLabels,
  datasetLabel,
  findDataset,
  formatPercent,
  formatValue,
  offDiagonal,
  significantFraction,
  spaceKey,
  spacesOf,
  truthCells,
  valueRange,
  CONDITION_LABELS,
  SPACE_LABELS,
} from './model'
import { DirectedMatrix, StatusNote } from './Visuals'
import type { ActivityFlowMethod, ConceptCatalog, FlowDataset, FlowResult, MethodBase } from './types'

type CompareMethod = 'gc_pairwise' | 'gc_conditional' | 'te_gaussian'
const METHOD_LABELS: Record<CompareMethod, string> = { gc_pairwise: '쌍별 GC', gc_conditional: '조건부 GC', te_gaussian: 'Gaussian TE' }

const fractionOf = (dataset: FlowDataset | null, id: string) => significantFraction(dataset?.methods[id] as MethodBase | undefined)

/**
 * The same pipeline on source signals and on the EEG they produce. At G = 0 there is no coupling, so
 * every significant directed link is spurious; in sensor space volume conduction and the reference
 * create many of them. Truth is drawn only in source space.
 */
export function SensorSourceComparison({ result, catalog }: { result: FlowResult; catalog: ConceptCatalog | null }) {
  const [condition, setCondition] = useState<'control' | 'coupled'>('control')
  const [method, setMethod] = useState<CompareMethod>('gc_pairwise')
  const spaces = spacesOf(result)
  const datasets = spaces.map((space) => findDataset(result, space, condition)).filter((item): item is FlowDataset => !!item)
  const source = datasets.find((item) => item.space === 'source') ?? null
  const sensors = datasets.filter((item) => item.space !== 'source')
  const sourceFraction = fractionOf(source, method)
  const caveat = (id: string) => catalog?.entries.find((entry) => entry.id === id)
  const G = datasets[0]?.G
  // One colour scale for every panel so the sensor/source magnitude difference stays visible.
  const sharedRange = valueRange(datasets.flatMap((dataset) => (dataset.methods[method]?.status === 'ok' ? offDiagonal(dataset.methods[method]?.values) : [])), false)
  const sensorEval = (dataset: FlowDataset) => result.evaluation?.sensor.find((item) => item.dataset_id === dataset.dataset_id)

  return (
    <div className="flw-compare">
      <section className="flw-primer-lead" aria-label="센서 대 소스 요약">
        <span className="eyebrow">센서 vs 소스 · 허위 방향성</span>
        <h3>결합이 없는데도 센서에서는 방향이 보인다</h3>
        <p data-testid="compare-headline">
          {CONDITION_LABELS[condition]} (G={formatValue(G, 1)}) · {METHOD_LABELS[method]} Bonferroni 유의 쌍 비율 — 소스 {formatPercent(sourceFraction)}
          {sensors.map((dataset) => ` · ${SPACE_LABELS[spaceKey(dataset)] ?? dataset.dataset_id} ${formatPercent(fractionOf(dataset, method))}`).join('')}.
          {condition === 'control' && ' G=0에서는 소스 사이에 상호작용이 없으므로 유의한 쌍은 모두 허위입니다. 센서의 높은 비율은 볼륨 전도(같은 소스가 여러 전극에 섞임), 공통 기준전극, 센서 잡음 수준 차이가 만든 것입니다.'}
        </p>
      </section>

      <div className="flw-compare-controls">
        <div className="flw-segmented" role="group" aria-label="비교 조건">
          {(['control', 'coupled'] as const).map((item) => <button key={item} type="button" aria-pressed={condition === item} className={condition === item ? 'active' : ''} onClick={() => setCondition(item)}>{CONDITION_LABELS[item]}</button>)}
        </div>
        <div className="flw-segmented" role="group" aria-label="비교 지표">
          {(Object.keys(METHOD_LABELS) as CompareMethod[]).map((item) => <button key={item} type="button" aria-pressed={method === item} className={method === item ? 'active' : ''} onClick={() => setMethod(item)}>{METHOD_LABELS[item]}</button>)}
        </div>
      </div>

      <div className="flw-compare-grid">
        {datasets.map((dataset) => {
          const values = dataset.methods[method]
          return (
            <figure key={dataset.dataset_id} className="flw-compare-cell" aria-label={datasetLabel(dataset.dataset_id)}>
              <figcaption><strong>{SPACE_LABELS[spaceKey(dataset)] ?? dataset.dataset_id}</strong><small>{dataset.channel_names.length}채널 · reference {dataset.reference_label}</small></figcaption>
              {values?.status === 'ok' && values.values
                ? <DirectedMatrix values={values.values} labels={channelLabels(dataset)} range={sharedRange} pValues={values.p_values}
                  threshold={values.significance?.bonferroni_threshold ?? null} truth={truthCells(dataset, result.recipe.graph.edges)} units={values.units}
                  ariaLabel={`${METHOD_LABELS[method]} · ${datasetLabel(dataset.dataset_id)}`} />
                : <StatusNote status={values?.status ?? 'missing'} reasonCode={values?.reason_code} message={values?.message} />}
            </figure>
          )
        })}
        <p className="flw-muted flw-span">모든 패널은 같은 색 척도를 씁니다 (최댓값 {formatValue(sharedRange.hi, 3)}). 소스 공간은 정답 그래프(G&gt;0일 때만)를 테두리로 표시하고, 센서 패널에는 정답이 없습니다.</p>
        {!source && <p className="flw-note">이 실행에는 소스 공간 데이터가 없습니다 (include_source_native=false). 센서 결과만으로는 허위 여부를 판정할 정답이 없습니다.</p>}
      </div>

      <div className="flw-table-wrap">
        <table className="flw-small-table" aria-label="데이터셋별 유의 쌍 비율">
          <caption>데이터셋별 Bonferroni 유의 쌍 비율 (소스 G=0 행은 전부 거짓 양성)</caption>
          <thead>
            <tr><th scope="col">데이터셋</th><th scope="col">쌍별 GC</th><th scope="col">조건부 GC</th><th scope="col">Gaussian TE</th><th scope="col">시간 역전 net&gt;0</th><th scope="col">AF 평균 r (Pearson)</th></tr>
          </thead>
          <tbody>
            {result.datasets.map((dataset) => {
              const af = dataset.methods.activity_flow as ActivityFlowMethod | undefined
              const tr = sensorEval(dataset)?.gc_time_reversed
              return (
                <tr key={dataset.dataset_id} data-testid={`compare-row-${dataset.dataset_id}`}>
                  <th scope="row">{datasetLabel(dataset.dataset_id)}</th>
                  <td>{formatPercent(fractionOf(dataset, 'gc_pairwise'))}</td>
                  <td>{dataset.methods.gc_conditional?.status === 'ok' ? formatPercent(fractionOf(dataset, 'gc_conditional')) : dataset.methods.gc_conditional?.status ?? '—'}</td>
                  <td>{formatPercent(fractionOf(dataset, 'te_gaussian'))}</td>
                  <td>{tr ? formatPercent(tr.fraction_net_positive) : '—'}</td>
                  <td>{af?.status === 'ok' ? formatValue(af.summary?.predictions.pearson?.mean_r, 2) : af?.status ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {(result.evaluation?.lessons ?? []).length > 0 && (
        <section aria-label="이 실행의 교훈">
          <h4 className="flw-section-title">이 실행에서 확인된 것</h4>
          <ul className="flw-lessons">{result.evaluation!.lessons.map((lesson) => <li key={lesson}>{lesson}</li>)}</ul>
          <p className="flw-muted">{result.evaluation!.truth_scope}</p>
        </section>
      )}

      <div className="flw-caveats">
        {['volume_conduction', 'reference', 'common_input'].map((id) => caveat(id)).filter((entry) => !!entry).map((entry) => (
          <div key={entry!.id} className="flw-caveat open"><strong>{entry!.title}</strong><p>{entry!.intuition}</p></div>
        ))}
      </div>
    </div>
  )
}
