// Shared between the local (fs.ts) and remote (remote/remote-fs.ts) file
// surfaces so both hide the same noise and enforce the same read ceiling.

export const IGNORE = new Set([
  '.git', 'node_modules', '.next', 'out', 'dist', '.DS_Store', '.cache', '.turbo',
])

export const MAX_FILE_BYTES = 2 * 1024 * 1024

// Composer imports travel over Electron IPC before being persisted in the
// workspace. Keep this separate from the editor/preview read ceiling: coding
// artifacts such as traces and source maps routinely exceed 2 MB, while an
// upper bound still prevents an accidental huge-file allocation in the renderer.
export const MAX_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENT_FILE_MB = MAX_ATTACHMENT_FILE_BYTES / (1024 * 1024)
