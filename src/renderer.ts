import './index.css';
import { BUILD, buildLabel } from './build-info';
import type { AgentStatus, SyncState } from './shared/agent-api';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const loading = $('#loading');
const form = $<HTMLFormElement>('#pair-form');
const codeInput = form.elements.namedItem('code') as HTMLInputElement;
const nameInput = form.elements.namedItem('name') as HTMLInputElement;
const submit = $<HTMLButtonElement>('#pair-form button');
const error = $('#pair-error');
const paired = $('#paired');

// Settings screen: server + monitored accounts, read from the service, saved as admin.
const settings = $('#settings');
const settingsForm = $<HTMLFormElement>('#settings-form');
const apiUrlInput = settingsForm.elements.namedItem('apiUrl') as HTMLInputElement;
const accountsBox = $('#accounts');
const settingsError = $('#settings-error');
const settingsOk = $('#settings-ok');
const settingsSubmit = $<HTMLButtonElement>('#settings-form button[type="submit"]');
const openSettingsButton = $<HTMLButtonElement>('#open-settings');
let settingsOpen = false;
let lastStatus: AgentStatus | null = null;

function showSettings(open: boolean) {
  settingsOpen = open;
  settings.hidden = !open;
  openSettingsButton.hidden = open;
  if (lastStatus) render(lastStatus);
}

async function openSettings() {
  settingsError.hidden = true;
  settingsOk.hidden = true;
  showSettings(true);
  try {
    const s = await window.agent.getSettings();
    apiUrlInput.value = s.apiUrl;
    accountsBox.querySelectorAll('label').forEach((l) => l.remove());
    for (const account of s.accounts) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = account.sid;
      box.checked = account.monitored;
      label.append(box, `${account.name}${account.admin ? ' (administrateur)' : ''}`);
      accountsBox.append(label);
    }
  } catch {
    settingsError.textContent = 'Service CtrlAltBro injoignable.';
    settingsError.hidden = false;
  }
}

openSettingsButton.addEventListener('click', () => void openSettings());
$('#settings-close').addEventListener('click', () => showSettings(false));

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  settingsError.hidden = true;
  settingsOk.hidden = true;
  const sids = [...accountsBox.querySelectorAll<HTMLInputElement>('input:checked')].map((b) => b.value);
  settingsSubmit.disabled = true;
  const result = await window.agent.saveSettings(apiUrlInput.value, sids);
  settingsSubmit.disabled = false;
  if (result.ok) {
    settingsOk.hidden = false;
  } else {
    settingsError.textContent = result.error;
    settingsError.hidden = false;
  }
});

function render(status: AgentStatus) {
  lastStatus = status;
  loading.hidden = true;
  form.hidden = status.paired || settingsOpen;
  paired.hidden = !status.paired || settingsOpen;
  if (status.paired) {
    $('#device-name').textContent = status.deviceName;
    $('#sync-status').textContent = syncLabel(status.sync);
    $('#sync-status').classList.toggle('error', !!status.sync.error);
  } else {
    nameInput.value ||= status.suggestedName;
    if (!settingsOpen) codeInput.focus();
  }
}

codeInput.addEventListener('input', () => {
  const chars = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  codeInput.value = chars.length > 4 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submit.disabled = true;
  submit.textContent = 'Appairage…';
  error.hidden = true;

  const result = await window.agent.pair(codeInput.value, nameInput.value);

  submit.disabled = false;
  submit.textContent = 'Appairer ce PC';
  if (result.ok) {
    render(result.status);
  } else {
    error.textContent = result.error;
    error.hidden = false;
  }
});

function syncLabel({ lastSyncAt, error }: SyncState) {
  const last = lastSyncAt ? `Dernière synchro : ${new Date(lastSyncAt).toLocaleTimeString()}` : 'Synchronisation…';
  return error ? `${error} — ${lastSyncAt ? last.toLowerCase() : 'nouvel essai bientôt'}` : last;
}

const buildEl = $('#build');
buildEl.textContent = buildLabel();
buildEl.title = `Build du ${new Date(BUILD.time).toLocaleString()}`;

window.agent.onStatus(render);
window.agent.getStatus().then(render);
