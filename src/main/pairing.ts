import os from 'node:os';
import type { AgentStatus, PairResult } from '../shared/agent-api';
import { API_URL } from './config';
import { loadCredentials, saveCredentials } from './credentials';

export async function getStatus(): Promise<AgentStatus> {
  const credentials = await loadCredentials();
  if (!credentials) return { paired: false, suggestedName: os.hostname().replace(/\.local$/, '') };
  return { paired: true, deviceId: credentials.deviceId, deviceName: credentials.deviceName };
}

export async function pair(code: string, name: string): Promise<PairResult> {
  const deviceName = name.trim();
  if (!code.trim() || !deviceName) return { ok: false, error: 'Renseigne le code et le nom du PC.' };

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/agent/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), name: deviceName }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, error: 'Impossible de joindre le serveur. Vérifie la connexion internet.' };
  }

  if (res.status === 400) {
    return { ok: false, error: 'Code invalide ou expiré. Génère un nouveau code depuis le dashboard.' };
  }
  if (!res.ok) return { ok: false, error: `Erreur du serveur (HTTP ${res.status}). Réessaie plus tard.` };

  const body = (await res.json().catch((): null => null)) as { deviceId?: unknown; token?: unknown } | null;
  if (typeof body?.deviceId !== 'string' || typeof body?.token !== 'string') {
    return { ok: false, error: 'Réponse inattendue du serveur.' };
  }

  await saveCredentials({ apiUrl: API_URL, deviceId: body.deviceId, deviceName, token: body.token });
  return { ok: true, status: { paired: true, deviceId: body.deviceId, deviceName } };
}
