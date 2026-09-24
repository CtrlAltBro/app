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
| `src/main/sync.ts` | Heartbeat loop: `/ping` every 30 s (KV only, cheap). A full `/sync` runs only on `rev` change (command/rule), pending command results, a screen-time batch (every 15 min idle), or fast mode (parent watching → 15 s). Backoff on error; resync on resume; persists rules + pending results + handled command ids + last inventory hash |
| `src/main/commands.ts` | Executes commands: `show_message`, `kill_app` (taskkill), `lock_session` (LockWorkStation) |
| `src/main/inventory.ts` | Installed apps: Start menu shortcuts + Store apps (`Get-AppxPackage` manifests, named via `Get-StartApps`) + registry `Uninstall` keys (DisplayIcon exe), filtered (installers, `C:\Windows`, Package Cache). Rescanned hourly, sent only when its hash changes |
| `src/main/screen-time.ts` | Foreground app tracking: a long-lived PowerShell prints the foreground window's exe + title every 5 s; sessions (cut on app change, lock, sleep, or every minute) are queued in `screen-time-queue.json` and sent via `/sync` |
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
- [x] Screen time → `screenTime`. Counted while the session is unlocked and the PC awake, no idle threshold: Windows locks the PC after inactivity unless a video keeps the screen on, so the parent should enable lock after inactivity. Store apps (ApplicationFrameHost) are named by their window title. `C:\Windows` processes and the agent itself are ignored.
- [ ] Edge history: copy the locked `History` SQLite file, read with `better-sqlite3` (native module → rebuilt for Electron by Forge; needs VS Build Tools) → `history`.

Enforce (reconcile with the cached rules; remember what the agent set up so removed rules are undone):
- [ ] App block: IFEO `Debugger` key → stub window "application bloquée"; one-off `taskkill` when the rule appears.
- [ ] Daily limit: local per-app counter, reset at local midnight, block once the limit is reached.
- [ ] Site block: `HKLM\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist`, restart Edge to apply, `InPrivateModeAvailability = 1`.
- [x] Commands: `kill_app` (taskkill, refuses protected exes), `lock_session` (`rundll32 user32.dll,LockWorkStation`).

## Target architecture: tamper resistance

The child must not be able to close, kill or uninstall the agent. No trick between processes resists an admin account, so protection comes from Windows privileges first.

**Prerequisite (setup, not code):** the child's Windows account is a **standard user**; the parent keeps the admin account. A standard user cannot kill another account's processes, stop services, write to `HKLM` / `Program Files` / `ProgramData`, or change the system time.

**Split the agent in two:**

| | Service (runs as SYSTEM) | Session app (Electron, runs as the child, no elevation) |
| --- | --- | --- |
| Role | Sync, rules, IFEO, Edge policies, taskkill, commands, updates | Tray icon, "application bloquée" window, messages, foreground tracking (screen time), per-user inventory (HKCU, Start menu, Appx) |
| Killable by the child | No | Yes, relaunched by the service |
| Restarted by | Service Control Manager (`sc failure CtrlAltBro reset= 60 actions= restart/1000/restart/1000/restart/5000`) | The service |

- A service lives in session 0: no UI and no view of the child's desktop. That is why foreground tracking (`screen-time.ts`) and per-user inventory must move to the session app, which forwards data to the service.
- Session app ↔ service over a named pipe, with a heartbeat every few seconds. Missing heartbeat while a user session is open → the service relaunches the app (logon scheduled task running as the child, triggered with `schtasks /run`) and reports a tamper event.
- The service is probably not Electron (Forge fuses disable `RunAsNode`, headless Electron as a service is awkward): a standalone Node binary (Node SEA). `sync.ts`, `inventory.ts`, `commands.ts`, `protected.ts` move over mostly unchanged.
- **No `requireAdministrator` manifest** on the session app: it would prompt UAC at every logon. Elevation lives only in the service.

**Admin password is asked once, at install.** A per-machine MSI (UAC prompt typed by the parent) copies the app to `Program Files`, registers the service with its restart policy, creates the logon task for the session app, and creates `%ProgramData%\CtrlAltBro` with a SYSTEM/Administrators-only ACL. After that nothing ever prompts. Updates are installed by the service (already SYSTEM).

**Session app behaviour (like Discord):** close button hides the window (`close` → `preventDefault()` + `hide()`), `Tray` icon without a "Quitter" entry (or behind a parent PIN), `app.requestSingleInstanceLock()`, `skipTaskbar` while hidden. Cosmetic on its own: standard user + service is what actually prevents killing it.

**Current weaknesses to fix:**
- Squirrel installs per user in `%LOCALAPPDATA%` (the child can delete it) → per-machine MSI (`@electron-forge/maker-wix`) or NSIS per-machine.
- `device.json` / `agent-state.json` live in the child's `%APPDATA%` (can be deleted → unpairs, or edited → rules) → move to `%ProgramData%\CtrlAltBro`; DPAPI must then use machine scope, not user scope.

**Other safeguards, by priority:**
1. Dashboard alert when a device that synced recently goes silent for more than X minutes during the day (needs web-api work). Works even if everything else was bypassed.
2. Tamper events sent through `/sync` (session app killed, service restarted, clock changed, uninstall attempt) → new `events` field in the agent contract (web-api + `api-types.ts`).
3. Other browsers: a standard user can install Chrome/Firefox per user and bypass Edge policies → block `chrome.exe`, `firefox.exe`, `opera.exe`, `brave.exe` via IFEO by default.
4. Daily limits based on the server time returned by `/sync`, not only the local clock.
5. Local parent PIN (set from the dashboard, stored hashed) for quit / unpair / status.
6. Later: AppLocker (only allow `Program Files` and `C:\Windows`) blocks portable and per-user executables. Windows Pro or higher only.

**Order:**
- [ ] Child account → standard user (setup).
- [ ] Close-to-tray, `Tray` icon, single instance.
- [ ] State files → `%ProgramData%\CtrlAltBro`, machine-scope DPAPI.
- [ ] Service + session app split, SCM restart policy, named pipe + heartbeat, relaunch via logon task.
- [ ] Per-machine MSI installer with `CTRLALTBRO_API_URL` pointing to the deployed API. Code signing later (SmartScreen / Defender).
- [ ] Offline alert on the dashboard, tamper events, default block of other browsers.