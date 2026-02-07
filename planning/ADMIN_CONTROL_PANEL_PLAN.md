# Admin Control Panel Plan

## Goals
- Add a config value for default sysadmin username.
- Build a sysadmin-only control panel.
- Add invite-only mode with admin-generated codes.

## Plan (Status)
1. [x] Locate current auth/config/user management surfaces to anchor new sysadmin config and admin UI entrypoint.
2. [x] Add config value for default sysadmin username and enforce it at auth/authorization layer.
3. [x] Design admin control panel: list server names, users, and core settings; add navigation and access guard.
4. [~] Implement invite-only mode: toggle, generate codes in admin, enforce at registration. (Tests pending)
5. [ ] Add suggested enhancements (auditing, rate limits, role management, read-only mode, API keys).

## Suggested Enhancements
- Admin audit log (who changed what, when).
- Role/permission management beyond a single sysadmin.
- App-wide maintenance/read-only mode.
- Invitation code expiry + one-time use.
- Config change history/rollback.
