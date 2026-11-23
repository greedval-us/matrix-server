'use strict';

const byId = (id) => document.getElementById(id);
const checking = byId('checking');
const login = byId('login');
const dashboard = byId('dashboard');
const pageTitle = byId('page-title');
const showAccess = byId('show-access');
const showAnalytics = byId('show-analytics');
const analyticsView = byId('analytics-view');
const showCatalog = byId('show-catalog');
const showFieldLabels = byId('show-field-labels');
const fieldLabelsView = byId('field-labels-view');
const fieldLabelSearch = byId('field-label-search');
const fieldLabelNotice = byId('field-label-notice');
const fieldLabelMessage = byId('field-label-message');
const fieldLabelTable = byId('field-label-table');
const fieldLabelRows = byId('field-label-rows');
const fieldLabelPagination = byId('field-label-pagination');
const fieldLabelPrev = byId('field-label-prev');
const fieldLabelNext = byId('field-label-next');
const fieldLabelDialog = byId('field-label-dialog');
const fieldLabelForm = byId('field-label-form');
const fieldLabelValue = byId('field-label-value');
const fieldLabelEditMessage = byId('field-label-edit-message');
const catalogView = byId('catalog-view');
const catalogSearch = byId('catalog-search');
const catalogNotice = byId('catalog-notice');
const catalogMessage = byId('catalog-message');
const catalogTable = byId('catalog-table');
const catalogRows = byId('catalog-rows');
const catalogPagination = byId('catalog-pagination');
const catalogPrev = byId('catalog-prev');
const catalogNext = byId('catalog-next');
const catalogEditDialog = byId('catalog-edit-dialog');
const catalogEditForm = byId('catalog-edit-form');
const catalogEditFields = byId('catalog-edit-fields');
const catalogEditMessage = byId('catalog-edit-message');
const catalogEditCancel = byId('catalog-edit-cancel');
const catalogEditSave = byId('catalog-edit-save');
const catalogEditTitle = byId('catalog-edit-title');
const catalogImportFields = byId('catalog-import-fields');
const catalogImportFolder = byId('catalog-import-folder');
const catalogImportBack = byId('catalog-import-back');
const catalogImportSelection = byId('catalog-import-selection');
const catalogTypeSelect = byId('catalog-field-type');
const catalogTypesDialog = byId('catalog-types-dialog');
const catalogTypeForm = byId('catalog-type-form');
const catalogTypeName = byId('catalog-type-name');
const catalogTypesMessage = byId('catalog-types-message');
const logout = byId('logout');
const password = byId('password');
const refresh = byId('refresh');
const keyList = byId('key-list');
const keyMessage = byId('key-message');
const keySearch = byId('key-search');
const keyStatusFilter = byId('key-status');
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
const analyticsOwner = byId('analytics-owner');
const analyticsResult = byId('analytics-result');
const analyticsSort = byId('analytics-sort');
const analyticsExport = byId('analytics-export');
const analyticsContent = byId('analytics-content');
const analyticsMessage = byId('analytics-message');

