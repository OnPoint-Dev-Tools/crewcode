// Canonical execution-mode union. Previously declared independently in the
// renderer's types and in main's bridge-types; both now re-export this so a
// shared module (delegation, etc.) can reference one type instead of a third
// copy drifting out of sync. No Electron imports.
//
// `full` is the wire value (renamed from `yolo`); persisted sessions can still
// hold `yolo`, so every read of a persisted mode goes through
// `normalizeModeLevel()`.
export type ModeLevel = 'ask' | 'plan' | 'build' | 'full'
