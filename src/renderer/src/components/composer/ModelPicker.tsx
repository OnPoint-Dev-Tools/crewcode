import React, { useMemo, useState } from 'react'
import { Icon } from '../ui/Icon'
import { PickerSheet } from './PickerSheet'
import { PROVIDER_META, PROVIDER_IMAGES, providerImageClass } from './provider-meta'
import { useProviderModels, type DetectedModel } from '../../hooks/useProviderModels'

interface ModelPickerProps {
  open:      boolean
  anchor:    HTMLElement | null
  provider:  string
  value:     string
  onPick:    (modelId: string) => void
  onClose:   () => void
  placement?: 'auto' | 'down'
  // When the parent (ModelRow) has already resolved the list, pass it in to
  // avoid a duplicate fetch. Omitted callers (LaneModelButton) fetch their own.
  models?:   DetectedModel[]
}

export function ModelPicker({ open, anchor, provider, value, onPick, onClose, placement, models }: ModelPickerProps) {
  const [query, setQuery] = useState('')
  const fetched = useProviderModels(provider, models === undefined, open)
  const list = models ?? fetched.list
  const loading = models === undefined && fetched.loading
  const detectedCount = models === undefined && fetched.hasDetected ? fetched.list.length : 0

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = q
      ? list.filter(m => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q))
      : list
    if (q && !matched.some(m => m.id === query)) {
      matched.push({ id: query, label: `use "${query}"`, provider: 'custom' })
    }
    return matched.map(m => {
      const meta = PROVIDER_META[m.provider] ?? PROVIDER_META[provider]
      const imgSrc = PROVIDER_IMAGES[m.provider] ?? PROVIDER_IMAGES[provider]
      return {
        id:    m.id,
        label: m.label || '(default)',
        sub:   m.id ? (meta?.name ?? m.provider) : 'no --model flag',
        icon:  imgSrc
          ? <img src={imgSrc} alt={meta?.name ?? m.provider} width={20} height={20} className={providerImageClass(m.provider)} style={{ display: 'block' }} />
          : <Icon name={(meta?.icon ?? 'box') as any} size={13} />,
      }
    })
  }, [list, query])

  const headerText = loading
    ? 'MODELS · loading…'
    : detectedCount > 0
    ? `MODELS · from ${provider} (${detectedCount})`
    : 'MODELS'

  return (
    <PickerSheet
      open={open}
      className="model-picker-sheet"
      onClose={onClose}
      anchor={anchor}
      header={headerText}
      searchPlaceholder="Search models…"
      query={query}
      onQuery={setQuery}
      items={items}
      activeId={value}
      onPick={onPick}
      placement={placement}
      defaultIcon={
        PROVIDER_IMAGES[provider]
          ? <img src={PROVIDER_IMAGES[provider]} alt={PROVIDER_META[provider]?.name ?? provider} width={20} height={20} className={providerImageClass(provider)} style={{ display: 'block' }} />
          : <Icon name={(PROVIDER_META[provider]?.icon ?? 'brain') as any} size={13} />
      }
      width={320}
    />
  )
}
