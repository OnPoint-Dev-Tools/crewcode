import React from 'react'

interface StatusPillProps {
  children: React.ReactNode
  variant?: 'default' | 'brand'
  dot?: boolean
  liveDot?: boolean
  className?: string
}

export function StatusPill({ children, variant = 'default', dot, liveDot, className = '' }: StatusPillProps) {
  return (
    <span className={`spill ${variant === 'brand' ? 'brand' : ''} ${className}`}>
      {(dot || liveDot) && <span className={`dot ${liveDot ? 'live' : ''}`} />}
      {children}
    </span>
  )
}
