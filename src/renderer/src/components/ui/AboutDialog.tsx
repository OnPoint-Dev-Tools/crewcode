import { useEffect } from 'react'
import darkLogo from '../../assets/icon-logo-dark.png'
import lightLogo from '../../assets/icon-logo-light.png'
import { useAppBuildInfo } from '../../hooks/useAppBuildInfo'
import { useIsDark } from '../../hooks/useIsDark'
import { Icon } from './Icon'

interface AboutDialogProps {
  open: boolean
  onClose: () => void
}

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const build = useAppBuildInfo()
  const isDark = useIsDark()

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="im-backdrop" onClick={onClose}>
      <section className="im-modal about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-dialog-title" onClick={event => event.stopPropagation()}>
        <button className="im-close about-dialog-close" type="button" aria-label="Close About CrewCode" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
        <img className="about-dialog-logo" src={isDark ? darkLogo : lightLogo} alt="" />
        <div className="about-dialog-copy">
          <h2 id="about-dialog-title">CrewCode</h2>
          <p>Agent Coding Environment</p>
        </div>
        <div className="about-dialog-build" aria-label="CrewCode build information">
          <span>Version {build?.version ?? '—'}</span>
          <span>Build {build?.buildHash ?? '—'}</span>
        </div>
      </section>
    </div>
  )
}
