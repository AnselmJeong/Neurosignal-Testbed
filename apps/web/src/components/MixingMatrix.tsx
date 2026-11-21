interface MixingMatrixProps {
  values: number[][]
  selectedRow: number
  onSelectRow: (rowIndex: number) => void
}
export function MixingMatrix({ values, selectedRow, onSelectRow }: MixingMatrixProps) {
  const max = Math.max(...values.flat().map(Math.abs), 0.01)
  return (
    <div className="matrix" role="group" aria-label="센서 × 원천 혼합 행렬(부호 포함)">
      <div className="matrix-corner" />
      {['2 Hz', '10 Hz', '60 Hz'].map((label) => <span className="matrix-head" key={label}>{label}</span>)}
      {values.map((row, rowIndex) => (
        <div
          className={`matrix-row ${rowIndex === selectedRow ? 'selected' : ''}`}
          key={`row-${rowIndex}`}
          role="button"
          tabIndex={0}
          aria-pressed={rowIndex === selectedRow}
          aria-label={`EEG ${String(rowIndex + 1).padStart(2, '0')} 센서 신호 보기`}
          onClick={() => onSelectRow(rowIndex)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onSelectRow(rowIndex)
            }
          }}
        >
          <span className="matrix-label">EEG {String(rowIndex + 1).padStart(2, '0')}</span>
          {row.map((value, columnIndex) => {
            const alpha = 0.12 + (Math.abs(value) / max) * 0.72
            const background = value >= 0 ? `rgba(8,127,131,${alpha})` : `rgba(199,101,60,${alpha})`
            return <span key={`${rowIndex}-${columnIndex}`} className="matrix-cell" style={{ background }}>{value.toFixed(2)}</span>
          })}
        </div>
      ))}
    </div>
  )
}
