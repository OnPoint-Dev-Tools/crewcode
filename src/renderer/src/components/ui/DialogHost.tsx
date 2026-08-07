import React from 'react'
import { InputModal } from './InputModal'
import { ConfirmModal } from './ConfirmModal'
import { useDialogStore } from '../../stores/dialog-service'

// Single mount point for the promise-based dialog service. Reuses the themed
// InputModal / ConfirmModal so imperative callers get the same look as the
// state-driven ones. Resolving twice is harmless — a Promise settles once — so
// the confirm-then-close call order inside the modals needs no extra guard.
export function DialogHost() {
  const current = useDialogStore(s => s.current)
  const set     = useDialogStore(s => s.set)

  if (!current) return null

  const settle = (value: boolean | string | null) => {
    current.resolve(value as never)
    set(null)
  }

  if (current.kind === 'confirm') {
    return (
      <ConfirmModal
        request={{ ...current.opts, onConfirm: () => settle(true) }}
        onClose={() => settle(false)}
      />
    )
  }

  return (
    <InputModal
      request={{ ...current.opts, onConfirm: (value) => settle(value) }}
      onClose={() => settle(null)}
    />
  )
}
