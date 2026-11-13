import { BookOpen } from 'lucide-react'

import { Formula } from './Visuals'
import type { ConceptCatalog, ConceptEntry } from './types'

const APPLICABILITY_LABELS: Record<string, string> = {
  applicable: '이 실습에서 계산',
  conditional: '조건부 · 일부만',
  not_applicable: '해당 없음',
}

export function ApplicabilityBadge({ entry }: { entry: ConceptEntry }) {
  const status = entry.applicability.status
  return <span className={`flw-applicability ${status}`} title={entry.applicability.reason}>{APPLICABILITY_LABELS[status] ?? status}</span>
}

const CONCEPT_ORDER = ['structural_connectivity', 'functional_connectivity', 'directed_effective_connectivity', 'information_flow']
const LEVEL_ORDER = ['level1_direction', 'level2_content', 'level3_computation']

/** SC / FC / directed-effective / information flow, then the Level 1-2-3 framework, from GET /flow/concepts. */
export function ConceptPrimer({ catalog, error }: { catalog: ConceptCatalog | null; error: string | null }) {
  if (!catalog) {
    return error
      ? <p className="flw-banner error" role="alert">개념 설명을 불러오지 못했습니다: {error}</p>
      : <p className="flw-note">개념 설명을 불러오는 중입니다.</p>
  }
  const byId = new Map(catalog.entries.map((entry) => [entry.id, entry]))
  const concepts = CONCEPT_ORDER.map((id) => byId.get(id)).filter((entry): entry is ConceptEntry => !!entry)
  const levels = LEVEL_ORDER.map((id) => byId.get(id)).filter((entry): entry is ConceptEntry => !!entry)
  const caveats = catalog.entries.filter((entry) => entry.kind === 'caveat')
  const methods = catalog.entries.filter((entry) => entry.kind === 'method')

  return (
    <div className="flw-primer">
      <section className="flw-primer-lead" aria-label="개념 요약">
        <span className="eyebrow"><BookOpen size={13} /> 개념 입문</span>
        <h3>연결되어 있다 ≠ 정보가 흐른다</h3>
        <p>{catalog.summary}</p>
      </section>

      <section aria-label="연결성 개념 비교">
        <h4 className="flw-section-title">네 가지 개념은 서로 다른 질문에 답합니다</h4>
        <div className="flw-table-wrap">
          <table className="flw-concept-table">
            <thead>
              <tr><th scope="col">개념</th><th scope="col">묻는 질문</th><th scope="col">직관</th><th scope="col">이 실습에서는</th></tr>
            </thead>
            <tbody>
              {concepts.map((entry) => (
                <tr key={entry.id} data-testid={`concept-row-${entry.id}`}>
                  <th scope="row"><strong>{entry.short_name}</strong><small>{entry.title}</small><ApplicabilityBadge entry={entry} /></th>
                  <td>{entry.question_answered}{entry.formula && <Formula latex={entry.formula} label={`${entry.short_name} 수식`} />}</td>
                  <td>{entry.intuition}</td>
                  <td>{entry.what_this_simulation_can_show}<small className="flw-reason">{entry.applicability.reason}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="정보 흐름의 세 수준">
        <h4 className="flw-section-title">정보 흐름은 세 수준으로 따로 물어야 합니다</h4>
        <ol className="flw-levels">
          {levels.map((entry, index) => {
            const mapped = methods.filter((method) => method.level === entry.level).map((method) => method.short_name)
            return (
              <li key={entry.id} className={entry.applicability.status} data-testid={`level-${entry.level ?? index + 1}`}>
                <div className="flw-level-head"><b>{entry.short_name}</b><ApplicabilityBadge entry={entry} /></div>
                <strong>{entry.title}</strong>
                <p className="flw-framework">{catalog.framework[index] ?? ''}</p>
                <p>{entry.question_answered}</p>
                {mapped.length > 0 && <p className="flw-level-methods">이 실습의 방법: {mapped.join(' · ')}</p>}
                <p className="flw-reason">{entry.applicability.reason}</p>
              </li>
            )
          })}
        </ol>
      </section>

      {caveats.length > 0 && (
        <section aria-label="해석 주의점">
          <h4 className="flw-section-title">결과를 읽기 전 주의할 점</h4>
          <div className="flw-caveats">
            {caveats.map((entry) => (
              <details key={entry.id} className="flw-caveat">
                <summary><strong>{entry.title}</strong></summary>
                <p>{entry.question_answered}</p>
                <p>{entry.intuition}</p>
                {entry.formula && <Formula latex={entry.formula} label={`${entry.short_name} 수식`} />}
                <ul>{entry.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
              </details>
            ))}
          </div>
        </section>
      )}
      <p className="flw-source-doc">출처 문서: <code>{catalog.source_document}</code> · catalog v{catalog.version}</p>
    </div>
  )
}
