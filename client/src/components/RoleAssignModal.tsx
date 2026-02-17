import { createPortal } from 'react-dom';
import { useServerStore, getApiBase } from '@abyss/shared';
import { useRoleAssignStore } from '../stores/roleAssignStore';

export default function RoleAssignModal() {
  const isOpen = useRoleAssignStore((s) => s.isOpen);
  const target = useRoleAssignStore((s) => s.target);
  const selectedRoleIds = useRoleAssignStore((s) => s.selectedRoleIds);
  const setSelectedRoleIds = useRoleAssignStore((s) => s.setSelectedRoleIds);
  const close = useRoleAssignStore((s) => s.close);

  const activeServer = useServerStore((s) => s.activeServer);
  const roles = useServerStore((s) => s.roles);

  if (!isOpen || !target) return null;

  const assignableRoles = [...roles].filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);

  const handleSave = async () => {
    if (!activeServer) return;
    await useServerStore.getState().updateMemberRoles(activeServer.id, target.userId, selectedRoleIds);
    close();
  };

  return createPortal(
    <div className="modal-overlay" onClick={close}>
      <div className="modal role-assign-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Manage Roles</h2>
        <div className="role-assign-target">
          <div className="member-manage-avatar">
            {target.user.avatarUrl ? (
              <img src={target.user.avatarUrl.startsWith('http') ? target.user.avatarUrl : `${getApiBase()}${target.user.avatarUrl}`} alt={target.user.displayName} />
            ) : (
              <span>{target.user.displayName.charAt(0).toUpperCase()}</span>
            )}
          </div>
          <span className="role-assign-target-name">{target.user.displayName}</span>
        </div>
        <div className="role-assign-list">
          {assignableRoles.map((role) => {
            const checked = selectedRoleIds.includes(role.id);
            return (
              <div
                key={role.id}
                className={`role-assign-item${checked ? ' active' : ''}`}
                onClick={() => {
                  if (checked) {
                    setSelectedRoleIds(selectedRoleIds.filter((id) => id !== role.id));
                  } else {
                    setSelectedRoleIds([...selectedRoleIds, role.id]);
                  }
                }}
              >
                <span className="role-assign-color" style={{ background: role.color }} />
                <span className="role-assign-name">{role.name}</span>
                <div className={`toggle-switch small${checked ? ' on' : ''}`}>
                  <div className="toggle-knob" />
                </div>
              </div>
            );
          })}
          {assignableRoles.length === 0 && (
            <p className="role-assign-empty">No roles created yet.</p>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={close}>Cancel</button>
          <button onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
