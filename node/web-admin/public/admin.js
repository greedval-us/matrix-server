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
const keySearch = byId('key-search');
const journalTitle = byId('journal-title');
const showAllLogs = byId('show-all-logs');
const logFilters = byId('log-filters');
const logMethod = byId('log-method');
const logFooter = byId('journal-footer');
const moreLogs = byId('more-logs');
const logMessage = byId('log-message');
const logRows = byId('log-rows');
const journal = byId('journal');
const notice = byId('dashboard-notice');
const loginForm = byId('login-form');
const issueDialog = byId('issue-dialog');
const issueForm = byId('issue-form');
const issuedView = byId('issued-view');
const issuedKey = byId('issued-key');
const renameDialog = byId('rename-dialog');
const renameForm = byId('rename-form');
const renameLabel = byId('rename-label');
const revokeDialog = byId('revoke-dialog');
const revokeForm = byId('revoke-form');
const revokeButton = byId('open-revoke');
const analyticsDays = byId('analytics-days');
const analyticsContent = byId('analytics-content');
const analyticsMessage = byId('analytics-message');

const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
const dayFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
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
const modules = new Map([['search', 'Поиск'], ['catalog', 'Каталог'], ['records', 'Записи'], ['workspace', 'Рабочие таблицы']]);
const results = new Map([
  [0, 'Успешно'], [1, 'Отменено'], [2, 'Неизвестная ошибка'], [3, 'Некорректный запрос'],
  [4, 'Тайм-аут'], [5, 'Не найдено'], [6, 'Уже существует'], [7, 'Доступ запрещён'], [8, 'Лимит превышен'],
  [9, 'Условия не выполнены'], [10, 'Прервано'], [11, 'Вне диапазона'], [12, 'Не поддерживается'],
  [13, 'Ошибка сервера'], [14, 'Недоступно'], [15, 'Потеря данных'], [16, 'Ошибка авторизации'],
]);

let session = new AbortController();
let keyRequest;
let logRequest;
let analyticsRequest;
let keys = [];
let selectedId = '';
let revokeId = '';
let renameId = '';
let nextLogCursor = null;

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

function selectKey(id, focusJournal = false) {
  if (selectedId !== id) {
    selectedId = id;
    renderKeys();
    renderDetails();
    void loadLogs();
  }
  if (focusJournal) journalTitle.focus();
}

function showLogin(text = '') {
  session.abort();
  keyRequest?.abort();
  logRequest?.abort();
  analyticsRequest?.abort();
  keys = [];
  selectedId = '';
  keyList.replaceChildren();
  logRows.replaceChildren();
  byId('daily-rows').replaceChildren();
  byId('top-keys').replaceChildren();
  logFilters.reset();
  analyticsDays.value = '7';
  keySearch.value = '';
  issuedKey.value = '';
  byId('issued-label').textContent = '';
  renameLabel.value = '';
  for (const id of ['selected-label', 'selected-id', 'selected-status', 'created-at', 'activated-at', 'revoked-at', 'revoke-label']) {
    byId(id).textContent = '';
  }
  if (issueDialog.open) issueDialog.close();
  if (renameDialog.open) renameDialog.close();
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
  byId('key-breakdown').hidden = true;
  renderDetails();
  byId('page-title').focus();
  refreshDashboard();
}

