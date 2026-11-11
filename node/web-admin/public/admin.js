'use strict';

const byId = (id) => document.getElementById(id);
const checking = byId('checking');
const login = byId('login');
const dashboard = byId('dashboard');
const logout = byId('logout');
const password = byId('password');
const refresh = byId('refresh');
const keyList = byId('key-list');
const keyMessage = byId('key-message');
const logMessage = byId('log-message');
const logRows = byId('log-rows');
const journal = byId('journal');
const notice = byId('dashboard-notice');
const loginForm = byId('login-form');
const issueDialog = byId('issue-dialog');
const issueForm = byId('issue-form');
const issuedView = byId('issued-view');
const issuedKey = byId('issued-key');
const revokeDialog = byId('revoke-dialog');
const revokeForm = byId('revoke-form');
const revokeButton = byId('open-revoke');

const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
const operations = new Map(Object.entries({
  GetIndexStatus: 'Проверка поискового индекса',
  StreamDatabaseAll: 'Загрузка каталога баз',
  StreamSearch: 'Поиск по базам',
  GetCapabilities: 'Проверка доступности записей',
  ListRecords: 'Просмотр списка записей',
  CreateRecord: 'Создание записи',
  UpdateRecord: 'Изменение записи',
  DeleteRecord: 'Удаление записи',
  UploadFiles: 'Добавление файлов',
  DownloadFile: 'Скачивание файла',
  RemoveFile: 'Удаление файла',
}));
const results = new Map([[0, 'Успешно'], [1, 'Отменено'], [3, 'Некорректный запрос'], [4, 'Тайм-аут'], [5, 'Не найдено'], [7, 'Доступ запрещён'], [8, 'Лимит превышен'], [13, 'Ошибка сервера'], [14, 'Недоступно'], [16, 'Ошибка авторизации']]);

let session = new AbortController();
let keyRequest;
let logRequest;
let keys = [];
let selectedId = '';
let revokeId = '';

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(url, { method = 'GET', data, signal } = {}) {
  const options = { method, signal, credentials: 'same-origin', cache: 'no-store' };
  if (method !== 'GET') {
    options.headers = { 'Content-Type': 'application/json', 'X-Matrix-Admin': '1' };
    if (data !== undefined) options.body = JSON.stringify(data);
  }
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('Не удалось связаться с сервером. Повторите попытку.');
  }
  if (response.status === 204) return;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(body?.error || 'Сервер отклонил запрос. Повторите попытку.', response.status);
  if (!body) throw new ApiError('Сервер прислал некорректный ответ. Повторите попытку.', response.status);
  return body;
}

async function authenticatedRequest(url, options = {}) {
  const signal = options.signal ? AbortSignal.any([session.signal, options.signal]) : session.signal;
  try {
    return await request(url, { ...options, signal });
  } catch (error) {
    if (!signal.aborted && error.status === 401) showLogin('Сеанс завершён. Войдите снова.');
    throw error;
  }
}

function message(node, text = '', error = false) {
  node.textContent = text;
  node.classList.toggle('error', error);
  node.hidden = !text;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function timestamp(value) {
  if (!value) return '—';
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return dateFormat.format(date);
  }
  return String(value).replace(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/, '$3.$2.$1, $4');
}

function keyStatus(key) {
  if (key.revoked_at) return ['revoked', 'Отозван'];
  if (key.activated_at) return ['active', 'Привязан'];
  return ['pending', 'Ожидает привязки'];
}

function showLogin(text = '') {
  session.abort();
  keys = [];
  selectedId = '';
  keyList.replaceChildren();
  logRows.replaceChildren();
  issuedKey.value = '';
  for (const id of ['selected-label', 'selected-id', 'selected-status', 'created-at', 'activated-at', 'revoked-at', 'revoke-label']) {
    byId(id).textContent = '';
  }
  if (issueDialog.open) issueDialog.close();
  if (revokeDialog.open) revokeDialog.close();
  checking.hidden = true;
  dashboard.hidden = true;
  logout.hidden = true;
  login.hidden = false;
  loginForm.reset();
  message(byId('login-error'), text, true);
  password.focus();
}

