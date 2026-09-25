# CtrlAltBro — agent (Electron)

Parental-control agent that runs on the child's Windows PC. Pairs with an account from the dashboard, syncs with the API, enforces rules locally. Companion repo: `CtrlAltBro/web-api` (dashboard + API, the only component that talks to the database).

## Principles

- **No secret in this app.** It only knows the public API URL. The device token comes from pairing and is never exposed to the renderer. Today it is stored encrypted with `safeStorage` (DPAPI, user scope) in `%APPDATA%\ctrlaltbro\device.json`; target: `%ProgramData%\CtrlAltBro`, owned by the service (see "Target architecture").
- **Declarative rules.** The API holds the desired state (rules + version); the agent caches it and enforces it locally, so blocking and daily limits keep working offline. Commands are only for one-off actions.
- **The server decides the sync cadence** (`nextPingSeconds`, fast mode). Anything like "better sync on paid plans" is server-side config, not agent code.
- **The PC never accepts incoming connections.** Only the agent (target: only the service) calls out to the API over HTTPS. Any change made on the dashboard reaches the PC at the next `/ping`.
- **Renderer has no Node access.** Everything goes through `src/preload.ts` (`window.agent`) → IPC → main.

## Layout

`src/core/` is the agent logic and never imports Electron (eslint rule): it is what will run in the Windows service. What it needs from its process (version, data dir, token encryption, shortcuts, status updates, UI on the child's desktop) goes through `host()` (`src/core/host.ts`). `src/service/` runs the core in plain Node (`npm run service`, bundled by esbuild into `.service/`), today as the current user, later as the SYSTEM service. `src/main/` is the Electron session app: a client of the core over the named pipe `\\.\pipe\ctrlaltbro` (`src/shared/pipe.ts`), holding the desktop-only parts (foreground sensor, windows).

| Path | Role |
| --- | --- |
| `src/main.ts` | Electron entry: window, IPC, `connectCore()`; on quit / Windows session end, hands the running screen-time session to the core |
| `src/core/host.ts` | The `Host` interface the core runs against, `setHost()` / `host()` |
| `src/service/main.ts` | Core process: `setHost(nodeHost)`, pipe server (validates sessions from the pipe, only counts/enforces monitored SIDs), supervises the session app (relaunch when killed), last upload + `/bye` on Ctrl+C |
| `src/service/node-host.ts`, `powershell.ts` | Node `Host`: DPAPI token encryption and shortcut reading through PowerShell (input on stdin), UI requests forwarded to the connected session app |
| `src/service/monitored.ts` | Monitored accounts: `config.json` SID list (empty = default: all non-admin local accounts), `monitor` CLI helpers |
| `src/service/session-app.ts` | Per-account scheduled task (InteractiveToken) that launches the packaged app in the child's session at logon and on demand (`schtasks /run`); `loggedOnSids()` from HKEY_USERS; `runningExesForUser()` for the limit fallback |
| `src/service/ifeo.ts` | Blocks a limited app from launching once its limit is hit (IFEO `Debugger` → our app), removed at local midnight / on reset; refuses protected exes, tracks its keys in `blocked.json` |
| `src/service/cli.ts` | Admin one-shot commands: `pair` / `unpair` / `status` / `monitor` |
| `src/shared/pipe.ts` | Pipe protocol: JSON lines, typed requests (with reply) and events, both ways |
| `src/main/core-client.ts` | Session app side of the pipe: reconnects every 2 s, relays status to the window, forwards the foreground sensor while paired (sessions buffered while the core is down), shows messages / time-up screen on request |
| `src/core/agent.ts` | Agent state (paired / sync status), pairing, unpair on 401, reports status to the host, starts sync + limits |
| `src/main/ipc.ts` | IPC handlers behind `window.agent` (`agent:getStatus`, `agent:pair`), validates renderer input |
| `src/core/sync.ts` | Heartbeat loop: `/ping` every 30 s (KV only, cheap). A full `/sync` runs only on `rev` change (command/rule), pending command results, a screen-time batch (every 15 min idle), or fast mode (parent watching → 15 s), plus a forced upload on session lock / sleep. On app quit or Windows session end (`shutdownAgent`, max 4 s): last upload, then `/bye` so the dashboard shows the PC offline at once. Backoff on error; resync on resume; persists rules + pending results + handled command ids + last inventory hash |
| `src/core/commands.ts` | Executes commands: `show_message`, `kill_app` (taskkill, refuses protected exes), `lock_session` (LockWorkStation) |
| `src/core/inventory.ts` | Installed apps: Start menu shortcuts + Store apps (`Get-AppxPackage` manifests, named via `Get-StartApps`) + registry `Uninstall` keys (DisplayIcon exe), filtered (installers, `C:\Windows`, Package Cache). Rescanned hourly, sent only when its hash changes |
| `src/main/screen-time.ts` | Foreground sensor (session side): a long-lived PowerShell prints the foreground window's exe, title and rectangle every 5 s; emits finished sessions (cut on app change, lock, sleep, or every minute), one foreground tick per poll (for limits) and `leave` on lock / sleep |
| `src/core/screen-time-queue.ts` | Upload queue `screen-time-queue.json`, sent via `/sync`. Back-to-back sessions with the same app and window title are merged into one row, except sessions already handed to an upload in progress |
| `src/core/limits.ts` | Daily limits: per-app foreground counters since local midnight (`daily-usage.json`), catch-up from the API's `usedTodaySeconds`, parent resets (`usageResetAt`), warning before the limit, kill + "time's up" screen when reached, kill cooldown |
| `src/main/time-up.ts` | "Time's up" window shown where the closed app was, over a blurred in-memory snapshot of it (never uploaded) |
| `src/core/protected.ts` | Executables the agent must never kill or block (system processes, the agent itself) |
| `src/core/credentials.ts`, `storage.ts` | Token encrypted by the host, atomic JSON files in the host's data dir (`userData` today) (unique temp file per write, so concurrent writes of one file are safe) |
| `src/core/config.ts` | `API_URL`, baked at build from `CTRLALTBRO_API_URL` (`.env.local`, see `.env.example`; default `http://localhost:5173`) |
| `src/shared/api-types.ts` | Hand-written mirror of the agent contract in `web-api/worker/schemas.ts`. Keep in sync by hand |
| `src/shared/agent-api.ts` | Types of `window.agent` (preload bridge) |
| `index.html`, `src/renderer.ts` | Pairing screen / paired status (vanilla TS) |

## Agent API (`/api/agent/v1`)

- `POST /pair` `{ code, name }` → `{ deviceId, token }`
- `POST /ping` (Bearer token) → `{ rev, fast, nextPingSeconds }`. KV only on the server, never touches Neon. A changed `rev` means a rule or command is waiting → run a full `/sync`. KV is eventually consistent: a bumped `rev` can take up to ~60 s to be visible from another Cloudflare location, so a rule may need up to ~90 s to reach the PC outside fast mode.
- `POST /sync` (Bearer token) `{ agentVersion, timeZone, rulesVersion, apps?, screenTime?, history?, commandResults? }` → `{ rules | null, commands, nextSyncSeconds }`. `rules` is only sent when `rulesVersion` is stale and replaces all rules; app rules carry `usedTodaySeconds` and `usageResetAt`, and `rules.day` is the PC's local date they refer to. Screen-time and history rows carry a UUID generated here, so retries are safe. Strings must be truncated here (a payload failing validation is rejected whole).
- `POST /bye` (Bearer token): KV only, marks the PC offline immediately (app quit, shutdown).

## Conventions

- TypeScript strict, `npm run lint` + `npx tsc --noEmit` must pass.
- User-facing text in French, code and comments in English. Keep comments minimal.
- API URL per machine goes in `.env.local` (gitignored). A shell env var overrides it: `$env:CTRLALTBRO_API_URL="http://…"; npm start`.

## Dev setup

- **Host PC**: runs `web-api` with `npm run dev -- --host` (API + dashboard on the LAN, e.g. `http://192.168.1.12:5173`, port 5173 open in the firewall). The dashboard is used from here.
- **Hyper-V VM** (`WinDev2407Eval`, Windows, reached over SSH from VS Code): a clone of this repo where the agent is developed and run. This is where anything touching the registry, processes or admin rights gets tested, never on the host.
- The agent on the VM needs `.env.local` (not in git, copy `.env.example`) with `CTRLALTBRO_API_URL=http://<host LAN IP>:5173`. Check with `curl http://<host LAN IP>:5173` from the VM.
- Take a Hyper-V checkpoint of the VM before testing anything that writes to `HKLM`, kills processes, or installs a service.
- Run the agent as two processes, from the VM desktop: `npm run service` (core, rebuilt at each run) then `npm start` (Electron session app). Launching Electron from an SSH shell runs it in session 0 (no visible window).
- As a real SYSTEM service (milestone 3): `npm run build:service`, then `scripts/install-service.ps1 -WinSW C:\Tools\WinSW-x64.exe` (admin). Pair with `node "C:\Program Files\CtrlAltBro\service.js" pair <code> "<name>"` and restart the service. To redeploy after a rebuild: copy `.service\service.js` over the one in `C:\Program Files\CtrlAltBro`, then `ctrlaltbro-svc.exe restart`. Remove it with `scripts/uninstall-service.ps1`. When the service runs, do NOT also run `npm run service`; only `npm start` for the session app. Logs: `C:\Program Files\CtrlAltBro\ctrlaltbro-svc.out.log`.
- To test as SYSTEM without installing a service: `psexec -s -i cmd` (Sysinternals) opens a SYSTEM shell on the desktop.
- Test the tamper cases from a **second, standard Windows account** on the VM (the "child"), not from the admin account.

## Done

- Pairing screen, encrypted token storage.
- Sync: cheap `/ping` heartbeat + full `/sync` only when needed, online status on the dashboard, rules received and cached, command results reported, last upload + `/bye` on quit / shutdown, unpair when the device is deleted from the dashboard.
- Installed apps inventory, screen time, commands (`show_message`, `kill_app`, `lock_session`).
- Daily limits with warning, kill and "time's up" screen.

## To do (Windows)

**Safety first:** IFEO / Edge policies write to `HKLM` and need admin. Test in the VM with checkpoints. Never block anything in `protected.ts` (`explorer.exe`, `winlogon.exe`, `taskmgr.exe`, `csrss.exe`, the agent itself…).

Collect (then send through `/sync`, queued on disk until a sync succeeds):
- [x] Installed apps → `apps` (Start menu, Store apps, `Uninstall` keys; sent only when it changes).
- [x] Screen time → `screenTime`. Counted while the session is unlocked and the PC awake, no idle threshold: Windows locks the PC after inactivity unless a video keeps the screen on, so the parent should enable lock after inactivity. Store apps (ApplicationFrameHost) are named by their window title. `C:\Windows` processes and the agent itself are ignored.
- [ ] Edge history: copy the locked `History` SQLite file of every Edge profile, read with `better-sqlite3` (native module → rebuilt for Electron by Forge; needs VS Build Tools) → `history`. Target: done by the service (see split), so the native module must also build for plain Node.

Enforce (reconcile with the cached rules; remember what the agent set up so removed rules are undone):
- [ ] App block: IFEO `Debugger` key → stub "application bloquée"; one-off `taskkill` when the rule appears. The stub can be the session app's own exe with a `--blocked <exe>` argument: `requestSingleInstanceLock()` forwards it to the running instance (`second-instance`), which shows the window. Without the session app, the stub still blocks (it just never starts the real exe).
- [x] Daily limit: local per-app counter, reset at local midnight, kill + "time's up" screen once the limit is reached.
- [ ] Site block: Edge `URLBlocklist` policy, restart Edge to apply, `InPrivateModeAvailability = 1`. Prefer the per-user key `HKU\<child SID>\Software\Policies\Microsoft\Edge` (read-only for the user, so the parent's Edge is not affected; verify on the VM) over `HKLM`.
- [x] Commands: `kill_app` (taskkill, refuses protected exes), `lock_session` (`rundll32 user32.dll,LockWorkStation`).

## Target architecture: service + session app (next big project)

The child must not be able to close, kill or uninstall the agent, nor tamper with its files. No trick between processes resists an admin account, so protection comes from Windows privileges first.

**Prerequisite (setup, not code):** the child's Windows account is a **standard user**; the parent keeps the admin account. A standard user cannot kill another account's processes, stop services, write to `HKLM` / `Program Files` / `ProgramData`, or change the system time. It **can** change the time zone by default (see pitfall 8).

**Current weaknesses this fixes:**
- Squirrel installs per user in `%LOCALAPPDATA%` → the child can delete the app.
- `device.json`, `agent-state.json`, `daily-usage.json`, `screen-time-queue.json` live in the child's `%APPDATA%` → deleting them unpairs the PC or resets daily limits; editing them changes cached rules.
- Everything runs as the child → killable from Task Manager.
- Pairing happens in the child's session → the child can pair the PC to their own account.

### Split

| | Service (runs as SYSTEM, session 0) | Session app (Electron, runs as the child, no elevation) |
| --- | --- | --- |
| Role | Source of truth: token, sync, rules, limit decisions, inventory, Edge history, IFEO / Edge policies, taskkill, state files, updates | Sensor + UI: foreground tracking, "time's up" / "application bloquée" windows, messages, lock, status, tray icon |
| Talks to the API | Yes, the only component that does | Never, only to the service through the pipe |
| Killable by the child | No | Yes, relaunched by the service |
| Restarted by | Service Control Manager (`sc failure CtrlAltBro reset= 60 actions= restart/1000/restart/1000/restart/5000`) | The service |

**Where each current module goes:**

| Module | Goes to | Why |
| --- | --- | --- |
| `credentials.ts`, `storage.ts` | Service | Files in `%ProgramData%\CtrlAltBro`, ACL SYSTEM + Administrators only |
| `sync.ts`, pairing / unpair logic of `agent.ts` | Service | It owns the token and talks to the API |
| Pairing UI (`index.html`, `renderer.ts`) | Installer / admin command | The child must not be able to pair; the session app only shows the status |
| `limits.ts` (counters, decisions) | Service | The child must not be able to reset counters |
| `inventory.ts` | Service, entirely | As SYSTEM it can read the child's hive (`HKU\<SID>`), their Start menu (`C:\Users\<child>\…`) and `Get-AppxPackage -AllUsers`: no need to trust the session app for it |
| Edge history (to do) | Service | As SYSTEM it reads `C:\Users\<child>\AppData\Local\Microsoft\Edge\User Data\*\History` directly |
| `commands.ts` → `kill_app` | Service | taskkill works from session 0 |
| `commands.ts` → `lock_session`, `show_message` | Session app | Must run on the child's desktop (service fallback for lock below) |
| `screen-time.ts` (foreground polling) | Session app | Session 0 cannot see the child's foreground window; it forwards ticks/sessions to the service, which queues and uploads them |
| `time-up.ts`, tray, status window | Session app | UI |
| `protected.ts`, `shared/api-types.ts` | Both | Shared code |

### Pitfalls to design for

1. **Session app killed → no foreground ticks → no limits.** The service needs a fallback that depends on nothing else: count as "used" the time a limited exe is *running* in the child's session (`tasklist /fi "SESSION eq N"`), coarser but untamperable; and once a limit is reached, set an **IFEO block until local midnight** on that exe so it cannot be relaunched even without the session app. Killing the session app must only cost precision, never time.
2. **The named pipe is not really authenticated.** Any script run by the child can connect and pretend to be the session app. The service trusts the pipe only for telemetry (screen time) and UI requests, **never** for unpair, rule changes or counter resets. Create it with an explicit ACL (SYSTEM + interactive users), one connection per session, and a message rate cap. Cross-check foreground ticks with the processes actually running in the child's session (ignore ticks for an exe that is not running). Bonus: check that the connecting process image lives in `Program Files` (not writable by the child).
3. **Pairing and re-pairing.** Pairing moves out of the child's session: the parent enters the pairing code during the MSI install (admin), or through an admin-only command. The service refuses a new pairing while already paired, unless done by an admin (or with a parent PIN).
4. **Token encryption.** `safeStorage` is Electron-only and user-scoped. In the service, the **ACL on `%ProgramData%\CtrlAltBro` is the real protection**; machine-scope DPAPI (PowerShell `ProtectedData`, `LocalMachine`) adds little since any SYSTEM/admin process can decrypt it.
5. **Lock without the session app:** `tsdiscon <session id>` from the service disconnects the session back to the lock screen. Fallback for `lock_session`.
6. **Launching the session app into the child's session from SYSTEM:** either a logon scheduled task bound to the `Users` group triggered with `schtasks /run` (verify on the VM how it behaves with a group principal), or `WTSQueryUserToken` + `CreateProcessAsUser` via **koffi** (FFI to Win32 from Node, no compilation).
7. **No `requireAdministrator` manifest** on the session app: it would prompt UAC at every logon. Elevation lives only in the service.
8. **Time zone.** Standard users hold "Change the time zone" (`SeTimeZonePrivilege`) by default: changing it shifts local midnight and resets daily limits early. Remove that right from `Users` at install (local security policy), and/or compute the day in the time zone the parent chose on the dashboard; report a tamper event when the zone changes.
9. **Which accounts are monitored.** The service sees every session: the parent logged in on the same PC, several children, fast user switching. Keep a list of monitored SIDs (chosen at install, later from the dashboard); counters, screen time and history are per SID; never count or kill anything in the parent's session. The dashboard's "online" will mean "PC on" (the service pings with nobody logged in), so send the child's session state (none / active / locked) in `/ping` or `/sync`.
10. **IFEO is machine-wide and name-based.** A `Debugger` key on `jeu.exe` also blocks the parent, and a copied, renamed exe bypasses it. Acceptable at first; the stub can let the real exe run when the launching user is not monitored (needs care: the stub must start it without re-triggering IFEO). AppLocker (safeguard 6) is the real fix for renamed or portable exes.
11. **Updates run as SYSTEM.** Whatever the service downloads and installs runs with full rights, so a compromised API would mean SYSTEM code on every PC. Sign update packages and verify them against a public key embedded in the agent, separate from anything the server holds. Also matters for self-hosted instances.
12. **Safe Mode** (verify on the VM): services do not start in Safe Mode unless listed under `HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\Network`. Check whether a standard user can reach it; otherwise the offline alert is the safety net.

### Tech

- Service = plain `node.exe` + one JS bundle (esbuild), wrapped as a Windows service by **WinSW** (install, restart policy). Node SEA (single exe) later: it complicates native modules like koffi and `better-sqlite3`. Not Electron: Forge fuses disable `RunAsNode`, and headless Electron as a service is awkward.
- The core must also run in console mode (`node service.js --console`) for debugging, and as SYSTEM via `psexec -s -i`.
- Session app ↔ service: named pipe `\\.\pipe\ctrlaltbro`, JSON messages, heartbeat every few seconds. Missing heartbeat while a monitored user session is open → the service relaunches the app and records a tamper event.

### Milestones (each one testable, VM checkpoint before 3, 4, 5)

- [x] 1. **Extract the core from Electron, no behavior change.** `sync`, `credentials`, `storage`, `limits`, `commands`, `inventory` stop importing `electron`; what they need (`app.getVersion`, `safeStorage`, `dialog`, `powerMonitor`, UI requests) goes through a small interface. The app works exactly as before.
- [x] 2. **Core as a separate Node process, Electron app as a pipe client** (status, foreground ticks, UI requests). Everything still runs as the current user, easy to debug.
- [x] 3. **Core as a SYSTEM service via WinSW.** Done: state in `%ProgramData%\CtrlAltBro`, ACL locked to SYSTEM + Administrators (`scripts/install-service.ps1`, `service/winsw/ctrlaltbro.xml`), token DPAPI machine scope (admin pairs, SYSTEM reads), admin CLI (`service.js pair|unpair|status`), pairing refused from the child's session, re-pairing refused while paired, pipe opened with `readableAll`/`writableAll` so the child's session app can connect. Tested on the VM (PsExec then real service). **Deferred to milestone 4:** monitored SIDs + per-SID counters — chosen model A (one PC = one dashboard device; SIDs only exclude the parent's session and separate two children on one PC), goes with running the app in the child's session.
- [~] 4. **Session app lifecycle + monitored SIDs (model A).** Done: monitored SIDs (`config.json`, default non-admins, `monitor` CLI); the service only counts/enforces monitored sessions and never the parent's; app-closing scoped to the child's account (`taskkill /FI USERNAME`); tray icon, close hides to tray, no "Quitter" for the child, single instance, app sends `hello {sid}`; the service launches the packaged app in the child's session at logon and **relaunches it when killed** (per-account scheduled task + 10 s supervisor); **limit fallback with the app down** — the service counts a limited exe's *running* time (`tasklist`) and, once a limit is hit, blocks it from launching with an IFEO key until local midnight (`ifeo.ts`, removed at midnight / reset / when the rule goes away). So killing the app never buys time or reopens a blocked app. **Still to do in this milestone:** lock fallback (`tsdiscon`), a message when the app is down (`WTSSendMessage` / `msg.exe`), foreground-tick cross-check, and a dashboard **health check** (service alive / session app connected / child session state).
- [ ] 5. **Per-machine installer** (WiX MSI via `@electron-forge/maker-wix`, or NSIS per-machine), admin password asked once at install: copies to `Program Files`, registers the service + restart policy, creates the logon launch for the session app, creates `%ProgramData%\CtrlAltBro` with its ACL, asks for the pairing code, the monitored accounts and the API URL (`config.json`), removes the time-zone right from `Users`; uninstall requires admin. Updates installed by the service, signed (pitfall 11). Code signing later (SmartScreen / Defender).
- [ ] 6. **Tamper events** through `/sync` (session app killed, service restarted, clock or time zone changed, uninstall attempt) → new `events` field in the agent contract (web-api + `api-types.ts`), plus the dashboard offline alert (web-api).

### Other safeguards, by priority

1. Dashboard alert when a device that synced recently goes silent for more than X minutes during the day (web-api). Works even if everything else was bypassed.
2. Tamper events (milestone 6).
3. Other browsers: a standard user can install Chrome/Firefox per user and bypass Edge policies → block `chrome.exe`, `firefox.exe`, `opera.exe`, `brave.exe` via IFEO by default.
4. Daily limits based on the server time returned by `/sync`, not only the local clock.
5. Local parent PIN (set from the dashboard, stored hashed) for quit / unpair / status.
6. Later: AppLocker (only allow `Program Files` and `C:\Windows`) blocks portable, renamed and per-user executables. Windows Pro or higher only.

## Production & self-hosting (last step)

- First launch can be self-hosted only (no SaaS), with good docs.
- The API URL is baked at build today. For self-hosters, the installer should write it to `%ProgramData%\CtrlAltBro\config.json` (MSI property or install prompt, admin-writable only), so one installer works for any instance; the build-time URL becomes only a default.
- Hosted plans (e.g. faster sync) are server-side: the API already controls `nextPingSeconds` and fast mode.
- **Cloudflare free plan budget** (limits reset at 00:00 UTC, an exceeded one makes that operation fail): 100k Worker requests, 100k KV reads, 1,000 KV writes per day. One PC costs per hour on: 120 pings, ~480 KV reads (`tok:`, `rev:`, `view:`, `seen:`), ~19 KV writes (`seen:` every 4 min + `tok:` rewritten on each `/sync`, ~4 per hour when idle). One hour of a parent watching a PC adds ~360 writes (`view:` every 30 s + `tok:` on each 15 s sync). **Writes are the binding limit**: a family with a few PCs on a few hours a day fits; more needs Workers Paid ($5/month: 10M reads + 1M writes per month) or a longer idle `nextPingSeconds`. Server-side fixes before that: write `tok:` only on a cold cache, and write `view:` only when it is about to expire.