# CtrlAltBro — agent (Electron)

Parental-control agent that runs on the child's Windows PC. Pairs with an account from the dashboard, syncs with the API, enforces rules locally. Companion repo: `CtrlAltBro/web-api` (dashboard + API, the only component that talks to the database).

## Principles

- **No secret in this app.** It only knows the public API URL. The device token comes from pairing, is stored encrypted with `safeStorage` (DPAPI on Windows) in `%APPDATA%\ctrlaltbro\device.json`, and is never exposed to the renderer.
- **Declarative rules.** The API holds the desired state (rules + version); the agent caches it in `agent-state.json` and enforces it locally, so blocking and daily limits keep working offline. Commands are only for one-off actions.
- **Renderer has no Node access.** Everything goes through `src/preload.ts` (`window.agent`) → IPC → main.

## Layout

| Path | Role |
| --- | --- |
| `src/main.ts` | Electron entry: window, `initAgent()`, IPC |
| `src/main/agent.ts` | Agent state (paired / sync status), pairing, unpair on 401, pushes status to the window |
| `src/main/sync.ts` | `/sync` loop: every `nextSyncSeconds` (15 s), backoff up to 5 min, resync on resume, persists rules + pending command results + handled command ids |
| `src/main/commands.ts` | Executes commands: `show_message`, `kill_app` (taskkill), `lock_session` (LockWorkStation) |
| `src/main/inventory.ts` | Installed apps: Start menu shortcuts + Store apps (`Get-AppxPackage` manifests, named via `Get-StartApps`) + registry `Uninstall` keys (DisplayIcon exe), filtered (installers, `C:\Windows`, Package Cache). Rescanned hourly, sent only when its hash changes |
| `src/main/protected.ts` | Executables the agent must never kill or block (system processes, the agent itself) |
| `src/main/credentials.ts`, `storage.ts` | Encrypted token, atomic JSON files in `userData` |
| `src/main/config.ts` | `API_URL`, baked at build from `CTRLALTBRO_API_URL` (`.env.local`, see `.env.example`; default `http://localhost:5173`) |
| `src/shared/api-types.ts` | Hand-written mirror of the agent contract in `web-api/worker/schemas.ts`. Keep in sync by hand |
| `src/shared/agent-api.ts` | Types of `window.agent` (preload bridge) |
| `index.html`, `src/renderer.ts` | Pairing screen / paired status (vanilla TS) |

## Agent API (`/api/agent/v1`)

- `POST /pair` `{ code, name }` → `{ deviceId, token }`
- `POST /sync` (Bearer token) `{ agentVersion, rulesVersion, apps?, screenTime?, history?, commandResults? }` → `{ rules | null, commands, nextSyncSeconds }`. `rules` is only sent when `rulesVersion` is stale and replaces all rules. Screen-time and history rows carry a UUID generated here, so retries are safe. Strings must be truncated here (a payload failing validation is rejected whole).

## Conventions

- TypeScript strict, `npm run lint` + `npx tsc --noEmit` must pass.
- User-facing text in French, code and comments in English. Keep comments minimal.
- API URL per machine goes in `.env.local` (gitignored). A shell env var overrides it: `$env:CTRLALTBRO_API_URL="http://…"; npm start`.

## Dev setup

- **Host PC**: runs `web-api` with `npm run dev -- --host` (API + dashboard on the LAN, e.g. `http://192.168.1.12:5173`, port 5173 open in the firewall). The dashboard is used from here.
- **Hyper-V VM** (`WinDev2407Eval`, Windows, reached over SSH from VS Code): a clone of this repo where the agent is developed and run. This is where anything touching the registry, processes or admin rights gets tested, never on the host.
- The agent on the VM needs `.env.local` (not in git, copy `.env.example`) with `CTRLALTBRO_API_URL=http://<host LAN IP>:5173`. Check with `curl http://<host LAN IP>:5173` from the VM.
- Take a Hyper-V checkpoint of the VM before testing anything that writes to `HKLM` or kills processes.
- Launching the agent from an SSH shell runs it in session 0 (no visible window): start it from the VM desktop.

## Done

- Pairing screen, encrypted token storage.
- Sync loop: online status on the dashboard, rules received and cached, command results reported, unpair when the device is deleted from the dashboard.

## To do (Windows)

**Safety first:** IFEO / Edge policies write to `HKLM` and need admin. Test in a VM with snapshots (or a restore point + a separate Windows account). Hard-code a list of executables the agent must never block (`explorer.exe`, `winlogon.exe`, `taskmgr.exe`, `csrss.exe`, the agent itself…).

Collect (then send through `/sync`, queued on disk until a sync succeeds):
- [x] Installed apps → `apps` (Start menu, Store apps, `Uninstall` keys; sent only when it changes). Caveat: HKCU, the user Start menu and `Get-AppxPackage` are per user, so they will be SYSTEM's if the agent runs as a service.
- [ ] Foreground window tracking → `screenTime` sessions (`node-window-manager` or PowerShell polling).
- [ ] Edge history: copy the locked `History` SQLite file, read with `better-sqlite3` (native module → rebuilt for Electron by Forge; needs VS Build Tools) → `history`.

Enforce (reconcile with the cached rules; remember what the agent set up so removed rules are undone):
- [ ] App block: IFEO `Debugger` key → stub window "application bloquée"; one-off `taskkill` when the rule appears.
- [ ] Daily limit: local per-app counter, reset at local midnight, block once the limit is reached.
- [ ] Site block: `HKLM\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist`, restart Edge to apply, `InPrivateModeAvailability = 1`.
- [x] Commands: `kill_app` (taskkill, refuses protected exes), `lock_session` (`rundll32 user32.dll,LockWorkStation`).

Run as a real agent:
- [ ] Admin manifest (`requireAdministrator`), start at boot (Task Scheduler or Windows service), tray icon / hidden window.
- [ ] If running as SYSTEM: DPAPI keys are per account → pair from that context or change token storage.
- [ ] Packaging with `npm run make` (Squirrel) and `CTRLALTBRO_API_URL` pointing to the deployed API. Code signing later (SmartScreen / Defender).
