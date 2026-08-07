import darkLogo from '../../assets/icon-logo-dark.png'
import lightLogo from '../../assets/icon-logo-light.png'
import { useIsDark } from '../../hooks/useIsDark'

interface LoadingScreenProps {
  exiting?: boolean
}

export function LoadingScreen({ exiting = false }: LoadingScreenProps) {
  const isDark = useIsDark()

  return (
    <div className={`loading-screen ${exiting ? 'is-exiting' : ''}`} role="status" aria-live="polite" aria-label="Loading CrewCode">
      <div className="loading-screen-orbit" aria-hidden="true" />
      <div className="loading-screen-mark">
        <img src={isDark ? darkLogo : lightLogo} alt="CrewCode" className="loading-screen-logo" />
        <div className="loading-screen-line" aria-hidden="true">
          <span />
        </div>
      </div>
      <div className="loading-screen-caption">loading workspace</div>
    </div>
  )
}
