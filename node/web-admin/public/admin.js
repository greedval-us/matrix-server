'use strict';

const byId = (id) => document.getElementById(id);
const checking = byId('checking');
const login = byId('login');
const dashboard = byId('dashboard');
const pageTitle = byId('page-title');
const showAccess = byId('show-access');
const showCatalog = byId('show-catalog');
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
const analyticsContent = byId('analytics-content');
const analyticsMessage = byId('analytics-message');

const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
const dayFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
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
let catalogListRequest;
let catalogEditRequest;
let catalogQuery = '';
let catalogPage = 1;
let catalogLastPage = 1;
let catalogDraft;
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
  keys = [];
  selectedId = '';
  keyList.replaceChildren();
  logRows.replaceChildren();
  byId('daily-rows').replaceChildren();
  byId('top-keys').replaceChildren();
  logFilters.reset();
  analyticsDays.value = '7';
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
    if (renderOwnerOptions()) void refreshAnalytics();
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

function renderAnalytics({ totals, daily, topKeys }) {
  byId('metric-requests').textContent = numberFormat.format(totals.requests);
  byId('metric-errors').textContent = numberFormat.format(totals.errors);
  byId('metric-active').textContent = numberFormat.format(totals.activeKeys);
  byId('metric-duration').textContent = totals.requests ? numberFormat.format(totals.averageMs) + ' мс' : '—';

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
  const params = new URLSearchParams({ days: analyticsDays.value });
  if (analyticsOwner.value) params.set('owner', analyticsOwner.value);
  try {
    const stats = await authenticatedRequest('/api/analytics?' + params, { signal: controller.signal });
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
  for (const control of form.querySelectorAll('button, input, select, textarea')) control.disabled = pending;
}

function showDashboardSection(section) {
  const catalog = section === 'catalog';
  for (const region of dashboard.querySelectorAll('[data-dashboard-view]')) {
    region.hidden = region.dataset.dashboardView !== section;
  }
  showAccess.setAttribute('aria-pressed', String(!catalog));
  showCatalog.setAttribute('aria-pressed', String(catalog));
  pageTitle.textContent = catalog ? 'Каталог баз' : 'Управление доступом';
  if (!catalog) catalogListRequest?.abort();
}

function resetCatalogEditor() {
  catalogEditRequest?.abort();
  catalogDraft = undefined;
  catalogEditForm.reset();
  setPending(catalogEditForm, false);
  catalogEditFields.hidden = true;
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
  const controller = new AbortController();
  catalogEditRequest = controller;
  message(catalogEditMessage, 'Загружаем метаданные…');
  catalogEditDialog.showModal();
  catalogEditCancel.focus();
  try {
    const options = { signal: controller.signal };
    const [{ row }, { types }] = await Promise.all([
      authenticatedRequest('/api/catalog/' + encodeURIComponent(id), options),
      authenticatedRequest('/api/catalog/types', options),
    ]);
    if (controller.signal.aborted || !catalogEditDialog.open) return;
    byId('catalog-edit-id').textContent = row.id;
    byId('catalog-edit-table').textContent = row.name_table;
    renderCatalogTypeOptions(types, row.type);
    const values = {};
    for (const field of catalogFields) {
      const input = catalogEditForm.elements.namedItem(field);
      input.value = row[field] ?? '';
      values[field] = input.value;
    }
    catalogDraft = { id, values };
    catalogEditFields.hidden = false;
    catalogEditSave.hidden = false;
    message(catalogEditMessage);
    byId('catalog-field-name').focus();
  } catch (error) {
    if (!controller.signal.aborted && catalogEditDialog.open) message(catalogEditMessage, error.message, true);
  }
}

showAccess.addEventListener('click', () => {
  if (catalogView.hidden) return;
  showDashboardSection('access');
  pageTitle.focus();
});
showCatalog.addEventListener('click', () => {
  if (!catalogView.hidden) return;
  showDashboardSection('catalog');
  pageTitle.focus();
  void loadCatalog();
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
  const changes = {};
  for (const field of catalogFields) {
    const input = catalogEditForm.elements.namedItem(field);
    const value = input.value;
    if (value === catalogDraft.values[field]) continue;
    const tooLong = field === 'info' ? new TextEncoder().encode(value).length > 65_535 : [...value].length > 255;
    if (tooLong) {
      message(catalogEditMessage, field === 'info' ? 'Описание должно занимать не более 65 535 байт.' : 'Сократите значение поля до 255 символов.', true);
      input.focus();
      return;
    }
    changes[field] = value === '' ? null : value;
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
    if (!session.signal.aborted) message(catalogView.hidden ? notice : catalogNotice, error.message, true);
  } finally { logout.disabled = false; }
});

function refreshDashboard(preferredId, { revealKey = false } = {}) {
  void refreshKeys(preferredId, revealKey);
  void refreshAnalytics();
}

refresh.addEventListener('click', () => { message(notice); refreshDashboard(); });
keySearch.addEventListener('input', () => { if (!keyRequest || !refresh.disabled || keys.length) renderKeys(); });
keyStatusFilter.addEventListener('change', () => { if (!keyRequest || !refresh.disabled || keys.length) renderKeys(); });
analyticsDays.addEventListener('change', () => void refreshAnalytics());
analyticsOwner.addEventListener('change', () => void refreshAnalytics());
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
