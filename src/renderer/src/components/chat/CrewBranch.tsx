import { CrewConfigPanel } from '../crew/CrewConfigPanel'
import { CrewSurface } from '../crew/CrewSurface'
import type { AgentInfo, Message, AgentUserRequest, AgentUserResponse } from '../../types'
import type { CrewSession, CrewLaneEffort, CrewRoleAssignment } from '../../orchestrator/crew-session'
import type { CrewTemplate } from '../../orchestrator/crew-templates'
import type { CrewRole, CrewRoleInput } from '../../orchestrator/crew-roles'

export interface CrewBranchProps {
  activeTabId: string
  session: CrewSession
  agents: AgentInfo[]
  editing: boolean
  messagesByTab: Record<string, Message[]>
  ptyPanes: any[]
  templates: CrewTemplate[]
  crew: any
  sendToLane: (laneId: string, text: string) => void
  onBroadcast: (text: string) => void
  closePtyPane: (paneId: string) => void
  onEnterEditing: () => void
  onExitEditing: () => void
  setCrewDiffTab: (tabId: string) => void
  setCrewGitTab: (tabId: string) => void
  setRebuildConfirmOpen: (open: boolean) => void
  onApplyTemplate: (tpl: CrewTemplate) => void
  onDeleteTemplate: (id: string) => void
  onSaveTemplate: () => void
  onSetLaneRole: (laneId: string, role: CrewRoleAssignment) => void
  roles: CrewRole[]
  onSaveRole: (input: CrewRoleInput) => CrewRole
  onUpdateRole: (id: string, input: CrewRoleInput) => void
  onDeleteRole: (id: string) => void
  onSetLaneModel: (laneId: string, modelId: string) => void
  onSetLaneEffort: (laneId: string, eff: CrewLaneEffort) => void
  onRestartLane: (laneId: string) => void
  onToggleLaneMute: (laneId: string) => void
  onAbortAll: () => void
  onAbortSupervisor: () => void
  onSendToSupervisor: (text: string) => void
  onSetSupervisorEnabled: (enabled: boolean) => void
  onSetSupervisorAgent: (agentId: string) => void
  onSetSupervisorModel: (model: string) => void
  userRequestsByTab?: Record<string, AgentUserRequest[]>
  onAgentRequestResponse?: (response: AgentUserResponse) => void
}

export function CrewBranch(props: CrewBranchProps) {
  const {
    activeTabId, session, agents, editing,
    messagesByTab, ptyPanes, templates, crew,
    sendToLane, onBroadcast, closePtyPane,
    onEnterEditing, onExitEditing, setCrewDiffTab, setCrewGitTab, setRebuildConfirmOpen,
    onApplyTemplate, onDeleteTemplate, onSaveTemplate,
    onSetLaneRole, roles, onSaveRole, onUpdateRole, onDeleteRole,
    onSetLaneModel, onSetLaneEffort, onRestartLane, onToggleLaneMute,
    onAbortAll, onAbortSupervisor, onSendToSupervisor,
    onSetSupervisorEnabled, onSetSupervisorAgent, onSetSupervisorModel,
    userRequestsByTab, onAgentRequestResponse,
  } = props

  if (session.state === 'configuring' || (session.state === 'active' && editing)) {
    return (
      <CrewConfigPanel
        session={session}
        agents={agents}
        editing={session.state === 'active'}
        onSetName={n => crew.setName(activeTabId, n)}
        onSetMode={m => crew.setMode(activeTabId, m)}
        onAddLane={(a: any, r: any) => crew.addLane(activeTabId, a, r)}
        onRemoveLane={(l: any) => crew.removeLane(activeTabId, l)}
        onSetLaneAgent={(l: any, a: any) => crew.setLaneAgent(activeTabId, l, a)}
        onSetLaneRole={onSetLaneRole}
        roles={roles}
        onSaveRole={onSaveRole}
        onUpdateRole={onUpdateRole}
        onDeleteRole={onDeleteRole}
        onSetLaneModel={onSetLaneModel}
        onSetLaneEffort={onSetLaneEffort}
        onLaunch={() => crew.launch(activeTabId)}
        onRebuild={() => setRebuildConfirmOpen(true)}
        onCancel={session.state === 'active' ? onExitEditing : () => crew.discard(activeTabId)}
        templates={templates}
        onApplyTemplate={onApplyTemplate}
        onDeleteTemplate={onDeleteTemplate}
        onSetSupervisorEnabled={onSetSupervisorEnabled}
        onSetSupervisorAgent={onSetSupervisorAgent}
        onSetSupervisorModel={onSetSupervisorModel}
      />
    )
  }

  return (
    <CrewSurface
      session={session}
      agents={agents}
      messagesByTab={messagesByTab}
      ptyPanes={ptyPanes}
      onSendToLane={sendToLane}
      onBroadcast={onBroadcast}
      onClosePane={closePtyPane}
      onEdit={onEnterEditing}
      onArchive={() => crew.archive(activeTabId)}
      onReset={() => crew.reset(activeTabId)}
      onShowDiff={() => setCrewDiffTab(activeTabId)}
      onShowGit={() => setCrewGitTab(activeTabId)}
      onSaveTemplate={onSaveTemplate}
      onSetLaneModel={onSetLaneModel}
      onSetLaneEffort={onSetLaneEffort}
      onRestartLane={onRestartLane}
      onToggleLaneMute={onToggleLaneMute}
      onAbortAll={onAbortAll}
      onAbortSupervisor={onAbortSupervisor}
      onSendToSupervisor={onSendToSupervisor}
      onSetDistribution={d => crew.setDistribution(activeTabId, d)}
      userRequestsByTab={userRequestsByTab}
      onAgentRequestResponse={onAgentRequestResponse}
    />
  )
}
