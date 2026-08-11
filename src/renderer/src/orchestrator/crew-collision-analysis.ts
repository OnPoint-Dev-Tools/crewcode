export interface CollisionLaneChanges {
  laneId: string
  label: string
  files: string[]
}

export interface CrewCollisionFinding {
  kind: 'file-overlap' | 'behavioral-risk'
  severity: 'high' | 'medium'
  laneIds: [string, string]
  laneLabels: [string, string]
  files: string[]
  reason: string
}

type ContractGroup = {
  reason: string
  producer: RegExp
  consumer: RegExp
}

// These are deliberately narrow, explainable heuristics rather than an AI claim
// that a merge is correct. They catch common cross-file contract changes while
// keeping false-positive noise low enough that users do not learn to ignore it.
const CONTRACT_GROUPS: ContractGroup[] = [
  {
    reason: 'database contract changed in one lane while model/API consumers changed in another',
    producer: /(^|\/)(migrations?|schema|schemas|db|database)(\/|\.|$)|\.(sql|prisma)$/i,
    consumer: /(^|\/)(models?|entities|api|routes?|controllers?|graphql|resolvers?)(\/|\.|$)/i,
  },
  {
    reason: 'API/schema contract changed in one lane while a client or generated consumer changed in another',
    producer: /(^|\/)(openapi|swagger|proto|graphql|schemas?)(\/|\.|$)|\.(proto|graphql|gql)$/i,
    consumer: /(^|\/)(clients?|sdk|generated|api)(\/|\.|$)/i,
  },
  {
    reason: 'dependency/build contract changed in one lane while runtime source changed in another',
    producer: /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.toml|cargo\.lock|go\.mod|go\.sum|pyproject\.toml|poetry\.lock|requirements[^/]*\.txt)$/i,
    consumer: /(^|\/)(src|app|lib|server|client)(\/|$)/i,
  },
  {
    reason: 'configuration contract changed in one lane while consuming application code changed in another',
    producer: /(^|\/)(config|configs|settings|env)(\/|\.|$)|(^|\/)\.env(\.|$)/i,
    consumer: /(^|\/)(src|app|lib|server|client|api)(\/|$)/i,
  },
]

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`
}

/**
 * Find review signals Git cannot: exact files touched by multiple lanes and a
 * small set of cross-file contract risks. This is advisory; absence of a finding
 * never means a merge is behaviorally safe.
 */
export function analyzeCrewCollisions(lanes: CollisionLaneChanges[]): CrewCollisionFinding[] {
  const findings: CrewCollisionFinding[] = []
  const seen = new Set<string>()

  for (let i = 0; i < lanes.length; i += 1) {
    for (let j = i + 1; j < lanes.length; j += 1) {
      const a = lanes[i]
      const b = lanes[j]
      const aFiles = [...new Set(a.files)]
      const bFiles = [...new Set(b.files)]
      const overlap = aFiles.filter(path => bFiles.includes(path)).sort()
      if (overlap.length > 0) {
        findings.push({
          kind: 'file-overlap', severity: 'high',
          laneIds: [a.laneId, b.laneId], laneLabels: [a.label, b.label],
          files: overlap,
          reason: 'both lanes change the same file; review combined intent even if Git merges it cleanly',
        })
      }

      for (const group of CONTRACT_GROUPS) {
        const aProducer = aFiles.filter(path => group.producer.test(path))
        const bProducer = bFiles.filter(path => group.producer.test(path))
        const aConsumer = aFiles.filter(path => group.consumer.test(path))
        const bConsumer = bFiles.filter(path => group.consumer.test(path))
        const files = aProducer.length && bConsumer.length
          ? [...aProducer, ...bConsumer]
          : bProducer.length && aConsumer.length
            ? [...bProducer, ...aConsumer]
            : []
        if (files.length === 0) continue
        const key = `${pairKey(a.laneId, b.laneId)}\0${group.reason}`
        if (seen.has(key)) continue
        seen.add(key)
        findings.push({
          kind: 'behavioral-risk', severity: 'medium',
          laneIds: [a.laneId, b.laneId], laneLabels: [a.label, b.label],
          files: [...new Set(files)].sort(),
          reason: group.reason,
        })
      }
    }
  }

  return findings
}