function showDashboard() {
  session = new AbortController();
  password.value = '';
  checking.hidden = true;
  login.hidden = true;
  dashboard.hidden = false;
  logout.hidden = false;
  message(notice);
  message(keyMessage, 'Загружаем ключи…');
  byId('key-count').hidden = true;
  byId('key-detail').hidden = true;
  byId('no-selection').hidden = false;
  byId('page-title').focus();
  void refreshKeys();
}

function renderKeys() {
  const focusedId = document.activeElement?.dataset.keyId;
  const fragment = document.createDocumentFragment();
  let focusedRow;
  for (const key of keys) {
    const row = element('button', undefined, 'key-row');
    row.type = 'button';
    row.dataset.keyId = key.id;
    row.setAttribute('aria-pressed', String(key.id === selectedId));
    row.addEventListener('click', () => {
      if (key.id === selectedId) return;
      selectedId = key.id;
      renderKeys();
      renderDetails();
    });
    const description = element('span');
    description.append(element('span', key.label, 'key-name'), element('span', '№' + key.id, 'key-id'));
    const [kind, status] = keyStatus(key);
    row.append(description, element('span', status, 'pill ' + kind));
    const item = element('li');
    item.append(row);
    fragment.append(item);
    if (key.id === focusedId) focusedRow = row;
  }
  keyList.replaceChildren(fragment);
  focusedRow?.focus({ preventScroll: true });
  const count = byId('key-count');
  count.textContent = keys.length;
  count.hidden = false;
  message(keyMessage, keys.length ? '' : 'Выпустите первый ключ, чтобы открыть доступ к Matrix.');
}

function renderDetails() {
  logRequest?.abort();
  const key = keys.find((item) => item.id === selectedId);
  byId('key-detail').hidden = !key;
  byId('no-selection').hidden = !!key;
  byId('log-count').hidden = true;
  logRows.replaceChildren();
  journal.hidden = true;
  if (!key) return;
  byId('selected-label').textContent = key.label;
  byId('selected-id').textContent = 'Ключ №' + key.id;
  const [kind, status] = keyStatus(key);
  const statusNode = byId('selected-status');
  statusNode.className = 'pill ' + kind;
  statusNode.textContent = status;
  byId('created-at').textContent = timestamp(key.created_at);
  byId('activated-at').textContent = timestamp(key.activated_at);
  byId('revoked-at').textContent = timestamp(key.revoked_at);
  byId('revoked-fact').hidden = !key.revoked_at;
  revokeButton.hidden = !!key.revoked_at;
  void loadLogs(key.id);
}

async function loadLogs(id) {
  const controller = new AbortController();
  logRequest = controller;
  message(logMessage, 'Загружаем журнал…');
  try {
    const { logs } = await authenticatedRequest('/api/keys/' + encodeURIComponent(id) + '/logs', { signal: controller.signal });
    if (controller.signal.aborted || session.signal.aborted) return;
    const fragment = document.createDocumentFragment();
    for (const log of logs) {
      const row = element('tr');
      const code = Number(log.status_code);
      row.append(
        element('td', timestamp(log.created_at), 'time-cell'),
        element('td', operations.get(log.method) || log.method, 'log-method'),
        element('td', results.get(code) || 'Ошибка ' + code, 'log-status ' + (code === 0 ? 'ok' : 'failed')),
        element('td', Number(log.duration_ms).toLocaleString('ru-RU') + ' мс', 'duration'),
      );
      fragment.append(row);
    }
    logRows.replaceChildren(fragment);
    journal.hidden = !logs.length;
    const count = byId('log-count');
    count.textContent = logs.length;
    count.hidden = !logs.length;
    message(logMessage, logs.length ? '' : 'По этому ключу пока нет операций.');
  } catch (error) {
    if (!controller.signal.aborted && !session.signal.aborted) message(logMessage, error.message, true);
  }
}

async function refreshKeys(preferredId) {
  keyRequest?.abort();
  const controller = new AbortController();
  keyRequest = controller;
  refresh.disabled = true;
  try {
    const payload = await authenticatedRequest('/api/keys', { signal: controller.signal });
    if (controller.signal.aborted || session.signal.aborted) return;
    keys = payload.keys.map((key) => ({ ...key, id: String(key.id) }));
    const current = preferredId || selectedId;
    selectedId = keys.some((key) => key.id === current) ? current : keys[0]?.id || '';
    renderKeys();
    renderDetails();
  } catch (error) {
    if (!controller.signal.aborted && !session.signal.aborted) message(keys.length ? notice : keyMessage, error.message, true);
  } finally {
    if (keyRequest === controller) refresh.disabled = false;
  }
}

