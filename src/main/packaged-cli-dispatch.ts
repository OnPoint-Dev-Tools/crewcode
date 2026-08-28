export const PACKAGED_HEADLESS_COMMANDS = new Set(['hub', 'serve', 'brain', 'enroll'])

/** User arguments accepted by the packaged Electron executable as headless CLI. */
export function packagedHeadlessArgs(argv: string[]): string[] | null {
  const args = argv.slice(1)
  return args[0] && PACKAGED_HEADLESS_COMMANDS.has(args[0]) ? args : null
}
