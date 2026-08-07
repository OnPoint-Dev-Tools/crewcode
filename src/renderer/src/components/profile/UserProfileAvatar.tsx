import { Icon, type IconName } from '../ui/Icon'
import type { ProfileIconKind } from '../../hooks/useSettings'

export const PROFILE_ICON_PRESETS = [
  'bot',
  'sparkle',
  'brain',
  'terminal',
  'code',
  'crew',
  'github',
  'globe',
  'moon',
  'sun',
  'bolt',
  'target',
] as const satisfies readonly IconName[]

export type ProfileIconPreset = (typeof PROFILE_ICON_PRESETS)[number]

export function normalizeUserDisplayName(username: string): string {
  return username.trim() || 'user'
}

function initialFor(username: string): string {
  const first = normalizeUserDisplayName(username).replace(/[^a-z0-9]/gi, '').charAt(0)
  return (first || 'u').toLowerCase()
}

function isPresetIcon(value: string): value is ProfileIconPreset {
  return PROFILE_ICON_PRESETS.includes(value as ProfileIconPreset)
}

interface UserProfileAvatarProps {
  username: string
  iconKind: ProfileIconKind
  iconValue: string
  size?: number
  className?: string
  title?: string
}

export function UserProfileAvatar({
  username,
  iconKind,
  iconValue,
  size = 26,
  className = '',
  title,
}: UserProfileAvatarProps) {
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.42)) }
  const classes = ['profile-avatar', className].filter(Boolean).join(' ')
  const label = title ?? normalizeUserDisplayName(username)

  if (iconKind === 'image' && iconValue) {
    return (
      <span className={classes} style={style} title={label} aria-label={label}>
        <img src={iconValue} alt="" draggable={false} />
      </span>
    )
  }

  if (iconKind === 'icon' && isPresetIcon(iconValue)) {
    return (
      <span className={classes} style={style} title={label} aria-label={label}>
        <Icon name={iconValue} size={Math.round(size * 0.58)} stroke={1.85} />
      </span>
    )
  }

  return (
    <span className={classes} style={style} title={label} aria-label={label}>
      {initialFor(username)}
    </span>
  )
}
