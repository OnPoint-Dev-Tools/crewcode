// Which chats may delegate at all.
//
// Delegation is depth-1: a delegated thread must never spawn threads of its own.
// That used to be true only by omission — children were simply never handed
// credentials — which meant the rule held right up until someone turned the
// toggle on inside a delegated thread, and then nothing refused. The parent's
// preamble promises "threads you create cannot create threads of their own", so
// this makes that promise enforceable rather than incidental.
//
// Pure and shared so the UI, credential minting, and the API all answer the same
// question the same way. A depth limit checked in only one of those is a depth
// limit that persisted state can walk around.

import type { Session } from '../types'

export function canSessionDelegate(session: Session | null | undefined): boolean {
  if (!session) return false
  // `origin` is set only by the delegation API and is never cleared — continuing
  // a delegated thread yourself does not promote it to a root chat.
  return session.origin !== 'delegated'
}

/** Why a session was refused, for an error the agent can act on. */
export const DELEGATION_DEPTH_REFUSAL =
  'this chat was itself created by another agent, and delegated threads cannot delegate further'
