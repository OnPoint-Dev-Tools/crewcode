/**
 * crew-rounds — merges the per-lane chat threads of a shared-mode crew into one
 * round-by-round timeline.
 *
 * Each lane runs its own agent and keeps its own thread, but a shared session
 * broadcasts one prompt to every lane at once. That lockstep is what lets us
 * realign the threads here: round k is the k-th broadcast prompt followed by
 * every lane's answer to it. Pure — no React, no IPC.
 */

import type { Message } from '../../types'
import type { CrewAgentLane } from '../../orchestrator/crew-session'

/** A lane paired with its flat chat thread — the input to the merge. */
export interface CrewLaneThread {
  lane:     CrewAgentLane
  messages: Message[]
}

/** One lane's prompt + answer within a single round. */
export interface CrewLaneGroup {
  lane:     CrewAgentLane
  prompt:   string
  time:     string
  messages: Message[]
}

/** One broadcast prompt and every lane's response to it. */
export interface CrewRound {
  prompt: string
  time:   string
  groups: CrewLaneGroup[]
}

/**
 * Splits a lane's thread into prompts and the response segment following each.
 * `segments[k]` holds the messages produced after `prompts[k]`; anything before
 * the first prompt belongs to no round and is dropped.
 */
function splitByPrompt(
  messages: Message[],
): { prompts: { text: string; time: string }[]; segments: Message[][] } {
  const prompts: { text: string; time: string }[] = []
  const segments: Message[][] = []
  let cur: Message[] = []
  let started = false

  for (const msg of messages) {
    if (msg.kind === 'user') {
      if (started) segments.push(cur)
      prompts.push({ text: msg.text, time: msg.time })
      cur = []
      started = true
    } else if (started) {
      cur.push(msg)
    }
  }
  if (started) segments.push(cur)

  return { prompts, segments }
}

/**
 * Merges every lane's thread into a shared timeline. A lane that errored or
 * lags behind simply contributes an empty group for the rounds it missed.
 */
export function buildCrewRounds(threads: CrewLaneThread[]): CrewRound[] {
  const perLane = threads.map(t => ({ lane: t.lane, ...splitByPrompt(t.messages) }))
  const roundCount = perLane.reduce((max, p) => Math.max(max, p.prompts.length), 0)

  const rounds: CrewRound[] = []
  for (let k = 0; k < roundCount; k++) {
    const withPrompt = perLane.find(p => p.prompts[k])
    rounds.push({
      prompt: withPrompt?.prompts[k]?.text ?? '',
      time:   withPrompt?.prompts[k]?.time ?? '',
      groups: perLane.map(p => ({
        lane: p.lane,
        prompt: p.prompts[k]?.text ?? '',
        time: p.prompts[k]?.time ?? '',
        messages: p.segments[k] ?? [],
      })),
    })
  }
  return rounds
}
