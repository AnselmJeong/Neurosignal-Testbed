import { CircleHelp } from 'lucide-react'

export function ControlHint({ children }: { children: string }) {
  return (
    <span className="control-hint" tabIndex={0} aria-label={children}>
      <CircleHelp size={13} aria-hidden="true" />
      <span role="tooltip">{children}</span>
    </span>
  )
}
