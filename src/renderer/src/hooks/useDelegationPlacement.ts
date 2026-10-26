import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentUserRequest, AgentUserResponse, Session } from '../types'

export type DelegationPlacement = { isolation: 'worktree' | 'shared'; path: string; base: string }

/** Hold the first send in CrewCode before a provider receives the prompt. */
export function useDelegationPlacement(
  session: Session | undefined, path: string, branch: string, repo: boolean,
  save: (placement: DelegationPlacement) => void,
) {
  const [request, setRequest] = useState<AgentUserRequest | null>(null)
  const pending = useRef<{ resolve: (accepted: boolean) => void; choice?: DelegationPlacement } | null>(null)
  const cancel = useCallback(() => {
    pending.current?.resolve(false)
    pending.current = null
    setRequest(null)
  }, [])
  // A suspended send must never resume into another session or checkout.
  useEffect(() => cancel, [session?.id, session?.delegationEnabled, path, branch, cancel])
  useEffect(() => {
    const choice = pending.current?.choice
    const saved = session?.delegationPlacement
    if (choice && saved?.isolation === choice.isolation && saved.path === choice.path && saved.base === choice.base) {
      pending.current?.resolve(true)
      pending.current = null
      setRequest(null)
    }
  }, [session?.delegationPlacement])
  const ensure = useCallback((): Promise<boolean> => {
    if (!session?.delegationEnabled || session.origin === 'delegated' || (session.delegationPlacement?.path === path && session.delegationPlacement.base === branch)) return Promise.resolve(true)
    if (pending.current) return Promise.resolve(false)
    return new Promise(resolve => {
      pending.current = { resolve }
      setRequest({
        requestId: 'delegation-placement:' + session.id, bridgeId: '', kind: 'select', source: 'CrewCode',
        title: 'CrewCode: where should delegated agents work?',
        message: 'Choose once for this session. Current checkout: ' + branch + ' - ' + path + '. Shared agents can edit the same files.',
        options: [
          ...(repo && branch && branch !== '\u2014' ? [{ id: 'worktree', label: 'Isolated worktree from ' + branch, description: 'Create a fresh branch from the committed base; keep this checkout unchanged.' }] : []),
          { id: 'shared', label: 'Current checkout (' + branch + ')', description: path },
          { id: 'cancel', label: 'Cancel send' },
        ],
      })
    })
  }, [session, path, branch, repo])
  const respond = useCallback((response: AgentUserResponse) => {
    if (response.requestId !== request?.requestId || !pending.current || pending.current.choice) return
    if (response.action !== 'submit' || !['shared', 'worktree'].includes(response.optionId ?? '')) { cancel(); return }
    if (response.optionId === 'worktree' && (!repo || !branch || branch === '\u2014')) { cancel(); return }
    const choice: DelegationPlacement = { isolation: response.optionId as 'shared' | 'worktree', path, base: branch }
    pending.current.choice = choice
    save(choice)
  }, [request, path, branch, repo, save, cancel])
  return { request, ensure, respond, cancel }
}
