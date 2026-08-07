import { Icon } from '../ui/Icon'

export interface EmptyWorkspaceStateProps {
  onAdd: () => void
}

export function EmptyWorkspaceState({ onAdd }: EmptyWorkspaceStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-title">no workspace yet</div>
      <div className="empty-sub">add a repo or local folder to begin</div>
      <button className="empty-cta" onClick={onAdd}>
        <Icon name="plus" size={12} /> add folder
      </button>
    </div>
  )
}
