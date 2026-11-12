import type { BenchmarkCapabilities, MetricCapability } from './types'

const FAMILY_LABELS: Record<string, string> = {
  spectral: '스펙트럼',
  correlation: '상관',
  phase: '위상',
  amplitude: '진폭',
  information: '정보량',
  complexity: '복잡도',
  directed: '방향성',
  cross_frequency: '교차주파수',
  graph: '그래프',
}

function statusLabel(metric: MetricCapability): { label: string; tone: string } {
  if (metric.status !== 'implemented') return { label: '계획됨', tone: 'planned' }
  if (!metric.dependency_available) return { label: '구현됨 · 의존성 없음', tone: 'blocked' }
  return { label: '구현됨', tone: 'implemented' }
}

/** All in-scope metric IDs with their real development status and input requirements (plan §8.1). */
export function MetricCatalog({ capabilities, inRun = [] }: { capabilities: BenchmarkCapabilities; inRun?: string[] }) {
  const rows = capabilities.metric_ids.map((id) => capabilities.metrics[id]).filter((metric): metric is MetricCapability => !!metric)
  const missing = capabilities.metric_ids.filter((id) => !capabilities.metrics[id])
  const implemented = rows.filter((metric) => metric.status === 'implemented').length
  const groups = Object.entries(capabilities.dependency_groups)

  return (
    <section className="jrb-catalog" aria-labelledby="jrb-catalog-title">
      <header className="jrb-section-head">
        <div>
          <span className="eyebrow">지표 카탈로그</span>
          <h3 id="jrb-catalog-title">계획한 {capabilities.metric_ids.length}개 지표 ID</h3>
        </div>
        <p className="jrb-catalog-count" role="status">
          구현 {implemented} · 계획 {rows.length - implemented}
          {missing.length > 0 && ` · 정보 없음 ${missing.length}`}
        </p>
      </header>
      <p className="jrb-note">
        이 화면은 첫 구현 단위(P0–P4)입니다. Q1의 PLV·wPLI·wSMI 비교만 실행 흐름에 연결되어 있으며, 아래 목록이 전부 완료되었다는 뜻이 아닙니다.
        ‘구현됨’은 계산 adapter가 등록되었다는 뜻이고, 지표별 oracle 검증 완료를 뜻하지 않습니다.
      </p>
      <ul className="jrb-dependency-groups" aria-label="선택 의존성 그룹">
        {groups.map(([group, available]) => (
          <li key={group} className={available ? 'ok' : 'missing'}>{group} · {available ? '설치됨' : '미설치'}</li>
        ))}
      </ul>
      <div className="jrb-table-wrap">
        <table className="jrb-catalog-table">
          <thead>
            <tr><th scope="col">ID</th><th scope="col">지표</th><th scope="col">계열</th><th scope="col">상태</th><th scope="col">입력 요구사항</th><th scope="col">값의 범위</th><th scope="col">의존성</th></tr>
          </thead>
          <tbody>
            {rows.map((metric) => {
              const status = statusLabel(metric)
              return (
                <tr key={metric.id} data-testid={`catalog-row-${metric.id}`}>
                  <th scope="row">{metric.id}</th>
                  <td>{metric.name}{inRun.includes(metric.id) && <small className="jrb-in-run">이번 실행</small>}</td>
                  <td>{FAMILY_LABELS[metric.family] ?? metric.family}</td>
                  <td><span className={`jrb-status ${status.tone}`}>{status.label}</span></td>
                  <td className="jrb-input-req">{metric.input_requirements}</td>
                  <td>{metric.value_domain}{metric.signed ? ' · 부호 있음' : ''}</td>
                  <td>{metric.dependency_group}{metric.missing_modules.length > 0 && <small> · 없음: {metric.missing_modules.join(', ')}</small>}</td>
                </tr>
              )
            })}
            {missing.map((id) => (
              <tr key={id} data-testid={`catalog-row-${id}`}>
                <th scope="row">{id}</th>
                <td colSpan={6}><span className="jrb-status blocked">서버가 이 ID의 정보를 보내지 않음</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
