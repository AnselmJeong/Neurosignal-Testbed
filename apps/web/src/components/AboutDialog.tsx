import { Activity, Info, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import packageMetadata from '../../package.json'

export const APP_VERSION = packageMetadata.version

type AboutDialogProps = {
  onClose: () => void
}

export function AboutDialog({ onClose }: AboutDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeButtonRef.current?.focus()

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    <div className="about-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <button ref={closeButtonRef} className="icon-button about-close" onClick={onClose} aria-label="정보 창 닫기">
          <X size={17} />
        </button>
        <div className="about-mark" aria-hidden="true"><Activity size={28} /></div>
        <span className="eyebrow">NeuroSignal Testbed</span>
        <h2 id="about-title">신호를 탐구하고,<br />{' '}모든 결과를 의심하라.</h2>
        <p>EEG 시뮬레이션, 전처리, QEEG, 연결성, 원천 모델링을 투명하게 실험하는 교육·연구용 작업대입니다. 낯선 개념을 직접 바꿔 보고, 예측하고, 정답과 대조하며 익히도록 만들었습니다.</p>
        <dl>
          <div><dt>버전</dt><dd>{APP_VERSION}</dd></div>
          <div><dt>개발</dt><dd>Anselm Jeong</dd></div>
        </dl>
        <small>교육·연구용 · 임상 진단에 쓰지 마세요</small>
      </section>
    </div>
  )
}

export function AboutExperience() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button className="quiet-button about-button" onClick={() => setOpen(true)} aria-label="NeuroSignal 정보">
        <Info size={16} /> 정보(About)
      </button>
      {open && <AboutDialog onClose={() => setOpen(false)} />}
    </>
  )
}
