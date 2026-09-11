// Shared between local and SSH filesystem surfaces. The editor tree is lazy, so
// dependency/build directories remain browsable on demand. Broad fallback scans
// still prune them to avoid walking enormous generated trees.

export const TREE_HIDDEN_ENTRIES = new Set([
  '.git', '.DS_Store',
])

export const SCAN_IGNORED_ENTRIES = new Set([
  '.git', 'node_modules', '.next', 'out', 'dist', '.DS_Store', '.cache', '.turbo',
])

export const MAX_FILE_BYTES = 2 * 1024 * 1024

// Composer imports travel over Electron IPC before being persisted in the
// workspace. Keep this separate from the editor/preview read ceiling: coding
// artifacts such as traces and source maps routinely exceed 2 MB, while an
// upper bound still prevents an accidental huge-file allocation in the renderer.
export const MAX_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENT_FILE_MB = MAX_ATTACHMENT_FILE_BYTES / (1024 * 1024)
