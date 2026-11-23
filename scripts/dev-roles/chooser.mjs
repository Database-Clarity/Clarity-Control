/* global document, history, location, Option */
import { setSession } from '/src/services/session.ts';
import { safeReturnPath, takeReturnPath } from '/src/services/returnPath.ts';

const base = '/__clarity-local-role-harness';
const query = new URL(location.href).searchParams.get('dev-role');
const control = document.createElement('button');
control.type = 'button';
control.textContent = 'Dev role';
control.dataset.devRoleControl = '';
const bar = document.createElement('div');
bar.dataset.devRoleBar = '';
bar.append(control);
const styles = document.createElement('style');
styles.textContent = `
  :root:has([data-dev-role-bar]) {
    --dev-role-height: 2rem;
    --app-h: calc(100dvh - var(--kb-room, 0px) - var(--dev-role-height));
  }
  @supports (-webkit-touch-callout: none) {
    :root:has([data-dev-role-bar]) { --app-h: calc(100dvh - var(--dev-role-height)); }
  }
  [data-dev-role-bar] {
    display: flex; align-items: center; justify-content: end;
    block-size: var(--dev-role-height); padding-inline: .5rem;
    background: var(--chrome, Canvas); border-bottom: 1px solid var(--line, GrayText);
  }
  [data-dev-role-control] {
    box-sizing: border-box; max-inline-size: 100%; min-block-size: 1.5rem;
    padding: .125rem .5rem; color: var(--text, CanvasText); background: var(--ctl, Canvas);
    border: 1px solid var(--ctl-edge, GrayText); border-radius: .25rem;
    font: .875rem/1.125rem Arial, sans-serif;
  }
  select[data-dev-role-control] { background: var(--fld, Canvas); }
`;
document.head.append(styles);
const dialog = document.createElement('dialog');
dialog.setAttribute('aria-label', 'Development identity');
dialog.style.cssText = `
  color: var(--text, CanvasText); background: var(--raised, Canvas);
  border: 1px solid var(--pop-edge, GrayText); border-radius: .25rem;
  padding: .75rem; max-width: calc(100% - 1rem);
`;
dialog.innerHTML = `<form style="display:flex;flex-wrap:wrap;align-items:end;gap:.5rem">
  <label style="display:grid;gap:.25rem;max-width:100%">Development identity
    <select name="role" data-dev-role-control required><option value="" disabled selected>Choose a role</option></select>
  </label>
  <button type="submit" data-dev-role-control>Switch</button>
  <button type="button" data-dev-role-control data-cancel>Cancel</button>
  <p role="alert" hidden></p>
</form>`;
const form = dialog.querySelector('form');
const select = form.elements.namedItem('role');
const submit = form.querySelector('[type="submit"]');
const alert = form.querySelector('[role="alert"]');
const cancel = form.querySelector('[data-cancel]');
document.getElementById('root').before(bar);
document.body.append(dialog);

let switching = false;
let loadingRoles = false;
async function choose(role) {
  if (switching) return;
  switching = control.disabled = submit.disabled = cancel.disabled = true;
  alert.hidden = true;
  try {
    const response = await fetch(`${base}/session?role=${encodeURIComponent(role)}`, {
      method: 'POST',
      credentials: 'omit',
    });
    if (!response.ok) throw new Error('Local identity could not be selected.');
    const { token } = await response.json();
    setSession(token, false);
    const url = new URL(location.href);
    if (url.searchParams.get('dev-role') === 'choose' && !url.hash)
      url.hash = safeReturnPath(takeReturnPath());
    url.searchParams.delete('dev-role');
    history.replaceState(history.state, '', url);
    location.reload();
  } catch (error) {
    alert.textContent = error.message;
    alert.hidden = false;
    switching = control.disabled = submit.disabled = cancel.disabled = false;
    if (!dialog.open) dialog.showModal();
  }
}

async function open() {
  if (!dialog.open) dialog.showModal();
  if (select.options.length > 1 || loadingRoles) return;
  loadingRoles = true;
  submit.disabled = true;
  try {
    const response = await fetch(`${base}/roles`, { credentials: 'omit' });
    if (!response.ok) throw new Error('Local identities could not be loaded.');
    for (const { key, label } of await response.json()) select.add(new Option(label, key));
    submit.disabled = false;
    if (dialog.open) select.focus();
  } catch (error) {
    alert.textContent = error.message;
    alert.hidden = false;
  } finally {
    loadingRoles = false;
  }
}

control.addEventListener('click', () => {
  void open();
});
cancel.addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', (event) => {
  if (switching) event.preventDefault();
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  void choose(select.value);
});
if (query === 'choose') void open();
else if (query)
  void choose(query).then(() => {
    if (dialog.open) void open();
  });
