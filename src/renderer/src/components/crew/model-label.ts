/**
 * Formats a model id for display in the crew UI. Model ids are often
 * provider-qualified (`anthropic/claude-sonnet-4-5`); the tail is what reads.
 */
export function shortModel(id: string): string {
  if (!id) return 'auto'
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}
