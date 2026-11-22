import { Check, Code2, Copy, Download } from 'lucide-react'
import { useState } from 'react'

/** P2-3: the lab's current recipe as an MNE-Python script the learner can run on their own data. */
export function CodeExport({ code, filename, lab }: { code: string; filename: string; lab: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/x-python' }))
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <details className="code-export">
      <summary><Code2 size={15} /> MNE 코드로 보기(Export to MNE)<small>{lab} · 현재 설정</small></summary>
      <div className="code-export-body">
        <p>이 Lab이 한 계산을 내 기록에 그대로 해 보는 Python 코드입니다. 설정을 바꾸면 코드의 값도 바뀝니다. 첫 줄의 파일 경로만 내 기록으로 바꾸면 됩니다.</p>
        <pre aria-label={`${lab} MNE 코드`}><code>{code}</code></pre>
        <div className="code-export-actions">
          <button type="button" className="quiet-button" onClick={copy}>{copied ? <><Check size={13} /> 복사함</> : <><Copy size={13} /> 복사</>}</button>
          <button type="button" className="quiet-button" onClick={download}><Download size={13} /> .py 파일 받기</button>
        </div>
      </div>
    </details>
  )
}
