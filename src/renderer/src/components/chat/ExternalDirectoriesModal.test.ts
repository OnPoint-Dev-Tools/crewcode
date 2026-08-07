import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ExternalDirectoriesModal } from './ExternalDirectoriesModal'

describe('ExternalDirectoriesModal', () => {
  it('allows local CrewCoder sessions to browse for external directories', () => {
    const html = renderToStaticMarkup(React.createElement(ExternalDirectoriesModal, {
      open: true,
      directories: [],
      providerId: 'crewcoder',
      remote: false,
      onClose: () => {},
      onAdd: () => {},
      onRemove: () => {},
    }))

    expect(html).toContain('browse…')
    expect(html).not.toContain('does not support additional directory roots')
    expect(html).not.toContain('disabled=""')
  })

  it('still rejects local picker paths for SSH sessions', () => {
    const html = renderToStaticMarkup(React.createElement(ExternalDirectoriesModal, {
      open: true,
      directories: [],
      providerId: 'crewcoder',
      remote: true,
      onClose: () => {},
      onAdd: () => {},
      onRemove: () => {},
    }))

    expect(html).toContain('Local directories cannot be attached to a remote/SSH session.')
    expect(html).toContain('disabled=""')
  })
})
