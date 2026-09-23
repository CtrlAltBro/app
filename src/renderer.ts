import './index.css';
import type { AgentStatus, SyncState } from './shared/agent-api';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const loading = $('#loading');
const form = $<HTMLFormElement>('#pair-form');
const codeInput = form.elements.namedItem('code') as HTMLInputElement;
const nameInput = form.elements.namedItem('name') as HTMLInputElement;
const submit = $<HTMLButtonElement>('#pair-form button');
const error = $('#pair-error');
const paired = $('#paired');

function render(status: AgentStatus) {
  loading.hidden = true;
  form.hidden = status.paired;
  paired.hidden = !status.paired;
  if (status.paired) {
    $('#device-name').textContent = status.deviceName;
    $('#sync-status').textContent = syncLabel(status.sync);
    $('#sync-status').classList.toggle('error', !!status.sync.error);
  } else {
    nameInput.value ||= status.suggestedName;
    codeInput.focus();
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

window.agent.onStatus(render);
window.agent.getStatus().then(render);