function setPending(form, pending) {
  form.dataset.pending = String(pending);
  for (const control of form.querySelectorAll('button, input')) control.disabled = pending;
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = password.value;
  setPending(loginForm, true);
  message(byId('login-error'));
  try {
    await request('/api/session', { method: 'POST', data: { password: value } });
    showDashboard();
  } catch (error) {
    message(byId('login-error'), error.message, true);
    password.value = '';
  } finally {
    setPending(loginForm, false);
    if (!login.hidden) password.focus();
  }
});

logout.addEventListener('click', async () => {
  logout.disabled = true;
  try {
    await authenticatedRequest('/api/session', { method: 'DELETE' });
    showLogin();
  } catch (error) {
    if (!session.signal.aborted) message(notice, error.message, true);
  } finally { logout.disabled = false; }
});

refresh.addEventListener('click', () => { message(notice); void refreshKeys(); });

byId('open-issue').addEventListener('click', () => {
  message(notice);
  byId('issue-title').textContent = 'Выпустить ключ';
  issueForm.hidden = false;
  issuedView.hidden = true;
  message(byId('issue-error'));
  issueDialog.showModal();
  byId('key-label').focus();
});

issueDialog.addEventListener('cancel', (event) => {
  if (issueForm.dataset.pending === 'true') event.preventDefault();
});
issueDialog.addEventListener('close', () => {
  issuedKey.value = '';
  issueForm.reset();
  message(byId('copy-feedback'));
});
byId('cancel-issue').addEventListener('click', () => issueDialog.close());
byId('close-issued').addEventListener('click', () => issueDialog.close());

issueForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const label = byId('key-label').value.trim();
  if (!label) { message(byId('issue-error'), 'Введите название ключа.', true); return; }
  message(byId('issue-error'));
  setPending(issueForm, true);
  try {
    const issued = await authenticatedRequest('/api/keys', { method: 'POST', data: { label } });
    if (session.signal.aborted) return;
    issuedKey.value = issued.apiKey;
    byId('issue-title').textContent = 'Ключ №' + issued.id + ' выпущен';
    issueForm.hidden = true;
    issuedView.hidden = false;
    byId('copy-key').focus();
    void refreshKeys(String(issued.id));
  } catch (error) {
    if (!session.signal.aborted) message(byId('issue-error'), error.message, true);
  } finally { setPending(issueForm, false); }
});

byId('copy-key').addEventListener('click', async () => {
  const feedback = byId('copy-feedback');
  try {
    await navigator.clipboard.writeText(issuedKey.value);
    if (issueDialog.open) message(feedback, 'Ключ скопирован.');
  } catch {
    if (!issueDialog.open) return;
    issuedKey.focus();
    issuedKey.select();
    message(feedback, 'Нажмите Ctrl+C или скопируйте выделенный текст через меню.');
  }
});

revokeButton.addEventListener('click', () => {
  const key = keys.find((item) => item.id === selectedId);
  if (!key || key.revoked_at) return;
  revokeId = key.id;
  byId('revoke-label').textContent = '№' + key.id + ' ' + key.label;
  message(byId('revoke-error'));
  revokeDialog.showModal();
});
byId('cancel-revoke').addEventListener('click', () => revokeDialog.close());
revokeDialog.addEventListener('cancel', (event) => {
  if (revokeForm.dataset.pending === 'true') event.preventDefault();
});
revokeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = revokeId;
  message(byId('revoke-error'));
  setPending(revokeForm, true);
  try {
    const { revoked } = await authenticatedRequest('/api/keys/' + encodeURIComponent(id) + '/revoke', { method: 'POST', data: {} });
    if (session.signal.aborted) return;
    revokeDialog.close();
    message(notice, revoked ? 'Ключ №' + id + ' отозван.' : 'Ключ №' + id + ' уже был отозван.');
    void refreshKeys(id);
  } catch (error) {
    if (!session.signal.aborted) message(byId('revoke-error'), error.message, true);
  } finally { setPending(revokeForm, false); }
});

request('/api/session').then(({ authenticated }) => {
  if (authenticated) showDashboard();
  else showLogin();
}, (error) => showLogin(error.message));