const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
const dayFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const percentFormat = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 1 });
const catalogFields = ['name', 'info', 'relevance_date', 'country', 'type', 'trust'];
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
const searchFieldNames = new Map(Object.entries({
  number: 'Телефон', mail: 'Электронная почта', snils: 'СНИЛС', inn: 'ИНН', passport: 'Паспорт',
  fio: 'ФИО', date_of_birth: 'Дата рождения', telegram: 'Telegram', vk: 'ВКонтакте',
  facebook: 'Facebook', imsi: 'IMSI', imei: 'IMEI', grz: 'Госномер', vin: 'VIN',
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
let analyticsSnapshot;
let catalogListRequest;
let catalogEditRequest;
let catalogQuery = '';
let catalogPage = 1;
let catalogLastPage = 1;
let catalogDraft;
let fieldLabelRequest;
let fieldLabelQuery = '';
let fieldLabelPage = 1;
let fieldLabelLastPage = 1;
let fieldLabelDraft;
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

async function request(url, { method = 'GET', data, signal, importId } = {}) {
  const options = { method, signal, credentials: 'same-origin', cache: 'no-store' };
  if (method !== 'GET') {
    const binary = data instanceof Blob;
    options.headers = { 'Content-Type': binary ? data.type : 'application/json', 'X-Matrix-Admin': '1' };
    if (importId) options.headers['X-Matrix-Import-Id'] = importId;
    if (data !== undefined) options.body = binary ? data : JSON.stringify(data);
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

function renderOwnerOptions() {
  const selected = analyticsOwner.value;
  const owners = [...new Set(keys.map(({ label }) => label))].sort((a, b) => a.localeCompare(b, 'ru-RU'));
  const all = element('option', 'Все владельцы');
  all.value = '';
  const options = owners.map((owner) => {
    const option = element('option', owner);
    option.value = owner;
    return option;
  });
  analyticsOwner.replaceChildren(all, ...options);
  analyticsOwner.value = owners.includes(selected) ? selected : '';
  analyticsOwner.disabled = !owners.length;
  return analyticsOwner.value !== selected;
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
  resetCatalog();
  resetFieldLabels();
  keys = [];
  selectedId = '';
  keyList.replaceChildren();
  logRows.replaceChildren();
  byId('daily-rows').replaceChildren();
  byId('top-keys').replaceChildren();
  byId('analytics-owner-rows').replaceChildren();
  byId('analytics-operation-rows').replaceChildren();
  byId('analytics-search-field-rows').replaceChildren();
  byId('analytics-search-owner').textContent = '';
  byId('analytics-error-codes').replaceChildren();
  analyticsSnapshot = undefined;
  analyticsExport.disabled = true;
  logFilters.reset();
  analyticsDays.value = '7';
  analyticsResult.value = 'all';
  analyticsSort.value = 'requests';
  renderOwnerOptions();
  keySearch.value = '';
  keyStatusFilter.value = 'active';
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
  showDashboardSection('access');
  pageTitle.focus();
  refreshDashboard();
}

function renderKeys() {
  const focusedId = document.activeElement?.dataset.keyId;
  const fragment = document.createDocumentFragment();
  const query = keySearch.value.trim().replace(/^№\s*/, '').toLocaleLowerCase('ru-RU');
  const filter = keyStatusFilter.value === 'unused' ? 'pending' : keyStatusFilter.value;
  const counts = { active: 0, pending: 0, revoked: 0 };
  let visible = 0;
  let focusedRow;
  for (const key of keys) {
    const [kind, status] = keyStatus(key);
    counts[kind]++;
    if (filter !== 'all' && kind !== filter) continue;
    if (query && !key.id.includes(query) && !key.label.toLocaleLowerCase('ru-RU').includes(query)) continue;
    visible++;
    const row = element('button', undefined, 'key-row');
    row.type = 'button';
    row.dataset.keyId = key.id;
    row.setAttribute('aria-pressed', String(key.id === selectedId));
    row.addEventListener('click', () => selectKey(key.id, matchMedia('(max-width: 850px)').matches));
    const description = element('span');
    description.append(element('span', key.label, 'key-name'), element('span', '№' + key.id, 'key-id'));
    row.append(description, element('span', status, 'pill ' + kind));
    const item = element('li');
    item.append(row);
    fragment.append(item);
    if (key.id === focusedId) focusedRow = row;
  }
  keyList.replaceChildren(fragment);
  focusedRow?.focus({ preventScroll: true });
  const count = byId('key-count');
  count.textContent = visible === keys.length ? visible : visible + ' / ' + keys.length;
  count.hidden = false;
  byId('key-bound').textContent = numberFormat.format(counts.active);
  byId('key-pending').textContent = numberFormat.format(counts.pending);
  byId('key-revoked').textContent = numberFormat.format(counts.revoked);
  byId('key-breakdown').hidden = !keys.length;
  if (!keys.length) message(keyMessage, 'Выпустите первый ключ, чтобы открыть доступ к Matrix.');
  else if (visible) message(keyMessage);
  else if (query) message(keyMessage, 'Ключи не найдены. Измените запрос или статус.');
  else message(keyMessage, 'Ключей с выбранным статусом нет. Выберите другой статус.');
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

async function refreshKeys(preferredId, revealKey) {
  keyRequest?.abort();
  const controller = new AbortController();
  keyRequest = controller;
  refresh.disabled = true;
  try {
    const payload = await authenticatedRequest('/api/keys', { signal: controller.signal });
    if (controller.signal.aborted || session.signal.aborted) return;
    keys = payload.keys.map((key) => ({ ...key, id: String(key.id) }));
    const selected = keys.find((key) => key.id === (preferredId || selectedId));
    selectedId = selected?.id ?? '';
    if (revealKey && selected && keyStatusFilter.value !== 'all') {
      const [kind] = keyStatus(selected);
      keyStatusFilter.value = kind === 'pending' ? 'unused' : kind;
    }
    if (renderOwnerOptions() && !analyticsView.hidden) void refreshAnalytics();
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

function openAnalyticsKey(id) {
  const key = keys.find(row => row.id === String(id));
  if (!key) return;
  keySearch.value = '';
  keyStatusFilter.value = 'all';
  byId('log-days').value = analyticsDays.value;
  logMethod.value = '';
  byId('log-result').value = analyticsResult.value === 'all' ? '' : analyticsResult.value;
  selectedId = key.id;
  showDashboardSection('access');
  renderKeys();
  renderDetails();
  void loadLogs();
  journalTitle.focus();
}

function renderAnalyticsOperations() {
  const rows = analyticsSnapshot?.stats.usage?.operations ?? [];
  const sort = analyticsSort.value;
  const sorted = [...rows].sort((a, b) =>
    (b[sort] ?? -1) - (a[sort] ?? -1) || b.requests - a.requests);
  byId('analytics-operation-rows').replaceChildren(...sorted.map(row => {
    const tr = element('tr');
    const name = element('th');
    name.scope = 'row';
    const title = operations.get(row.method) || row.method;
    name.append(element('strong', title), element('span',
      row.background ? 'Служебная проверка' : (modules.get(row.module) || row.module), 'analytics-meta'));
    const errors = element('td', numberFormat.format(row.errors));
    if (analyticsResult.value === 'all' && row.errors && row.requests) {
      errors.append(element('span', percentFormat.format(row.errors / row.requests), 'analytics-meta'));
    }
    tr.append(name,
      element('td', numberFormat.format(row.requests)),
      element('td', numberFormat.format(row.successes)),
      errors,
      element('td', numberFormat.format(row.cancelled)),
      element('td', row.p95SuccessMs == null ? '—' : numberFormat.format(row.p95SuccessMs) + ' мс'));
    return tr;
  }));
  byId('analytics-operations-table').hidden = !rows.length;
  byId('analytics-operations-empty').hidden = Boolean(rows.length);
}

function renderSearchAnalytics(search) {
  byId('analytics-search-panel').hidden = !search;
  if (!search) return;
  const { requests, withMatches, withoutMatches, unknown, averageMs, p95SuccessMs, knownFields, fields } = search;
  byId('analytics-search-owner').textContent = analyticsOwner.value || 'Все владельцы';
  byId('analytics-search-empty').hidden = requests > 0;
  byId('analytics-search-content').hidden = requests === 0;
  byId('search-metric-requests').textContent = numberFormat.format(requests);
  const knownOutcomes = withMatches + withoutMatches;
  byId('search-metric-empty').textContent = knownOutcomes ? numberFormat.format(withoutMatches) : '—';
  byId('search-metric-outcomes').textContent = unknown
    ? `Итог известен для ${numberFormat.format(knownOutcomes)} из ${numberFormat.format(requests)}`
    : '';
  const duration = value => value == null ? '—'
    : value >= 1000 ? numberFormat.format(value / 1000) + ' с' : numberFormat.format(value) + ' мс';
  byId('search-metric-average').textContent = duration(averageMs);
  byId('search-metric-p95').textContent = duration(p95SuccessMs);
  byId('analytics-search-coverage').textContent = knownFields
    ? `Поля известны для ${numberFormat.format(knownFields)} из ${numberFormat.format(requests)} запросов. В одном запросе может быть несколько полей.`
    : 'За выбранный период нет запросов с сохранёнными именами полей.';
  byId('analytics-search-fields').hidden = !fields.length;
  byId('analytics-search-field-rows').replaceChildren(...fields.map(({ field, requests }) => {
    const row = element('tr');
    const name = element('th', searchFieldNames.get(field) || field);
    name.scope = 'row';
    const count = element('td');
    const barAndCount = element('div', undefined, 'daily-total');
    const bar = element('meter');
    bar.max = Math.max(knownFields, 1);
    bar.value = requests;
    bar.setAttribute('aria-hidden', 'true');
    barAndCount.append(bar, element('span', numberFormat.format(requests)));
    count.append(barAndCount);
    row.append(name, count, element('td', knownFields ? percentFormat.format(requests / knownFields) : '—'));
    return row;
  }));
}

function renderAnalytics({ totals, topKeys, usage }) {
  byId('metric-actions').textContent = numberFormat.format(usage.actions);
  byId('metric-checks').textContent = 'Служебных проверок: ' + numberFormat.format(usage.checks);
  byId('metric-active').textContent = numberFormat.format(usage.activeOwners);
  byId('metric-errors').textContent = numberFormat.format(totals.errors);
  byId('metric-cancelled').textContent = numberFormat.format(usage.cancelled);

  const owners = usage.owners;
  byId('analytics-owners-table').hidden = !owners.length;
  byId('analytics-owners-empty').hidden = Boolean(owners.length);
  byId('analytics-owner-count').textContent = analyticsOwner.value
    ? 'Выбранный владелец'
    : `Показано ${numberFormat.format(owners.length)} из ${numberFormat.format(usage.ownerCount ?? owners.length)}`;
  byId('analytics-owner-rows').replaceChildren(...owners.map(owner => {
    const row = element('tr');
    const name = element('th');
    name.scope = 'row';
    if (analyticsOwner.value === owner.label) name.append(element('strong', owner.label));
    else {
      const button = element('button', owner.label, 'log-key');
      button.type = 'button';
      button.addEventListener('click', () => {
        if (![...analyticsOwner.options].some(option => option.value === owner.label)) return;
        analyticsOwner.value = owner.label;
        analyticsOwner.focus();
        void refreshAnalytics();
      });
      name.append(button);
    }
    const keyCount = element('td', numberFormat.format(owner.keys.total));
    keyCount.append(element('span', numberFormat.format(owner.keys.bound) + ' привязано', 'analytics-meta'));
    const activity = element('td', numberFormat.format(owner.actions));
    activity.append(element('span', numberFormat.format(owner.checks) + ' проверок', 'analytics-meta'));
    const search = element('td', owner.search ? numberFormat.format(owner.search.requests) : '—');
    if (owner.search && (owner.search.withMatches || owner.search.withoutMatches)) {
      search.append(element('span', numberFormat.format(owner.search.withoutMatches) + ' без совпадений', 'analytics-meta'));
    }
    row.append(name, keyCount, activity, search, element('td', numberFormat.format(owner.errors)),
      element('td', numberFormat.format(owner.cancelled)), element('td', timestamp(owner.lastActivity), 'time-cell'));
    return row;
  }));
  renderSearchAnalytics(usage.search);
  renderAnalyticsOperations();

  const maximum = Math.max(1, ...usage.daily.map(({ actions }) => actions));
  const days = document.createDocumentFragment();
  for (const { day, actions, checks, errors } of [...usage.daily].reverse()) {
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
    bar.value = actions;
    bar.setAttribute('aria-hidden', 'true');
    barAndCount.append(bar, element('span', numberFormat.format(actions)));
    totalCell.append(barAndCount);
    row.append(dateCell, totalCell, element('td', numberFormat.format(checks)), element('td', numberFormat.format(errors)));
    days.append(row);
  }
  byId('daily-rows').replaceChildren(days);
  byId('analytics-errors-empty').hidden = Boolean(usage.errorCodes.length);
  byId('analytics-error-codes').replaceChildren(...usage.errorCodes.map(({ code, requests }) => {
    const row = element('div');
    row.append(element('dt', (results.get(code) || 'Ошибка') + ' (' + code + ')'),
      element('dd', numberFormat.format(requests)));
    return row;
  }));

  const top = document.createDocumentFragment();
  for (const { id, label, requests, errors } of topKeys) {
    const item = element('li');
    const button = element('button', undefined, 'top-key');
    button.type = 'button';
    button.addEventListener('click', () => openAnalyticsKey(id));
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
  if (analyticsView.hidden) return;
  analyticsRequest?.abort();
  const controller = new AbortController();
  analyticsRequest = controller;
  analyticsContent.hidden = true;
  byId('analytics-metrics').hidden = true;
  analyticsSnapshot = undefined;
  analyticsExport.disabled = true;
  message(analyticsMessage, 'Загружаем аналитику…');
  const params = new URLSearchParams({ days: analyticsDays.value });
  if (analyticsOwner.value) params.set('owner', analyticsOwner.value);
  if (analyticsResult.value !== 'all') params.set('result', analyticsResult.value);
  try {
    const stats = await authenticatedRequest('/api/analytics?' + params, { signal: controller.signal });
    if (controller.signal.aborted) return;
    if (!stats.usage) throw new Error('Сервер не вернул данные аналитики.');
    analyticsSnapshot = { stats, filters: Object.fromEntries(params) };
    renderAnalytics(stats);
    analyticsContent.hidden = false;
    byId('analytics-metrics').hidden = false;
    analyticsExport.disabled = false;
    message(analyticsMessage);
  } catch (error) {
    if (!controller.signal.aborted) message(analyticsMessage, error.message, true);
  }
}

function downloadAnalytics() {
  if (!analyticsSnapshot) return;
  const { stats: { totals, topKeys, usage }, filters } = analyticsSnapshot;
  const exportRows = [
    ['Раздел', 'Наименование', 'Период (дни, UTC)', 'Владелец', 'Результат',
      'Запросы', 'Операции', 'Служебные проверки', 'Успешно', 'Ошибки', 'Отмены',
      'Среднее, мс', 'p95 успешных, мс', 'Последний запрос (UTC)', 'Ключи', 'Привязано', 'Активные владельцы',
      'Ожидают привязки', 'Отозвано', 'Поиски', 'С совпадениями', 'Без совпадений',
      'Итог поиска неизвестен', 'Поиски с известными полями'],
  ];
  const add = (section, name, data) => exportRows.push([
    section, name, filters.days, filters.owner || '', filters.result || 'all', data.requests,
    data.actions, data.checks, data.successes, data.errors, data.cancelled, data.averageMs,
    data.p95SuccessMs, data.lastActivity, data.keys?.total, data.keys?.bound, data.activeOwners,
    data.keys?.pending, data.keys?.revoked,
    data.search?.requests, data.search?.withMatches, data.search?.withoutMatches,
    data.search?.unknown, data.search?.knownFields,
  ]);
  add('Итого', '', { ...totals, ...usage });
  for (const owner of usage.owners) add('Владелец', owner.label, owner);
  if (usage.search) {
    const { averageMs, p95SuccessMs, fields } = usage.search;
    add('Поиск', '', { averageMs, p95SuccessMs, search: usage.search });
    for (const { field, requests } of fields) add('Поле поиска', field, { requests });
  }
  for (const operation of usage.operations) {
    add(operation.background ? 'Проверка' : 'Операция', operation.module + '/' + operation.method, operation);
  }
  for (const day of usage.daily) add('День', day.day, day);
  for (const { code, requests } of usage.errorCodes) add('Код ошибки', String(code), { errors: requests });
  for (const key of topKeys) add('Ключ', key.label + ' №' + key.id, key);
  const cell = value => {
    const text = String(value ?? '');
    const escaped = typeof value === 'string' && /^[\s\uFEFF]*[=+@-]/u.test(text) ? "'" + text : text;
    return '"' + escaped.replaceAll('"', '""') + '"';
  };
  const csv = '\uFEFF' + exportRows.map(row => row.map(cell).join(';')).join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = element('a');
  link.href = url;
  link.download = 'matrix-analytics.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setPending(form, pending) {
  form.dataset.pending = String(pending);
  for (const control of form.querySelectorAll('button, input, select, textarea')) control.disabled = pending;
}

function showDashboardSection(section) {
  for (const region of dashboard.querySelectorAll('[data-dashboard-view]')) {
    region.hidden = region.dataset.dashboardView !== section;
  }
  const sections = [
    ['access', showAccess, 'Управление доступом'],
    ['analytics', showAnalytics, 'Аналитика'],
    ['catalog', showCatalog, 'Каталог баз'],
    ['field-labels', showFieldLabels, 'Поля поиска'],
  ];
  for (const [name, button, title] of sections) {
    button.setAttribute('aria-pressed', String(section === name));
    if (section === name) pageTitle.textContent = title;
  }
  if (section !== 'catalog') catalogListRequest?.abort();
  if (section !== 'field-labels') fieldLabelRequest?.abort();
  if (section !== 'analytics') analyticsRequest?.abort();
}

function resetFieldLabelEditor() {
  fieldLabelDraft = undefined;
  fieldLabelForm.reset();
  setPending(fieldLabelForm, false);
  byId('field-label-edit-key').textContent = '';
  message(fieldLabelEditMessage);
}

function resetFieldLabels() {
  fieldLabelRequest?.abort();
  fieldLabelQuery = '';
  fieldLabelPage = 1;
  fieldLabelLastPage = 1;
  fieldLabelSearch.value = '';
  fieldLabelRows.replaceChildren();
  fieldLabelTable.hidden = true;
  fieldLabelPagination.hidden = true;
  byId('field-label-count').textContent = '';
  message(fieldLabelNotice);
  message(fieldLabelMessage);
  if (fieldLabelDialog.open) fieldLabelDialog.close();
  resetFieldLabelEditor();
}

function fieldLabelRow(row) {
  const tr = element('tr');
  const title = element('td');
  title.append(element('strong', row.label));
  const key = element('td');
  key.append(element('code', row.field_key, 'catalog-table-name'));
  const edit = element('button', 'Изменить', 'button');
  edit.type = 'button';
  edit.dataset.fieldKey = row.field_key;
  edit.setAttribute('aria-label', 'Изменить подпись поля «' + row.field_key + '»');
  edit.addEventListener('click', () => {
    resetFieldLabelEditor();
    fieldLabelDraft = row;
    byId('field-label-edit-key').textContent = row.field_key;
    fieldLabelValue.value = row.label;
    fieldLabelDialog.showModal();
    fieldLabelValue.focus();
  });
  const action = element('td');
  action.append(edit);
  tr.append(title, key, action);
  return tr;
}

async function loadFieldLabels(page = fieldLabelPage, savedKey) {
  fieldLabelRequest?.abort();
  const controller = new AbortController();
  fieldLabelRequest = controller;
  const focused = document.activeElement;
  const paging = focused === fieldLabelPrev || focused === fieldLabelNext;
  fieldLabelTable.hidden = true;
  fieldLabelPagination.hidden = true;
  fieldLabelRows.replaceChildren();
  message(fieldLabelMessage, 'Загружаем поля…');
  const params = new URLSearchParams({ page: String(page) });
  if (fieldLabelQuery) params.set('q', fieldLabelQuery);
  try {
    const { rows, total, page: current, pageSize } = await authenticatedRequest(
      '/api/field-labels?' + params, { signal: controller.signal },
    );
    if (controller.signal.aborted || session.signal.aborted) return;
    fieldLabelLastPage = Math.max(1, Math.ceil(total / pageSize));
    if (current > fieldLabelLastPage) {
      void loadFieldLabels(fieldLabelLastPage, savedKey);
      return;
    }
    fieldLabelPage = current;
    if (!rows.length) {
      message(fieldLabelMessage, fieldLabelQuery ? 'По этому запросу поля не найдены.' : 'Подписей полей пока нет.');
      if (document.activeElement === document.body && (savedKey || paging)) fieldLabelSearch.focus();
      return;
    }
    const offset = (current - 1) * pageSize;
    byId('field-label-count').textContent =
      `${numberFormat.format(offset + 1)}–${numberFormat.format(offset + rows.length)} из ${numberFormat.format(total)}`;
    fieldLabelRows.replaceChildren(...rows.map(fieldLabelRow));
    fieldLabelPrev.disabled = current === 1;
    fieldLabelNext.disabled = current >= fieldLabelLastPage;
    fieldLabelTable.scrollTop = 0;
    fieldLabelTable.hidden = false;
    fieldLabelPagination.hidden = false;
    message(fieldLabelMessage);
    if (document.activeElement === document.body) {
      if (savedKey) {
        const edit = [...fieldLabelRows.querySelectorAll('button')].find(button => button.dataset.fieldKey === savedKey);
        (edit || fieldLabelSearch).focus();
      } else if (paging) fieldLabelTable.focus({ preventScroll: true });
    }
  } catch (error) {
    if (!controller.signal.aborted && !session.signal.aborted) {
      message(fieldLabelMessage, error.message, true);
      if (document.activeElement === document.body && (savedKey || paging)) fieldLabelSearch.focus();
    }
  }
}

function resetCatalogEditor() {
  catalogEditRequest?.abort();
  catalogDraft = undefined;
  catalogEditForm.reset();
  setPending(catalogEditForm, false);
  catalogEditFields.hidden = true;
  catalogImportFields.hidden = true;
  catalogImportBack.hidden = true;
  catalogImportSelection.textContent = '';
  byId('catalog-field-name').required = false;
  catalogEditSave.hidden = true;
  byId('catalog-edit-id').textContent = '';
  byId('catalog-edit-table').textContent = '';
  message(catalogEditMessage);
}

function resetCatalogTypeForm() {
  catalogTypeForm.reset();
  setPending(catalogTypeForm, false);
  message(catalogTypesMessage);
}

function resetCatalog() {
  catalogListRequest?.abort();
  catalogQuery = '';
  catalogPage = 1;
  catalogLastPage = 1;
  catalogSearch.value = '';
  catalogRows.replaceChildren();
  catalogTable.hidden = true;
  catalogPagination.hidden = true;
  byId('catalog-count').textContent = '';
  message(catalogNotice);
  message(catalogMessage);
  if (catalogEditDialog.open) catalogEditDialog.close();
  resetCatalogEditor();
  if (catalogTypesDialog.open) catalogTypesDialog.close();
  resetCatalogTypeForm();
}

function catalogTableRow(row) {
  const tr = element('tr');
  const title = element('td');
  title.append(element('strong', row.name || '—'), element('span', row.name_table, 'catalog-table-name'));
  const edit = element('button', 'Изменить', 'button');
  edit.type = 'button';
  edit.dataset.catalogId = row.id;
  edit.setAttribute('aria-label', 'Изменить базу «' + (row.name || row.name_table) + '»');
  edit.addEventListener('click', () => void openCatalogEditor(String(row.id)));
  const action = element('td');
  action.append(edit);
  tr.append(element('td', row.id, 'catalog-id'), title,
    element('td', row.country || '—', 'catalog-extra'), element('td', row.type || '—', 'catalog-extra'), action);
  return tr;
}

async function loadCatalog(page = catalogPage) {
  catalogListRequest?.abort();
  const controller = new AbortController();
  catalogListRequest = controller;
  const focused = document.activeElement;
  const focusedId = focused?.dataset.catalogId;
  const wasPaging = focused === catalogPrev || focused === catalogNext;
  catalogTable.hidden = true;
  catalogPagination.hidden = true;
  catalogRows.replaceChildren();
  message(catalogMessage, 'Загружаем каталог…');
  const params = new URLSearchParams({ page: String(page) });
  if (catalogQuery) params.set('q', catalogQuery);
  try {
    const result = await authenticatedRequest('/api/catalog?' + params, { signal: controller.signal });
    if (controller.signal.aborted || session.signal.aborted) return;
    const { rows, total, page: current, pageSize } = result;
    catalogLastPage = Math.max(1, Math.ceil(total / pageSize));
    if (current > catalogLastPage) {
      void loadCatalog(catalogLastPage);
      return;
    }
    catalogPage = current;
    if (!rows.length) {
      message(catalogMessage, catalogQuery ? 'По этому запросу базы не найдены.' : 'В каталоге пока нет баз.');
      return;
    }
    const offset = (catalogPage - 1) * pageSize;
    catalogRows.replaceChildren(...rows.map(catalogTableRow));
    byId('catalog-count').textContent = `${numberFormat.format(offset + 1)}–${numberFormat.format(offset + rows.length)} из ${numberFormat.format(total)}`;
    catalogPrev.disabled = catalogPage === 1;
    catalogNext.disabled = catalogPage >= catalogLastPage;
    catalogTable.scrollTop = 0;
    catalogTable.hidden = false;
    catalogPagination.hidden = false;
    message(catalogMessage);
    if (document.activeElement === document.body) {
      if (focusedId) {
        const rowButton = [...catalogRows.querySelectorAll('button')].find((button) => button.dataset.catalogId === focusedId);
        (rowButton || catalogSearch).focus({ preventScroll: true });
      } else if (wasPaging) {
        catalogTable.focus({ preventScroll: true });
      }
    }
  } catch (error) {
    if (!controller.signal.aborted && !session.signal.aborted) message(catalogMessage, error.message, true);
  }
}

function renderCatalogTypeOptions(types, current) {
  const emptyOption = element('option', 'Не указан');
  emptyOption.value = '';
  const options = types.map((type) => {
    const option = element('option', type);
    option.value = type;
    return option;
  });
  if (current && !types.includes(current)) {
    const currentOption = element('option', current + ' (нет в списке)');
    currentOption.value = current;
    currentOption.disabled = true;
    options.unshift(currentOption);
  }
  catalogTypeSelect.replaceChildren(emptyOption, ...options);
}

async function openCatalogEditor(id) {
  resetCatalogEditor();
  const create = id === undefined;
  byId('catalog-edit-identity').hidden = create;
  byId('catalog-create-access').hidden = !create;
  byId('catalog-field-name').required = create;
  catalogEditTitle.textContent = create ? 'Добавить базу · 1 из 2' : 'Редактировать базу';
  catalogEditSave.textContent = create ? 'Далее' : 'Сохранить';
  const controller = new AbortController();
  catalogEditRequest = controller;
  message(catalogEditMessage, 'Загружаем метаданные…');
  catalogEditDialog.showModal();
  catalogEditCancel.focus();
  try {
    const options = { signal: controller.signal };
    const [{ row }, { types }] = await Promise.all([
      create ? { row: {} } : authenticatedRequest('/api/catalog/' + encodeURIComponent(id), options),
      authenticatedRequest('/api/catalog/types', options),
    ]);
    if (controller.signal.aborted || !catalogEditDialog.open) return;
    byId('catalog-edit-id').textContent = row.id ?? '';
    byId('catalog-edit-table').textContent = row.name_table ?? '';
    renderCatalogTypeOptions(types, row.type);
    const values = {};
    for (const field of catalogFields) {
      const input = catalogEditForm.elements.namedItem(field);
      input.value = row[field] ?? '';
      values[field] = input.value;
    }
    catalogDraft = { id, values, create };
    catalogEditFields.hidden = false;
    catalogEditSave.hidden = false;
    message(catalogEditMessage);
    byId('catalog-field-name').focus();
  } catch (error) {
    if (!controller.signal.aborted && catalogEditDialog.open) message(catalogEditMessage, error.message, true);
  }
}

showAccess.addEventListener('click', () => {
  if (showAccess.getAttribute('aria-pressed') === 'true') return;
  showDashboardSection('access');
  pageTitle.focus();
});
showAnalytics.addEventListener('click', () => {
  if (!analyticsView.hidden) return;
  showDashboardSection('analytics');
  pageTitle.focus();
  void refreshAnalytics();
});
showCatalog.addEventListener('click', () => {
  if (!catalogView.hidden) return;
  showDashboardSection('catalog');
  pageTitle.focus();
  void loadCatalog();
});
showFieldLabels.addEventListener('click', () => {
  if (!fieldLabelsView.hidden) return;
  showDashboardSection('field-labels');
  pageTitle.focus();
  void loadFieldLabels();
});
byId('field-label-search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = fieldLabelSearch.value.trim();
  if ([...query].length > 255) {
    message(fieldLabelNotice, 'Сократите запрос до 255 символов.', true);
    fieldLabelSearch.focus();
    return;
  }
  message(fieldLabelNotice);
  fieldLabelQuery = query;
  void loadFieldLabels(1);
});
fieldLabelPrev.addEventListener('click', () => {
  if (fieldLabelPage > 1) void loadFieldLabels(fieldLabelPage - 1);
});
fieldLabelNext.addEventListener('click', () => {
  if (fieldLabelPage < fieldLabelLastPage) void loadFieldLabels(fieldLabelPage + 1);
});
byId('field-label-cancel').addEventListener('click', () => fieldLabelDialog.close());
fieldLabelDialog.addEventListener('cancel', (event) => {
  if (fieldLabelForm.dataset.pending === 'true') event.preventDefault();
});
fieldLabelDialog.addEventListener('close', () => {
  if (!fieldLabelDialog.open) resetFieldLabelEditor();
});
fieldLabelForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!fieldLabelDraft || fieldLabelForm.dataset.pending === 'true') return;
  const label = fieldLabelValue.value.trim();
  if (!label || [...label].length > 255) {
    message(fieldLabelEditMessage, 'Введите подпись длиной от 1 до 255 символов.', true);
    fieldLabelValue.focus();
    return;
  }
  const { field_key: key, label: current } = fieldLabelDraft;
  if (label === current) {
    message(fieldLabelEditMessage, 'Изменений нет.');
    return;
  }
  const { signal } = session;
  message(fieldLabelEditMessage);
  setPending(fieldLabelForm, true);
  try {
    await authenticatedRequest('/api/field-labels/' + encodeURIComponent(key), { method: 'POST', data: { label } });
    if (signal.aborted) return;
    fieldLabelDialog.close();
    message(fieldLabelNotice, 'Подпись сохранена.');
    void loadFieldLabels(fieldLabelPage, key);
  } catch (error) {
    if (!signal.aborted) message(fieldLabelEditMessage, error.message, true);
  } finally {
    if (!signal.aborted) {
      setPending(fieldLabelForm, false);
      if (fieldLabelDialog.open) fieldLabelValue.focus();
    }
  }
});
byId('catalog-search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = catalogSearch.value.trim();
  if ([...query].length > 255) {
    message(catalogMessage, 'Сократите запрос до 255 символов.', true);
    return;
  }
  message(catalogNotice);
  catalogQuery = query;
  void loadCatalog(1);
});
catalogPrev.addEventListener('click', () => {
  if (catalogPage > 1) void loadCatalog(catalogPage - 1);
});
catalogNext.addEventListener('click', () => {
  if (catalogPage < catalogLastPage) void loadCatalog(catalogPage + 1);
});

byId('catalog-types-open').addEventListener('click', () => {
  resetCatalogTypeForm();
  message(catalogNotice);
  catalogTypesDialog.showModal();
  catalogTypeName.focus();
});
byId('catalog-types-cancel').addEventListener('click', () => catalogTypesDialog.close());
catalogTypesDialog.addEventListener('cancel', (event) => {
  if (catalogTypeForm.dataset.pending === 'true') event.preventDefault();
});
catalogTypesDialog.addEventListener('close', () => {
  if (!catalogTypesDialog.open) resetCatalogTypeForm();
});
catalogTypeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (catalogTypeForm.dataset.pending === 'true') return;
  const name = catalogTypeName.value.trim();
  if (!name) {
    message(catalogTypesMessage, 'Введите название типа.', true);
    catalogTypeName.focus();
    return;
  }
  const { signal } = session;
  message(catalogTypesMessage);
  setPending(catalogTypeForm, true);
  try {
    const { type } = await authenticatedRequest('/api/catalog/types', { method: 'POST', data: { name } });
    if (signal.aborted) return;
    catalogTypesDialog.close();
    message(catalogNotice, 'Тип «' + type + '» добавлен.');
  } catch (error) {
    if (!signal.aborted) message(catalogTypesMessage, error.message, true);
  } finally {
    if (!signal.aborted) {
      setPending(catalogTypeForm, false);
      if (catalogTypesDialog.open) catalogTypeName.focus();
    }
  }
});

function showCatalogImportStep(chooseFolder) {
  catalogEditTitle.textContent = chooseFolder ? 'Добавить базу · 2 из 2' : 'Добавить базу · 1 из 2';
  catalogEditFields.hidden = chooseFolder;
  catalogImportFields.hidden = !chooseFolder;
  catalogImportBack.hidden = !chooseFolder;
  catalogEditSave.textContent = chooseFolder ? 'Добавить базу' : 'Далее';
  message(catalogEditMessage);
  (chooseFolder ? catalogImportFolder : byId('catalog-field-name')).focus();
}

function selectedJsonFiles() {
  return Array.from(catalogImportFolder.files).filter(file => /\.json$/i.test(file.name));
}

catalogImportFolder.addEventListener('change', () => {
  if (catalogDraft) catalogDraft.importId = undefined;
  message(catalogEditMessage);
  const count = selectedJsonFiles().length;
  catalogImportSelection.textContent = count ? 'Выбрано файлов JSON: ' + numberFormat.format(count) : '';
  if (catalogImportFolder.files.length && !count) {
    message(catalogEditMessage, 'В выбранной папке нет файлов .json.', true);
  }
});

async function importCatalog(metadata) {
  const files = selectedJsonFiles();
  if (!files.length) {
    message(catalogEditMessage, 'Выберите папку хотя бы с одним файлом .json.', true);
    catalogImportFolder.focus();
    return;
  }
  const manifest = { metadata, files: files.map(({ name, size }) => ({ name, size })) };
  const payload = new Blob([JSON.stringify(manifest) + '\n', ...files], { type: 'application/octet-stream' });
  const { signal } = session;
  message(catalogEditMessage, 'Загружаем файлы и добавляем базу…');
  setPending(catalogEditForm, true);
  try {
    catalogDraft.importId ??= crypto.randomUUID();
    const result = await authenticatedRequest('/api/catalog/import', { method: 'POST', data: payload, importId: catalogDraft.importId });
    if (signal.aborted) return;
    const { row, rows, files: fileCount, newFields } = result;
    catalogEditDialog.close();
    catalogSearch.value = catalogQuery = row.name_table;
    message(catalogNotice, 'База «' + metadata.name + '» добавлена. Таблица ' + row.name_table + ' (№' + row.id
      + '). Файлов: ' + numberFormat.format(fileCount) + ', записей: ' + numberFormat.format(rows)
      + ', новых полей: ' + numberFormat.format(newFields) + '. Для поиска по базе запустите индексацию.');
    void loadCatalog(1);
  } catch (error) {
    if (!signal.aborted) message(catalogEditMessage, error.message, true);
  } finally {
    if (!signal.aborted) {
      setPending(catalogEditForm, false);
      if (catalogEditDialog.open) catalogEditSave.focus();
    }
  }
}

byId('catalog-create-open').addEventListener('click', () => void openCatalogEditor());
catalogImportBack.addEventListener('click', () => showCatalogImportStep(false));
catalogEditCancel.addEventListener('click', () => catalogEditDialog.close());
catalogEditDialog.addEventListener('cancel', (event) => {
  if (catalogEditForm.dataset.pending === 'true') event.preventDefault();
});
catalogEditDialog.addEventListener('close', () => {
  if (!catalogEditDialog.open) resetCatalogEditor();
});
catalogEditForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!catalogDraft || catalogEditForm.dataset.pending === 'true') return;
  if (catalogDraft.create && !catalogImportFields.hidden) {
    await importCatalog(catalogDraft.metadata);
    return;
  }
  const changes = {};
  const fields = catalogDraft.create ? [...catalogFields, 'access_level'] : catalogFields;
  for (const field of fields) {
    const input = catalogEditForm.elements.namedItem(field);
    const value = catalogDraft.create ? input.value.trim() : input.value;
    if (catalogDraft.create && field === 'name' && !value) {
      message(catalogEditMessage, 'Введите название базы.', true);
      input.focus();
      return;
    }
    if (catalogDraft.create ? !value : value === catalogDraft.values[field]) continue;
    const tooLong = field === 'info' ? new TextEncoder().encode(value).length > 65_535 : [...value].length > 255;
    if (tooLong) {
      message(catalogEditMessage, field === 'info' ? 'Описание должно занимать не более 65 535 байт.' : 'Сократите значение поля до 255 символов.', true);
      input.focus();
      return;
    }
    changes[field] = value === '' ? null : value;
  }
  if (catalogDraft.create) {
    if (JSON.stringify(changes) !== JSON.stringify(catalogDraft.metadata)) catalogDraft.importId = undefined;
    catalogDraft.metadata = changes;
    showCatalogImportStep(true);
    return;
  }
  if (!Object.keys(changes).length) {
    message(catalogEditMessage, 'Изменений нет.');
    return;
  }
  const { id } = catalogDraft;
  const { signal } = session;
  message(catalogEditMessage);
  setPending(catalogEditForm, true);
  try {
    await authenticatedRequest('/api/catalog/' + encodeURIComponent(id), { method: 'POST', data: { changes } });
    if (signal.aborted) return;
    catalogEditDialog.close();
    message(catalogNotice, 'Изменения базы №' + id + ' сохранены.');
    void loadCatalog();
  } catch (error) {
    if (!signal.aborted) message(catalogEditMessage, error.message, true);
  } finally {
    if (!signal.aborted) setPending(catalogEditForm, false);
  }
});

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
    if (!session.signal.aborted) {
      const activeNotice = !analyticsView.hidden ? analyticsMessage
        : !fieldLabelsView.hidden ? fieldLabelNotice : !catalogView.hidden ? catalogNotice : notice;
      message(activeNotice, error.message, true);
    }
  } finally { logout.disabled = false; }
});

function refreshDashboard(preferredId, { revealKey = false } = {}) {
  void refreshKeys(preferredId, revealKey);
}

refresh.addEventListener('click', () => { message(notice); refreshDashboard(); });
keySearch.addEventListener('input', () => { if (!keyRequest || !refresh.disabled || keys.length) renderKeys(); });
keyStatusFilter.addEventListener('change', () => { if (!keyRequest || !refresh.disabled || keys.length) renderKeys(); });
analyticsDays.addEventListener('change', () => void refreshAnalytics());
analyticsOwner.addEventListener('change', () => void refreshAnalytics());
analyticsResult.addEventListener('change', () => void refreshAnalytics());
analyticsSort.addEventListener('change', renderAnalyticsOperations);
byId('analytics-refresh').addEventListener('click', () => {
  void refreshKeys();
  void refreshAnalytics();
});
analyticsExport.addEventListener('click', downloadAnalytics);
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
    refreshDashboard(String(issued.id), { revealKey: true });
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
    renderOwnerOptions();
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