function renderKeys() {
  const focusedId = document.activeElement?.dataset.keyId;
  const fragment = document.createDocumentFragment();
  const query = keySearch.value.trim().replace(/^№\s*/, '').toLocaleLowerCase('ru-RU');
  const visibleKeys = keys.filter((key) => !query || key.id.includes(query) || key.label.toLocaleLowerCase('ru-RU').includes(query));
  let focusedRow;
  for (const key of visibleKeys) {
    const row = element('button', undefined, 'key-row');
    row.type = 'button';
    row.dataset.keyId = key.id;
    row.setAttribute('aria-pressed', String(key.id === selectedId));
    row.addEventListener('click', () => selectKey(key.id, matchMedia('(max-width: 850px)').matches));
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
  count.textContent = query ? visibleKeys.length + ' / ' + keys.length : keys.length;
  count.hidden = false;
  if (!keys.length) message(keyMessage, 'Выпустите первый ключ, чтобы открыть доступ к Matrix.');
  else message(keyMessage, visibleKeys.length ? '' : 'Ключи не найдены.');
}

function renderDetails() {
  const key = keys.find((item) => item.id === selectedId);
  byId('key-detail').hidden = !key;
  showAllLogs.hidden = !selectedId;
  byId('log-key-heading').hidden = Boolean(selectedId);
  journalTitle.textContent = selectedId ? 'Журнал ключа' : 'Журнал запросов';
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
}

function renderLog(log) {
  const row = element('tr');
  const code = Number(log.status_code);
  row.append(element('td', timestamp(log.created_at), 'time-cell'));
  if (!selectedId) {
    const id = String(log.access_key_id);
    const cell = element('td');
    const key = element('button', log.label || 'Ключ №' + id, 'log-key');
    key.type = 'button';
    key.addEventListener('click', () => selectKey(id, true));
    cell.append(key, element('span', '№' + id, 'key-id'));
    row.append(cell);
  }
  const method = element('td', operations.get(log.method) || log.method, 'log-method');
  method.append(element('span', modules.get(log.module) || log.module, 'log-module'));
  const outcome = element('td', results.get(code) || 'Неизвестный результат',
    'log-status ' + (code === 0 ? 'ok' : code === 1 ? 'muted' : 'failed'));
  if (code > 1) outcome.append(element('span', 'Код ' + code, 'log-module'));
  row.append(method, outcome, element('td', numberFormat.format(log.duration_ms) + ' мс', 'duration'));
  return row;
}

async function loadLogs({ append = false } = {}) {
  const cursor = append ? nextLogCursor : null;
  if (append && (!cursor || moreLogs.disabled)) return;
  logRequest?.abort();
  const controller = new AbortController();
  logRequest = controller;
  if (!append) {
    nextLogCursor = null;
    logRows.replaceChildren();
    journal.scrollTop = 0;
    journal.hidden = true;
    logFooter.hidden = true;
  }
  moreLogs.disabled = true;
  message(logMessage, 'Загружаем журнал…');
  const params = new URLSearchParams({ days: byId('log-days').value });
  if (logMethod.value) params.set('method', logMethod.value);
  const result = byId('log-result').value;
  if (result) params.set('result', result);
  if (cursor) params.set('before', cursor);
  const path = selectedId ? '/api/keys/' + encodeURIComponent(selectedId) + '/logs' : '/api/logs';
  try {
    const { logs, nextCursor } = await authenticatedRequest(path + '?' + params, { signal: controller.signal });
    if (controller.signal.aborted || session.signal.aborted) return;
    const fragment = document.createDocumentFragment();
    for (const log of logs) fragment.append(renderLog(log));
    const previousCount = logRows.rows.length;
    logRows.append(fragment);
    nextLogCursor = nextCursor;
    const loaded = logRows.rows.length;
    journal.hidden = !loaded;
    logFooter.hidden = !loaded;
    byId('log-count').textContent = 'Показано событий: ' + numberFormat.format(loaded);
    moreLogs.hidden = !nextLogCursor;
    if (append && !nextLogCursor) journal.focus({ preventScroll: true });
    if (append && logs.length) {
      journal.scrollTop = Math.max(0, logRows.rows[previousCount].offsetTop - journal.querySelector('thead').offsetHeight);
    }
    message(logMessage, loaded ? '' : 'По выбранным фильтрам событий нет.');
  } catch (error) {
    if (!controller.signal.aborted && !session.signal.aborted) message(logMessage, error.message, true);
  } finally {
    if (logRequest === controller) moreLogs.disabled = false;
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
    selectedId = keys.some((key) => key.id === current) ? current : '';
    renderKeys();
    renderDetails();
  } catch (error) {
    if (!controller.signal.aborted && !session.signal.aborted) message(keys.length ? notice : keyMessage, error.message, true);
  } finally {
    if (keyRequest === controller) {
      refresh.disabled = false;
      if (!controller.signal.aborted && !session.signal.aborted) void loadLogs();
    }
  }
}

function renderAnalytics({ keys: counts, totals, daily, topKeys }) {
  byId('metric-requests').textContent = numberFormat.format(totals.requests);
  byId('metric-errors').textContent = numberFormat.format(totals.errors);
  byId('metric-active').textContent = numberFormat.format(totals.activeKeys);
  byId('metric-duration').textContent = totals.requests ? numberFormat.format(totals.averageMs) + ' мс' : '—';
  byId('key-bound').textContent = numberFormat.format(counts.bound);
  byId('key-pending').textContent = numberFormat.format(counts.pending);
  byId('key-revoked').textContent = numberFormat.format(counts.revoked);
  byId('key-breakdown').hidden = false;

  const maximum = Math.max(1, ...daily.map(({ requests }) => requests));
  const days = document.createDocumentFragment();
  for (const { day, requests, errors } of [...daily].reverse()) {
    const row = element('tr');
    const date = new Date(day + 'T00:00:00Z');
    const time = element('time', dayFormat.format(date));
    time.dateTime = day;
    const dateCell = element('td');
    dateCell.append(time);
    const totalCell = element('td');
    const barAndCount = element('div', undefined, 'daily-total');
    const bar = element('meter');
    bar.max = maximum;
    bar.value = requests;
    bar.setAttribute('aria-hidden', 'true');
    barAndCount.append(bar, element('span', numberFormat.format(requests)));
    totalCell.append(barAndCount);
    row.append(dateCell, totalCell, element('td', numberFormat.format(errors)));
    days.append(row);
  }
  byId('daily-rows').replaceChildren(days);

  const top = document.createDocumentFragment();
  for (const { id, label, requests, errors } of topKeys) {
    const item = element('li');
    const button = element('button', undefined, 'top-key');
    button.type = 'button';
    button.addEventListener('click', () => selectKey(String(id), true));
    const name = element('span', undefined, 'top-key-name');
    name.append(element('span', label), element('span', '№' + id, 'key-id'));
    const metrics = element('span', undefined, 'top-key-metrics');
    metrics.append(
      element('span', numberFormat.format(requests) + ' запр.'),
      element('span', numberFormat.format(errors) + ' ош.', 'log-module'),
    );
    button.append(name, metrics);
    item.append(button);
    top.append(item);
  }
  byId('top-keys-empty').hidden = Boolean(topKeys.length);
  byId('top-keys').replaceChildren(top);
}

async function refreshAnalytics() {
  analyticsRequest?.abort();
  const controller = new AbortController();
  analyticsRequest = controller;
  analyticsContent.hidden = true;
  message(analyticsMessage, 'Загружаем аналитику…');
  try {
    const stats = await authenticatedRequest('/api/analytics?days=' + analyticsDays.value, { signal: controller.signal });
    if (controller.signal.aborted) return;
    renderAnalytics(stats);
    analyticsContent.hidden = false;
    message(analyticsMessage);
  } catch (error) {
    if (!controller.signal.aborted) message(analyticsMessage, error.message, true);
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

function refreshDashboard(preferredId) {
  void refreshKeys(preferredId);
  void refreshAnalytics();
}

refresh.addEventListener('click', () => { message(notice); refreshDashboard(); });
keySearch.addEventListener('input', () => { if (!keyRequest || !refresh.disabled || keys.length) renderKeys(); });
analyticsDays.addEventListener('change', () => void refreshAnalytics());
showAllLogs.addEventListener('click', () => selectKey('', true));
for (const [method, label] of operations) {
  const option = element('option', label);
  option.value = method;
  logMethod.append(option);
}
logFilters.addEventListener('submit', (event) => event.preventDefault());
logFilters.addEventListener('change', () => void loadLogs());
moreLogs.addEventListener('click', () => void loadLogs({ append: true }));

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
  byId('issued-label').textContent = '';
  issueForm.reset();
  message(byId('copy-feedback'));
});
byId('cancel-issue').addEventListener('click', () => issueDialog.close());
byId('close-issued').addEventListener('click', () => issueDialog.close());

issueForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const label = byId('key-label').value.trim();
  if (!label) { message(byId('issue-error'), 'Введите имя ключа.', true); return; }
  const { signal } = session;
  message(byId('issue-error'));
  setPending(issueForm, true);
  try {
    const issued = await authenticatedRequest('/api/keys', { method: 'POST', data: { label } });
    if (signal.aborted) return;
    issuedKey.value = issued.apiKey;
    byId('issued-label').textContent = issued.label;
    byId('issue-title').textContent = 'Ключ №' + issued.id + ' выпущен';
    issueForm.hidden = true;
    issuedView.hidden = false;
    byId('copy-key').focus();
    keySearch.value = '';
    refreshDashboard(String(issued.id));
  } catch (error) {
    if (!signal.aborted) message(byId('issue-error'), error.message, true);
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

byId('open-rename').addEventListener('click', () => {
  const key = keys.find((item) => item.id === selectedId);
  if (!key) return;
  renameId = key.id;
  renameLabel.value = key.label;
  message(byId('rename-error'));
  renameDialog.showModal();
  renameLabel.select();
});
byId('cancel-rename').addEventListener('click', () => renameDialog.close());
renameDialog.addEventListener('cancel', (event) => {
  if (renameForm.dataset.pending === 'true') event.preventDefault();
});
renameForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const label = renameLabel.value.trim();
  const errorNotice = byId('rename-error');
  if (!label) { message(errorNotice, 'Введите имя ключа.', true); return; }
  const { signal } = session;
  const id = renameId;
  message(errorNotice);
  setPending(renameForm, true);
  try {
    const updated = await authenticatedRequest('/api/keys/' + encodeURIComponent(id) + '/rename', { method: 'POST', data: { label } });
    if (signal.aborted) return;
    const key = keys.find((item) => item.id === id);
    if (key) key.label = updated.label;
    renameDialog.close();
    keySearch.value = '';
    renderKeys();
    renderDetails();
    message(notice, 'Имя ключа №' + id + ' изменено.');
    refreshDashboard(id);
  } catch (error) {
    if (!signal.aborted) message(errorNotice, error.message, true);
  } finally { setPending(renameForm, false); }
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
  const { signal } = session;
  message(byId('revoke-error'));
  setPending(revokeForm, true);
  try {
    const { revoked } = await authenticatedRequest('/api/keys/' + encodeURIComponent(id) + '/revoke', { method: 'POST', data: {} });
    if (signal.aborted) return;
    revokeDialog.close();
    message(notice, revoked ? 'Ключ №' + id + ' отозван.' : 'Ключ №' + id + ' уже был отозван.');
    refreshDashboard(id);
  } catch (error) {
    if (!signal.aborted) message(byId('revoke-error'), error.message, true);
  } finally { setPending(revokeForm, false); }
});

request('/api/session').then(({ authenticated }) => {
  if (authenticated) showDashboard();
  else showLogin();
}, (error) => showLogin(error.message));
