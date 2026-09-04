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
        <button ref={closeButtonRef} className="icon-button about-close" onClick={onClose} aria-label="Close About dialog">
          <X size={17} />
        </button>
        <div className="about-mark" aria-hidden="true"><Activity size={28} /></div>
        <span className="eyebrow">NeuroSignal Testbed</span>
        <h2 id="about-title">Explore signals.<br />{' '}Question every result.</h2>
        <p>An educational and research workbench for transparent EEG simulation, preprocessing, QEEG, connectivity, and source-modeling experiments.</p>
        <dl>
          <div><dt>Version</dt><dd>{APP_VERSION}</dd></div>
          <div><dt>Developer</dt><dd>Developed by Anselm Jeong</dd></div>
        </dl>
        <small>Educational and research use only · Not for clinical diagnosis</small>
      </section>
    </div>
  )
}

export function AboutExperience() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button className="quiet-button about-button" onClick={() => setOpen(true)} aria-label="About NeuroSignal">
        <Info size={16} /> About
      </button>
      {open && <AboutDialog onClose={() => setOpen(false)} />}
    </>
  )
}
