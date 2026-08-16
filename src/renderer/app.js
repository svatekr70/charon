'use strict';

/* ------------------------------------------------------------------ stav */

/** Výchozí stav jednoho panelu. */
function newPane(showHidden) {
  return {
    path: '', entries: [], view: [], sel: new Set(), cursor: -1,
    sort: { key: 'name', dir: 1 },
    showHidden,
    filterText: '',
    filter: null,          // zkompilovaná maska, null = bez filtru
    history: [],           // navštívené cesty
    hIndex: -1,            // pozice v historii
    sizes: new Map(),      // dopočítané velikosti složek
  };
}

/** Stav jedné záložky. Lokální panel má každá svůj, jako ve WinSCP. */
function newSession(info) {
  return {
    id: info ? info.id : null,
    info: info || null,
    local: newPane(false),
    remote: newPane(true),
    queue: { items: [], pending: 0, totalBytes: 0, doneBytes: 0, paused: false, active: 0 },
    trash: { enabled: false, path: '' },
    watch: { running: false },
    editing: [],
  };
}

const state = {
  sites: [],
  /** id záložky → stav */
  sessions: new Map(),
  order: [],
  activeId: null,
  /** Než je otevřená první záložka, prochází se aspoň lokální strana. */
  placeholder: newSession(null),
  activeSide: 'local',
  settings: {},
  importData: null,
  syncActions: [],
};

/** Záložka vpředu, nebo náhradní stav, když žádná není. */
function active() {
  return (state.activeId && state.sessions.get(state.activeId)) || state.placeholder;
}

/** Id pro volání do hlavního procesu; null znamená „nejsme připojeni". */
function sid() {
  return state.activeId;
}

// Zbytek kódu pracuje se `state.local`, `state.remote` a spol. jako dřív;
// tyhle vlastnosti jen ukazují do právě aktivní záložky.
for (const key of ['local', 'remote', 'queue', 'trash', 'watch', 'editing']) {
  Object.defineProperty(state, key, {
    get() { return active()[key]; },
    set(v) { active()[key] = v; },
  });
}

Object.defineProperty(state, 'connected', {
  get() {
    const s = active();
    return Boolean(s.info && s.info.status === 'connected');
  },
});

/** Výchozí nastavení; hlavní proces posílá jen to, co je uložené. */
const DEFAULT_SETTINGS = {
  editor: '', doubleClick: 'edit', typeAhead: true, colOwner: false, colGroup: false,
  transferMask: '', maxConcurrent: 3, speedLimitKb: 0, commands: [], workspaces: [],
  collapsedFolders: [],
  cacheListings: true,
  theme: 'system',
  uploadPerms: 'keep', uploadFileMode: '644', uploadDirMode: '755',
  tempName: true, tempNameMinKb: 0,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const panes = { local: $('#pane-local'), remote: $('#pane-remote') };

/* -------------------------------------------------------------- pomocné */

/** Rozbalí {ok,data} z IPC; při chybě zapíše do stavového řádku a vrátí null. */
async function call(promise, { silent = false } = {}) {
  const res = await promise;
  if (res && res.ok) return res.data;
  if (!silent) setLog('error', res ? res.error : 'Neznámá chyba');
  return null;
}

function setLog(level, text) {
  const el = $('#log-line');
  el.textContent = text;
  el.className = `log-${level}`;
  if (level === 'ok') setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 6000);
}

function fmtSize(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtPerm(mode) {
  if (mode === null || mode === undefined) return '';
  return mode.toString(8).padStart(3, '0');
}

function fmtSpeed(bps) {
  return bps > 0 ? `${fmtSize(bps)}/s` : '';
}

/**
 * Zbývající čas.
 *
 * Zaokrouhluje se hrubě a čím delší čas, tím hruběji — u půlhodinového přenosu
 * nikoho nezajímají vteřiny a přesná čísla by jen poskakovala.
 */
function fmtEta(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '';
  if (sec < 10) return 'pár vteřin';
  if (sec < 60) return `${Math.round(sec / 5) * 5} s`;
  if (sec < 600) {
    const m = Math.floor(sec / 60);
    const r = Math.round((sec % 60) / 10) * 10;
    return r && r < 60 ? `${m} min ${r} s` : `${m + (r >= 60 ? 1 : 0)} min`;
  }
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** České skloňování podle počtu: 1 soubor, 2–4 soubory, 0 a 5+ souborů. */
function plural(n, one, few, many) {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}

const posixJoin = (dir, name) => (dir === '/' ? `/${name}` : `${dir.replace(/\/$/, '')}/${name}`);
const posixParent = (p) => {
  const n = p.replace(/\/+$/, '');
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
};
const localJoin = (dir, name) => `${dir.replace(/\/$/, '')}/${name}`;
const localParent = (p) => posixParent(p);

/* ------------------------------------------------------- načítání panelů */

/**
 * @param {boolean} [opts.fromHistory] navigace tlačítky zpět/vpřed —
 *   nesmí do historie přidávat další záznam, jinak by se z ní nedalo vyjít
 */
async function loadPane(side, targetPath, { fromHistory = false, refresh = false } = {}) {
  const data = await call(side === 'local'
    ? window.api.local.list(targetPath)
    : window.api.remote.list(sid(), targetPath, refresh));
  if (!data) return;
  const st = state[side];

  if (!fromHistory && data.path !== st.path) {
    // Odbočka z prostředka historie zahodí to, co bylo vpřed.
    st.history = st.history.slice(0, st.hIndex + 1);
    st.history.push(data.path);
    if (st.history.length > 100) st.history.shift();
    st.hIndex = st.history.length - 1;
  }

  st.path = data.path;
  st.entries = data.entries;
  st.sel.clear();
  st.cursor = -1;
  st.sizes.clear(); // jiná složka, staré součty už neplatí
  $('[data-role=path]', panes[side]).value = data.path;
  updateHistoryButtons(side);
  renderPane(side);
}

function updateHistoryButtons(side) {
  const st = state[side];
  $('[data-act=back]', panes[side]).disabled = st.hIndex <= 0;
  $('[data-act=fwd]', panes[side]).disabled = st.hIndex >= st.history.length - 1;
}

async function goHistory(side, delta) {
  const st = state[side];
  const target = st.hIndex + delta;
  if (target < 0 || target >= st.history.length) return;
  st.hIndex = target;
  await loadPane(side, st.history[target], { fromHistory: true });
}

/** Skryté soubory poznáme podle tečky na začátku — lokálně i na serveru. */
function isHidden(entry) {
  return entry.hidden !== undefined ? entry.hidden : entry.name.startsWith('.');
}

function sortedEntries(side) {
  const st = state[side];
  const { key, dir } = st.sort;

  const list = st.entries.filter((e) => {
    if (!st.showHidden && isHidden(e)) return false;
    // Filtr nikdy neschovává složky — jinak by se nedalo doklikat níž.
    if (st.filter && e.type !== 'd' && !st.filter.match(e.name, false)) return false;
    return true;
  });

  return list.sort((a, b) => {
    // Adresáře vždy nahoře, jako ve WinSCP.
    if ((a.type === 'd') !== (b.type === 'd')) return a.type === 'd' ? -1 : 1;
    let r = 0;
    if (key === 'size') r = (sizeOf(side, a) || 0) - (sizeOf(side, b) || 0);
    else if (key === 'date') r = (a.mtime || 0) - (b.mtime || 0);
    else if (key === 'perm') r = (a.mode || 0) - (b.mode || 0);
    else if (key === 'owner') r = String(a.owner ?? '').localeCompare(String(b.owner ?? ''), 'cs', { numeric: true });
    else if (key === 'group') r = String(a.group ?? '').localeCompare(String(b.group ?? ''), 'cs', { numeric: true });
    else r = a.name.localeCompare(b.name, 'cs', { numeric: true });
    return r * dir;
  });
}

/** Velikost položky — u složek ta dopočítaná, když si ji uživatel vyžádal. */
function sizeOf(side, entry) {
  if (entry.type !== 'd') return entry.size;
  const computed = state[side].sizes.get(entry.name);
  return computed === undefined ? null : computed;
}

function renderPane(side) {
  const st = state[side];
  const listEl = $('[data-role=list]', panes[side]);
  const rows = sortedEntries(side);
  st.view = rows;

  const frag = document.createDocumentFragment();

  if (st.path && st.path !== '/') {
    const up = document.createElement('div');
    up.className = 'row dir';
    up.dataset.up = '1';
    up.innerHTML = '<span class="name">..</span><span class="size"></span><span class="date"></span><span class="perm"></span>';
    frag.appendChild(up);
  }

  rows.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = `row ${e.type === 'd' ? 'dir' : e.type === 'l' ? 'link' : ''}${isHidden(e) ? ' hidden-file' : ''}`;
    row.dataset.index = String(i);
    // Ikonu vybírá styl podle škatulky; tu určuje sdílený modul, aby se
    // panel a dialog vlastností nikdy nerozcházely v tom, co je co.
    row.dataset.kind = window.FileKind.of(e.name, e.type).kind;
    row.draggable = true;
    if (st.sel.has(e.name)) row.classList.add('sel');

    const computed = e.type === 'd' && st.sizes.has(e.name);
    const size = computed ? fmtSize(st.sizes.get(e.name)) : (e.type === 'd' ? '' : fmtSize(e.size));

    row.innerHTML = `<span class="name"></span><span class="size${computed ? ' computed' : ''}">${size}</span>`
      + `<span class="date">${fmtDate(e.mtime)}</span><span class="perm">${fmtPerm(e.mode)}</span>`
      + '<span class="owner"></span><span class="group"></span>';
    // textContent kvůli názvům, které mohou obsahovat < a >
    row.children[0].textContent = e.name;
    row.children[4].textContent = e.owner ?? '';
    row.children[5].textContent = e.group ?? '';
    frag.appendChild(row);
  });

  listEl.replaceChildren(frag);
  updateSortIndicator(side);
  updateFoot(side);
}

/**
 * Přebarví výběr, aniž by se seznam postavil znovu.
 *
 * Znovupostavení by vypadalo stejně, ale rozbíjí dvojklik: druhé kliknutí by
 * dopadlo na nově vyrobený řádek, a prohlížeč pak pošle `dblclick` až
 * společnému rodiči — tedy seznamu, kde už žádný řádek není.
 */
function paintSelection(side) {
  const st = state[side];
  const listEl = $('[data-role=list]', panes[side]);
  for (const row of listEl.children) {
    if (row.dataset.up) continue;
    const entry = st.view[Number(row.dataset.index)];
    row.classList.toggle('sel', Boolean(entry) && st.sel.has(entry.name));
  }
  updateFoot(side);
}

function updateSortIndicator(side) {
  const { key, dir } = state[side].sort;
  $$('[data-sort]', $('[data-role=head]', panes[side])).forEach((el) => {
    el.classList.toggle('sorted', el.dataset.sort === key);
    el.classList.toggle('desc', el.dataset.sort === key && dir === -1);
  });
}

function updateFoot(side) {
  const st = state[side];
  const files = st.view ? st.view.filter((e) => e.type !== 'd') : [];
  const selBytes = (st.view || []).filter((e) => st.sel.has(e.name)).reduce((a, e) => a + (e.size || 0), 0);
  const total = files.reduce((a, e) => a + (e.size || 0), 0);
  const dirs = (st.view || []).filter((e) => e.type === 'd').length;
  const hiddenByFilter = st.filter ? st.entries.length - st.view.length : 0;
  $('[data-role=foot]', panes[side]).textContent = st.sel.size
    ? `Vybráno ${st.sel.size} ${plural(st.sel.size, 'položka', 'položky', 'položek')}, ${fmtSize(selBytes)}`
    : `${files.length} ${plural(files.length, 'soubor', 'soubory', 'souborů')} (${fmtSize(total)}), `
      + `${dirs} ${plural(dirs, 'složka', 'složky', 'složek')}`
      + (hiddenByFilter > 0 ? ` · filtr skrývá ${hiddenByFilter}` : '');
}

/* ------------------------------------------------------------ interakce */

function entryAt(side, index) {
  return state[side].view ? state[side].view[index] : null;
}

function fullPath(side, entry) {
  return side === 'local' ? localJoin(state[side].path, entry.name) : posixJoin(state[side].path, entry.name);
}

function selectedEntries(side) {
  const st = state[side];
  return (st.view || []).filter((e) => st.sel.has(e.name));
}

function setActive(side) {
  state.activeSide = side;
  panes.local.classList.toggle('active', side === 'local');
  panes.remote.classList.toggle('active', side === 'remote');
}

async function openEntry(side, entry) {
  if (entry.type === 'd') {
    await loadPane(side, fullPath(side, entry));
    return;
  }

  const other = side === 'local' ? 'remote' : 'local';
  switch (state.settings.doubleClick || 'edit') {
    case 'transfer':
      await transfer(side, other);
      break;
    case 'reveal':
      if (side === 'local') await call(window.api.local.reveal(fullPath(side, entry)));
      else await transfer(side, other);
      break;
    default:
      if (side === 'remote') await editRemote(fullPath(side, entry));
      else await call(window.api.local.reveal(fullPath(side, entry)));
  }
}

/**
 * Řádek, na kterém se událost stala.
 *
 * Když se seznam mezi dvěma kliknutími překreslí (třeba obnovením výpisu na
 * pozadí), přijde dvojklik už jen seznamu. Dohledáme řádek podle polohy
 * kurzoru, ať se akce neztratí.
 */
function rowAt(side, ev) {
  const row = ev.target.closest('.row');
  if (row) return row;
  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  const found = under && under.closest('.row');
  return found && panes[side].contains(found) ? found : null;
}

function wirePane(side) {
  const pane = panes[side];
  const listEl = $('[data-role=list]', pane);
  const other = side === 'local' ? 'remote' : 'local';

  pane.addEventListener('mousedown', () => setActive(side));

  $('[data-role=path]', pane).addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') loadPane(side, ev.target.value.trim());
  });

  $$('[data-act]', pane).forEach((btn) => btn.addEventListener('click', async (ev) => {
    const act = btn.dataset.act;
    if (act === 'up') await loadPane(side, parentOf(side, state[side].path));
    else if (act === 'back') await goHistory(side, -1);
    else if (act === 'fwd') await goHistory(side, 1);
    else if (act === 'home') await loadPane('remote', await call(window.api.remote.home(sid())));
    else if (act === 'browse') {
      const dir = await call(window.api.local.pickDir());
      if (dir) await loadPane('local', dir);
    } else if (act === 'bookmark') showBookmarkMenu(side, ev.currentTarget);
    else if (act === 'filter') toggleFilter(side);
    else if (act === 'filter-clear') setFilter(side, '');
  }));

  // --- řazení kliknutím na hlavičku sloupce ---
  $('[data-role=head]', pane).addEventListener('click', (ev) => {
    const col = ev.target.closest('[data-sort]');
    if (!col) return;
    const st = state[side];
    // Druhé kliknutí na týž sloupec obrátí směr.
    if (st.sort.key === col.dataset.sort) st.sort.dir *= -1;
    else st.sort = { key: col.dataset.sort, dir: 1 };
    renderPane(side);
  });

  // --- filtr ---
  const filterInput = $('[data-role=filter]', pane);
  filterInput.addEventListener('input', () => setFilter(side, filterInput.value, { keepFocus: true }));
  filterInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.stopPropagation(); setFilter(side, ''); }
    if (ev.key === 'Enter') $('[data-role=list]', pane).focus();
  });

  // --- výběr myší ---
  listEl.addEventListener('click', (ev) => {
    const row = ev.target.closest('.row');
    if (!row) return;
    setActive(side);
    if (row.dataset.up) return;
    const idx = Number(row.dataset.index);
    const entry = entryAt(side, idx);
    const st = state[side];

    if (ev.shiftKey && st.cursor >= 0) {
      const [a, b] = [Math.min(st.cursor, idx), Math.max(st.cursor, idx)];
      st.sel.clear();
      for (let i = a; i <= b; i += 1) st.sel.add(st.view[i].name);
    } else if (ev.metaKey || ev.ctrlKey) {
      if (st.sel.has(entry.name)) st.sel.delete(entry.name); else st.sel.add(entry.name);
      st.cursor = idx;
    } else {
      st.sel.clear();
      st.sel.add(entry.name);
      st.cursor = idx;
    }
    paintSelection(side);
  });

  listEl.addEventListener('dblclick', async (ev) => {
    const row = rowAt(side, ev);
    if (!row) return;
    if (row.dataset.up) {
      await loadPane(side, side === 'local' ? localParent(state[side].path) : posixParent(state[side].path));
      return;
    }
    await openEntry(side, entryAt(side, Number(row.dataset.index)));
  });

  listEl.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const row = ev.target.closest('.row');
    setActive(side);
    if (row && !row.dataset.up) {
      const entry = entryAt(side, Number(row.dataset.index));
      if (!state[side].sel.has(entry.name)) {
        state[side].sel.clear();
        state[side].sel.add(entry.name);
        state[side].cursor = Number(row.dataset.index);
        paintSelection(side);
      }
    }
    showContextMenu(side, ev.clientX, ev.clientY);
  });

  // --- přetahování mezi panely ---
  listEl.addEventListener('dragstart', (ev) => {
    const row = ev.target.closest('.row');
    if (!row || row.dataset.up) return ev.preventDefault();
    const entry = entryAt(side, Number(row.dataset.index));
    if (!state[side].sel.has(entry.name)) {
      state[side].sel.clear();
      state[side].sel.add(entry.name);
      paintSelection(side);
    }
    ev.dataTransfer.setData('application/x-ftpcli', side);
    ev.dataTransfer.effectAllowed = 'copy';
  });

  pane.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    pane.classList.add('drag-over');
  });
  pane.addEventListener('dragleave', () => pane.classList.remove('drag-over'));

  pane.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    pane.classList.remove('drag-over');
    const from = ev.dataTransfer.getData('application/x-ftpcli');

    if (from && from !== side) { await transfer(from, side); return; }

    // Přetažení z Finderu na vzdálený panel = upload
    const files = [...(ev.dataTransfer.files || [])].map((f) => window.api.pathForFile(f)).filter(Boolean);
    if (!files.length) return;
    if (side === 'remote') {
      const r = await call(window.api.transfer.upload(sid(), files, state.remote.path));
      if (r) setLog('ok', `Zařazeno ${r.count} ${plural(r.count, 'soubor', 'soubory', 'souborů')} k nahrání`);
    }
  });
}

const parentOf = (side, p) => (side === 'local' ? localParent(p) : posixParent(p));

/* ------------------------------------------------------- filtr v panelu */

function setFilter(side, text, { keepFocus = false } = {}) {
  const st = state[side];
  const bar = $('[data-role=filterbar]', panes[side]);
  const input = $('[data-role=filter]', panes[side]);

  st.filterText = text;
  st.filter = text.trim() ? window.FileMask.compile(text) : null;
  if (st.filter && st.filter.empty) st.filter = null;

  input.value = text;
  input.classList.remove('bad');
  bar.hidden = !text;
  if (!keepFocus && !text) $('[data-role=list]', panes[side]).focus();
  renderPane(side);
}

function toggleFilter(side) {
  const bar = $('[data-role=filterbar]', panes[side]);
  if (bar.hidden) {
    bar.hidden = false;
    $('[data-role=filter]', panes[side]).focus();
  } else {
    setFilter(side, '');
  }
}

/* ----------------------------------------------------------- záložky cest */

/** Záložky se drží podle serveru, aby se cesty z různých strojů nemíchaly. */
function bookmarkKey(side) {
  if (side === 'local') return 'local';
  const s = state.sites.find((x) => x.id === $('#site-select').value);
  return s ? `${s.host}:${s.port}` : 'remote';
}

function getBookmarks(side) {
  const all = state.settings.bookmarks || {};
  return all[bookmarkKey(side)] || [];
}

async function saveBookmarks(side, list) {
  const all = { ...(state.settings.bookmarks || {}), [bookmarkKey(side)]: list };
  state.settings = await call(window.api.settings.set({ bookmarks: all })) || state.settings;
}

function showBookmarkMenu(side, anchor) {
  const st = state[side];
  const list = getBookmarks(side);
  const items = [];

  if (!list.includes(st.path)) {
    items.push({ label: `★ Přidat „${st.path}"`, fn: () => saveBookmarks(side, [...list, st.path]) });
  } else {
    items.push({ label: '☆ Odebrat tuto cestu', fn: () => saveBookmarks(side, list.filter((x) => x !== st.path)) });
  }

  if (list.length) {
    items.push(null);
    for (const b of list) {
      items.push({ label: b, fn: () => loadPane(side, b) });
    }
  }

  const r = anchor.getBoundingClientRect();
  openMenu(items, r.left, r.bottom + 4);
}

/** Přesun vybraných položek z jednoho panelu do druhého. */
/**
 * @param {object} [opts]
 * @param {boolean} [opts.move]   přesun místo kopie
 * @param {string}  [opts.mask]   maska jen pro tenhle přenos; když se nepředá,
 *   použije se výchozí z nastavení
 * @param {string}  [opts.target] jiná cílová složka než ta otevřená v panelu
 */
async function transfer(from, to, { move = false, mask, target } = {}) {
  if (!state.connected) return setLog('error', 'Nejste připojeni');
  const items = selectedEntries(from).map((e) => fullPath(from, e));
  if (!items.length) return setLog('warn', 'Nic není vybráno');

  const targetDir = target || (to === 'local' ? state.local.path : state.remote.path);

  if (move) {
    const what = items.length === 1 ? `„${selectedEntries(from)[0].name}"` : `${items.length} položek`;
    const whereFrom = from === 'local' ? 'z tohoto počítače' : 'ze serveru';
    if (!window.confirm(`Přesunout ${what} do ${targetDir}?\n\n`
      + `Po úspěšném přenosu se zdroj smaže ${whereFrom} (do koše).`)) return undefined;

    const r = await call(window.api.transfer.move(sid(), items, targetDir, from, mask));
    if (r) setLog('ok', `K přesunu zařazeno ${r.count} ${plural(r.count, 'soubor', 'soubory', 'souborů')}`);
    return undefined;
  }

  const r = from === 'local'
    ? await call(window.api.transfer.upload(sid(), items, targetDir, mask))
    : await call(window.api.transfer.download(sid(), items, targetDir, mask));
  if (!r) return undefined;

  // Kolik toho maska zahodila, se musí říct — jinak tiché vynechání vypadá,
  // jako by se přeneslo všechno.
  const skipped = r.skipped
    ? `, maska vynechala ${r.skipped} ${plural(r.skipped, 'položku', 'položky', 'položek')}`
    : '';
  if (r.count === 0 && r.skipped) setLog('warn', `Maska nepustila nic — vynecháno ${r.skipped}`);
  else setLog('ok', `Zařazeno ${r.count} ${plural(r.count, 'soubor', 'soubory', 'souborů')} do fronty${skipped}`);
  return undefined;
}

/* --------------------------------------------------- přenos s volbami */

const xferDlg = $('#dlg-xfer');
const xferForm = $('form', xferDlg);

function openTransferOptions(from) {
  if (!state.connected) return setLog('error', 'Nejste připojeni');
  const sel = selectedEntries(from);
  if (!sel.length) return setLog('warn', 'Nic není vybráno');

  const to = from === 'local' ? 'remote' : 'local';
  xferDlg.dataset.from = from;
  $('#xfer-title').textContent = from === 'local' ? 'Nahrát s volbami' : 'Stáhnout s volbami';
  $('#xfer-what').textContent = sel.length === 1
    ? `Přenáší se „${sel[0].name}"`
    : `Přenáší se ${sel.length} ${plural(sel.length, 'položka', 'položky', 'položek')}`;
  xferForm.elements.target.value = to === 'local' ? state.local.path : state.remote.path;
  xferForm.elements.mask.value = state.settings.transferMask || '';
  xferForm.elements.asDefault.checked = false;
  xferDlg.showModal();
  return undefined;
}

xferDlg.addEventListener('close', async () => {
  if (xferDlg.returnValue !== 'ok') return;
  const from = xferDlg.dataset.from;
  const mask = xferForm.elements.mask.value.trim();

  if (xferForm.elements.asDefault.checked) {
    const saved = await call(window.api.settings.set({ transferMask: mask }));
    if (saved) applySettings(saved);
  }
  await transfer(from, from === 'local' ? 'remote' : 'local', {
    mask,
    target: xferForm.elements.target.value.trim(),
  });
});

/* ------------------------------------------- výběr maskou, velikost složek */

async function selectByMask(side, add) {
  const st = state[side];
  const mask = await promptDialog(
    add ? 'Vybrat podle masky' : 'Odznačit podle masky',
    'Maska, např. *.log; *.bak',
    st.lastMask || '*',
  );
  if (!mask) return;
  st.lastMask = mask;

  const m = window.FileMask.compile(mask);
  let n = 0;
  for (const e of st.view) {
    if (!m.match(e.name, e.type === 'd')) continue;
    n += 1;
    if (add) st.sel.add(e.name); else st.sel.delete(e.name);
  }
  renderPane(side);
  setLog('ok', `${add ? 'Vybráno' : 'Odznačeno'} ${n} ${plural(n, 'položka', 'položky', 'položek')}`);
}

/** Dopočítá velikost vybraných složek — u serveru to znamená projít strom. */
async function calcSizes(side) {
  const st = state[side];
  const dirs = selectedEntries(side).filter((e) => e.type === 'd');
  if (!dirs.length) return;

  setLog('warn', `Počítám velikost ${dirs.length} ${plural(dirs.length, 'složky', 'složek', 'složek')}…`);
  const api = side === 'local' ? window.api.local : window.api.remote;

  let total = 0;
  for (const d of dirs) {
    const res = await call(api.dirSize(fullPath(side, d)));
    if (!res) continue;
    st.sizes.set(d.name, res.bytes);
    total += res.bytes;
    renderPane(side); // průběžně, ať je u velkých stromů vidět postup
  }
  setLog('ok', `Celkem ${fmtSize(total)} v ${dirs.length} ${plural(dirs.length, 'složce', 'složkách', 'složkách')}`);
}

/* -------------------------------------------------- hledání psaním v seznamu */

const typeAhead = { side: null, buf: '', at: 0 };

function handleTypeAhead(side, ch) {
  const now = Date.now();
  // Po vteřině bez psaní začínáme nové slovo, jinak by se hledalo pořád dokola.
  if (typeAhead.side !== side || now - typeAhead.at > 1000) typeAhead.buf = '';
  typeAhead.side = side;
  typeAhead.at = now;
  typeAhead.buf += ch.toLowerCase();

  const st = state[side];
  const start = st.cursor >= 0 && typeAhead.buf.length === 1 ? st.cursor + 1 : 0;
  const order = [...st.view.slice(start), ...st.view.slice(0, start)];
  const hit = order.find((e) => e.name.toLowerCase().startsWith(typeAhead.buf));
  if (!hit) return;

  st.cursor = st.view.indexOf(hit);
  st.sel.clear();
  st.sel.add(hit.name);
  renderPane(side);
  scrollToCursor(side);
}

function scrollToCursor(side) {
  const st = state[side];
  const offset = st.path && st.path !== '/' ? 1 : 0;
  $('[data-role=list]', panes[side]).children[st.cursor + offset]
    ?.scrollIntoView({ block: 'nearest' });
}

/* --------------------------------------------------- kontextové menu */

function showContextMenu(side, x, y) {
  const menu = $('#ctxmenu');
  const sel = selectedEntries(side);
  const other = side === 'local' ? 'remote' : 'local';
  const items = [];

  if (sel.length) {
    items.push({
      label: side === 'local' ? '↑ Nahrát na server' : '↓ Stáhnout',
      key: 'F5',
      fn: () => transfer(side, other),
    });
    items.push({
      label: side === 'local' ? '↑ Přesunout na server' : '↓ Přesunout k sobě',
      key: 'F6',
      fn: () => transfer(side, other, { move: true }),
    });
    items.push({
      label: 'Přenést s volbami…',
      key: '⇧F5',
      fn: () => openTransferOptions(side),
    });
    if (sel.some((e) => e.type === 'd')) {
      items.push({ label: 'Spočítat velikost složek', fn: () => calcSizes(side) });
    }
    if (side === 'remote' && sel.length === 1 && sel[0].type !== 'd') {
      items.push({ label: '✎ Upravit v editoru', key: 'F4', fn: () => editRemote(fullPath(side, sel[0])) });
    }
    items.push(null);
    if (sel.length === 1) items.push({ label: 'Přejmenovat…', key: 'F2', fn: () => renameSelected(side) });
    if (sel.length > 1) items.push({ label: `Hromadně přejmenovat ${sel.length} položek…`, fn: () => openBulkRename(side) });
    const toTrash = side === 'local' || state.trash.enabled;
    items.push({
      label: `${toTrash ? 'Smazat do koše' : 'Smazat'} ${sel.length > 1 ? `(${sel.length})` : ''}`,
      key: '⌫',
      fn: () => deleteSelected(side),
    });
    if (toTrash) {
      items.push({ label: 'Smazat natrvalo', key: '⇧⌫', fn: () => deleteSelected(side, true) });
    }
    if (side === 'remote') {
      items.push({ label: 'Vlastnosti…', key: '⌘I', fn: () => openProperties(side) });
    }
    items.push(null);
  }

  const cmds = customCommands().filter((c) => (side === 'remote' ? true : c.target === 'local'));
  if (cmds.length) {
    items.push(null);
    for (const c of cmds) {
      items.push({ label: `▶ ${c.name}`, fn: () => runCustomCommand(c, side) });
    }
  }
  items.push(null);
  items.push({ label: 'Nová složka…', key: 'F7', fn: () => mkdirIn(side) });
  items.push({ label: 'Vybrat podle masky…', key: '+', fn: () => selectByMask(side, true) });
  items.push({ label: 'Odznačit podle masky…', key: '−', fn: () => selectByMask(side, false) });
  items.push({
    label: state[side].filterText ? 'Zrušit filtr' : 'Filtrovat…',
    fn: () => toggleFilter(side),
  });
  items.push({ label: 'Obnovit', key: '⌘R', fn: () => loadPane(side, state[side].path, { refresh: true }) });
  items.push({ label: '⌨ Otevřít Terminál zde', fn: () => openTerminal(side) });
  items.push({
    label: state[side].showHidden ? 'Skrýt skryté soubory' : 'Zobrazit skryté soubory',
    fn: () => { state[side].showHidden = !state[side].showHidden; renderPane(side); },
  });
  if (side === 'remote') {
    items.push({ label: '🔍 Najít soubory…', key: '⌘F', fn: () => openFind() });
    items.push({ label: '⇅ Synchronizovat tuto složku…', fn: () => openSync() });
    items.push({ label: '⟳ Hlídat lokální složku…', key: '⌘U', fn: () => openWatch() });
    items.push({ label: '⌨ Příkazy na serveru…', key: '⌘L', fn: () => openConsole() });
    if (state.trash.enabled) items.push({ label: 'Vysypat koš na serveru…', fn: () => emptyRemoteTrash() });
  }

  openMenu(items, x, y);
}

/** Vykreslí plovoucí nabídku na dané souřadnice. */
function openMenu(items, x, y) {
  const menu = $('#ctxmenu');
  menu.replaceChildren(...items.map((it) => {
    if (!it) return document.createElement('hr');
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.key) {
      const sp = document.createElement('span');
      sp.className = 'shortcut';
      sp.textContent = it.key;
      b.appendChild(sp);
    }
    b.addEventListener('click', () => { menu.hidden = true; it.fn(); });
    return b;
  }));

  menu.hidden = false;
  // Nabídka se vejde do okna, ale nikdy nezačne nad jeho horní hranou —
  // u delší nabídky než okno by se jinak první položky staly nedostupnými.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
}

document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#ctxmenu')) $('#ctxmenu').hidden = true;
});

/* ------------------------------------------------- operace se soubory */

function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    const dlg = $('#dlg-prompt');
    $('#prompt-title').textContent = title;
    $('#prompt-text').textContent = label;
    const input = $('#prompt-input');
    input.value = value;
    dlg.returnValue = '';
    dlg.showModal();
    input.focus();
    input.select();
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? input.value.trim() : null), { once: true });
  });
}

async function mkdirIn(side) {
  const name = await promptDialog('Nová složka', 'Název');
  if (!name) return;
  const target = side === 'local' ? localJoin(state.local.path, name) : posixJoin(state.remote.path, name);
  const ok = side === 'local'
    ? await call(window.api.local.mkdir(target))
    : await call(window.api.remote.mkdir(sid(), target));
  if (ok !== null) await loadPane(side, state[side].path);
}

async function renameSelected(side) {
  const [entry] = selectedEntries(side);
  if (!entry) return;
  const name = await promptDialog('Přejmenovat', 'Nový název', entry.name);
  if (!name || name === entry.name) return;
  const from = fullPath(side, entry);
  const to = side === 'local' ? localJoin(state.local.path, name) : posixJoin(state.remote.path, name);
  const ok = side === 'local'
    ? await call(window.api.local.rename(from, to))
    : await call(window.api.remote.rename(sid(), from, to));
  if (ok !== null) await loadPane(side, state[side].path);
}

async function deleteSelected(side, permanent = false) {
  const sel = selectedEntries(side);
  if (!sel.length) return;
  const what = sel.length === 1 ? `„${sel[0].name}"` : `${sel.length} položek`;

  let where;
  if (side === 'local') where = 'do koše';
  else if (permanent || !state.trash.enabled) where = 'ze serveru — nevratně';
  else where = `do koše na serveru (${state.trash.path})`;

  if (!window.confirm(`Opravdu smazat ${what} ${where}?`)) return;

  const paths = sel.map((e) => fullPath(side, e));
  const res = side === 'local'
    ? await call(window.api.local.remove(paths))
    : await call(window.api.remote.remove(sid(), paths, permanent));
  if (res === null) return;

  const n = sel.length;
  setLog('ok', `${res && res.toTrash ? 'Přesunuto do koše na serveru' : 'Smazáno'}: `
    + `${n} ${plural(n, 'položka', 'položky', 'položek')}`);
  await loadPane(side, state[side].path);
}

async function emptyRemoteTrash() {
  if (!state.trash.enabled) return setLog('error', 'Koš na serveru není u této relace zapnutý');
  const info = await call(window.api.trash.info(sid()));
  if (!info || !info.days.length) return setLog('ok', 'Koš na serveru je prázdný');
  if (!window.confirm(`Nevratně smazat obsah koše na serveru? Obsahuje ${info.days.length} `
    + `${plural(info.days.length, 'den', 'dny', 'dnů')} mazání (${info.path}).`)) return undefined;
  await call(window.api.trash.empty(sid()));
  await loadPane('remote', state.remote.path);
  return undefined;
}

async function editRemote(remotePath) {
  setLog('warn', `Otevírám ${remotePath}…`);
  const r = await call(window.api.edit.open(sid(), remotePath));
  if (r) setLog('ok', `${remotePath} — změny se budou nahrávat automaticky`);
}

/* ------------------------------------------------------ pracovní plochy */

const wsDlg = $('#dlg-ws');

function workspaces() {
  return state.settings.workspaces || [];
}

function openWorkspaces() {
  renderWorkspaces();
  $('#ws-name').value = '';
  wsDlg.showModal();
}

function renderWorkspaces() {
  const box = $('#ws-list');
  const list = workspaces();

  if (!list.length) {
    box.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'cmd-empty',
      textContent: 'Zatím žádná. Otevřete si záložky a uložte je dole.',
    }));
    return;
  }

  const head = document.createElement('div');
  head.className = 'cmd-row head';
  head.style.gridTemplateColumns = 'minmax(0,1fr) 90px 120px 90px';
  head.innerHTML = '<span>Název</span><span>Záložek</span><span>Otevřít</span><span>Smazat</span>';

  const rows = list.map((w) => {
    const row = document.createElement('div');
    row.className = 'cmd-row';
    row.style.gridTemplateColumns = 'minmax(0,1fr) 90px 120px 90px';

    const name = document.createElement('span');
    name.textContent = w.name;
    const count = document.createElement('span');
    count.textContent = `${w.tabs.length}`;

    const open = document.createElement('button');
    open.textContent = 'Otevřít';
    open.addEventListener('click', () => openWorkspace(w));

    const del = document.createElement('button');
    del.textContent = 'Smazat';
    del.addEventListener('click', async () => {
      if (!window.confirm(`Smazat plochu „${w.name}"?`)) return;
      const saved = await call(window.api.settings.set({
        workspaces: workspaces().filter((x) => x.id !== w.id),
      }));
      if (saved) applySettings(saved);
      renderWorkspaces();
    });

    row.append(name, count, open, del);
    return row;
  });

  box.replaceChildren(head, ...rows);
}

$('#ws-close').addEventListener('click', () => wsDlg.close());

$('#ws-save').addEventListener('click', async () => {
  const name = $('#ws-name').value.trim();
  if (!name) return setLog('error', 'Zadejte název plochy');

  // Ukládáme jen záložky z uložených relací — bez nich by nebylo co otevřít.
  const tabs = state.order
    .map((id) => state.sessions.get(id))
    .filter((s) => s && s.info && s.info.siteId)
    .map((s) => ({ siteId: s.info.siteId, remotePath: s.remote.path, localPath: s.local.path }));

  if (!tabs.length) return setLog('error', 'Nejsou otevřené žádné záložky z uložených relací');

  const list = [...workspaces().filter((w) => w.name !== name), { id: `w${Date.now()}`, name, tabs }];
  const saved = await call(window.api.settings.set({ workspaces: list }));
  if (saved) applySettings(saved);
  renderWorkspaces();
  $('#ws-name').value = '';
  setLog('ok', `Plocha „${name}" uložena (${tabs.length} ${plural(tabs.length, 'záložka', 'záložky', 'záložek')})`);
  return undefined;
});

/** Otevře uloženou plochu — každou záložku zvlášť, ať se chyba jedné nešíří. */
async function openWorkspace(ws) {
  wsDlg.close();
  let opened = 0;

  for (const tab of ws.tabs) {
    const r = await call(window.api.sessions.open({ siteId: tab.siteId }));
    if (!r) continue;

    await adoptSession(r, { remote: tab.remotePath, local: tab.localPath });
    opened += 1;
  }

  setLog(opened ? 'ok' : 'error',
    opened
      ? `Plocha „${ws.name}": otevřeno ${opened} z ${ws.tabs.length}`
      : `Plochu „${ws.name}" se nepodařilo otevřít`);
}

/* ---------------------------------------------------------- vlastnosti */

const propsDlg = $('#dlg-props');
let propsPaths = [];

async function openProperties(side) {
  if (side !== 'remote') return setLog('warn', 'Vlastnosti umí zatím jen serverová strana');
  const sel = selectedEntries(side);
  if (!sel.length) return setLog('warn', 'Nic není vybráno');

  propsPaths = sel.map((e) => fullPath(side, e));
  const data = await call(window.api.remote.properties(sid(), propsPaths));
  if (!data) return undefined;

  $('#props-what').textContent = propsPaths.length === 1
    ? propsPaths[0]
    : `${propsPaths.length} ${plural(propsPaths.length, 'položka', 'položky', 'položek')}`;

  const rows = [
    '<tr><th>Položka</th><th>Typ</th><th>Velikost</th><th>Změněno</th><th>Práva</th><th>Vlastník</th><th>Skupina</th></tr>',
    ...data.items.map((it) => {
      const bare = it.path.slice(it.path.lastIndexOf('/') + 1);
      const name = bare + (it.isDir ? '/' : '');
      // Typ určujeme z názvu — obsah bychom si kvůli tomu museli stáhnout.
      const kind = window.FileKind.of(bare, it.isDir ? 'd' : 'f');
      const typ = it.isDir ? kind.label : `${kind.label} · ${kind.mime}`;
      return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(typ)}</td>`
        + `<td>${it.isDir ? '—' : fmtSize(it.size)}</td>`
        + `<td>${fmtDate(it.mtime) || '—'}</td><td>${fmtPerm(it.mode) || '—'}</td>`
        + `<td>${it.owner ?? '—'}</td><td>${it.group ?? '—'}</td></tr>`;
    }),
  ];
  $('#props-table').innerHTML = rows.join('');

  // Předvyplníme práva podle první položky, ať se nemusí opisovat.
  const first = data.items[0];
  const dirs = data.items.filter((i) => i.isDir);
  const files = data.items.filter((i) => !i.isDir);
  $('#props-file-mode').value = files.length ? fmtPerm(files[0].mode) : '';
  $('#props-dir-mode').value = dirs.length ? fmtPerm(dirs[0].mode) : '';
  $('#props-owner').value = first && first.owner !== null ? first.owner : '';
  $('#props-group').value = first && first.group !== null ? first.group : '';
  $('#props-recursive').checked = false;
  $('#props-hash').style.display = 'none';
  $('#props-hash').textContent = '';

  propsDlg.showModal();
  return undefined;
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Osmičkový zápis práv, nebo null když pole zůstalo prázdné. */
function parseMode(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (!/^[0-7]{3,4}$/.test(v)) throw new Error(`„${v}" nejsou platná práva — čekám tři osmičkové číslice, třeba 644`);
  return parseInt(v, 8);
}

$('#props-close').addEventListener('click', () => propsDlg.close());

$('#props-apply').addEventListener('click', async () => {
  let fileMode;
  let dirMode;
  try {
    fileMode = parseMode($('#props-file-mode').value);
    dirMode = parseMode($('#props-dir-mode').value);
  } catch (err) {
    setLog('error', err.message);
    return;
  }

  const owner = $('#props-owner').value.trim() === '' ? null : Number($('#props-owner').value);
  const group = $('#props-group').value.trim() === '' ? null : Number($('#props-group').value);
  const recursive = $('#props-recursive').checked;

  if (fileMode === null && dirMode === null && owner === null && group === null) {
    setLog('warn', 'Není co změnit — všechna pole jsou prázdná');
    return;
  }
  if (recursive && !window.confirm('Změna práv se použije i na všechen obsah vybraných složek. Pokračovat?')) return;

  const res = await call(window.api.remote.applyProperties(sid(), {
    paths: propsPaths, fileMode, dirMode, owner, group, recursive,
  }));
  if (!res) return;
  setLog('ok', `Změněno: ${res.files} ${plural(res.files, 'soubor', 'soubory', 'souborů')}`
    + `, ${res.dirs} ${plural(res.dirs, 'složka', 'složky', 'složek')}`
    + (res.owners ? `, vlastník u ${res.owners}` : ''));
  propsDlg.close();
  await loadPane('remote', state.remote.path);
});

$('#props-checksum').addEventListener('click', async () => {
  const box = $('#props-hash');
  box.style.display = 'block';
  box.textContent = 'Počítám…';
  const res = await call(window.api.remote.checksum(sid(), propsPaths, $('#props-algo').value));
  if (!res) { box.textContent = ''; box.style.display = 'none'; return; }
  box.textContent = res
    .map((r) => (r.error ? `${r.path}\n  ${r.error}` : `${r.path}\n  ${r.hash}`))
    .join('\n');
});

/* ------------------------------------------------------------- konzole */

const consoleDlg = $('#dlg-console');
const consoleHistory = [];
let historyPos = -1;

function openConsole() {
  if (!state.connected) return setLog('error', 'Nejste připojeni');
  if (active().info.protocol === 'ftp') {
    return setLog('error', 'Spouštění příkazů umí jen SFTP, ne FTP');
  }
  $('#console-where').textContent = `${active().info.name} · pracovní adresář ${state.remote.path}`;
  consoleDlg.showModal();
  $('#console-cmd').focus();
  return undefined;
}

function consoleWrite(text, kind = 'out') {
  const out = $('#console-out');
  const span = document.createElement('span');
  if (kind !== 'out') span.className = kind;
  span.textContent = text;
  out.appendChild(span);
  out.scrollTop = out.scrollHeight;
}

$('#console-close').addEventListener('click', () => consoleDlg.close());
$('#console-clear').addEventListener('click', () => { $('#console-out').replaceChildren(); });

$('#console-cmd').addEventListener('keydown', async (ev) => {
  const input = ev.currentTarget;

  // Historie příkazů šipkami, jako v terminálu.
  if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
    ev.preventDefault();
    if (!consoleHistory.length) return;
    historyPos = ev.key === 'ArrowUp'
      ? Math.min(consoleHistory.length - 1, historyPos + 1)
      : Math.max(-1, historyPos - 1);
    input.value = historyPos < 0 ? '' : consoleHistory[historyPos];
    return;
  }
  if (ev.key !== 'Enter') return;

  const command = input.value.trim();
  if (!command) return;
  consoleHistory.unshift(command);
  historyPos = -1;
  input.value = '';
  input.disabled = true;

  // Zadaný řádek jde na server tak, jak je — sem uživatel píše rovnou příkaz,
  // takže tu žádné zástupné znaky nedosazujeme.
  await call(window.api.cmd.run(sid(), {
    template: command.split('!').join('!!'),
    target: 'remote',
    cwd: state.remote.path,
    localDir: state.local.path,
    files: [],
  }));
  input.disabled = false;
  input.focus();
});

window.api.onConsole(({ sid: id, payload }) => {
  if (id !== state.activeId) return;
  consoleWrite(payload.text, payload.kind);
});

/* ------------------------------------------------------ vlastní příkazy */

const cmdsDlg = $('#dlg-cmds');
const cmdEditDlg = $('#dlg-cmd-edit');
const cmdEditForm = $('form', cmdEditDlg);

function customCommands() {
  return state.settings.commands || [];
}

function openCommands() {
  renderCommands();
  cmdsDlg.showModal();
}

function renderCommands() {
  const box = $('#cmd-list');
  const list = customCommands();

  if (!list.length) {
    box.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'cmd-empty',
      textContent: 'Zatím žádné. Přidejte první tlačítkem dole.',
    }));
    return;
  }

  const head = document.createElement('div');
  head.className = 'cmd-row head';
  head.innerHTML = '<span>Název</span><span>Příkaz</span><span>Kde</span><span>Zvlášť</span>';

  const rows = list.map((c) => {
    const row = document.createElement('div');
    row.className = 'cmd-row';
    row.addEventListener('click', () => openCommandEditor(c));

    const name = document.createElement('span');
    name.textContent = c.name;
    const cmd = document.createElement('span');
    cmd.className = 'c';
    cmd.textContent = c.command;
    cmd.title = c.command;
    const where = document.createElement('span');
    where.textContent = c.target === 'local' ? 'lokálně' : 'na serveru';
    const each = document.createElement('span');
    each.textContent = c.each ? 'ano' : '—';

    row.append(name, cmd, where, each);
    return row;
  });

  box.replaceChildren(head, ...rows);
}

function openCommandEditor(cmd) {
  const f = cmdEditForm.elements;
  cmdEditDlg.dataset.id = cmd ? cmd.id : '';
  $('#cmd-edit-title').textContent = cmd ? `Příkaz: ${cmd.name}` : 'Nový příkaz';
  $('#cmd-edit-delete').hidden = !cmd;
  f.name.value = cmd ? cmd.name : '';
  f.command.value = cmd ? cmd.command : '';
  f.target.value = cmd ? cmd.target : 'remote';
  f.each.checked = cmd ? Boolean(cmd.each) : false;
  cmdEditDlg.showModal();
}

cmdEditDlg.addEventListener('close', async () => {
  const action = cmdEditDlg.returnValue;
  if (action !== 'save' && action !== 'delete') return;

  const id = cmdEditDlg.dataset.id;
  const f = cmdEditForm.elements;
  let list = customCommands().filter((c) => c.id !== id);

  if (action === 'save') {
    list = [...list, {
      id: id || `c${Date.now()}`,
      name: f.name.value.trim(),
      command: f.command.value.trim(),
      target: f.target.value,
      each: f.each.checked,
    }];
  }

  const saved = await call(window.api.settings.set({ commands: list }));
  if (saved) applySettings(saved);
  renderCommands();
});

$('#cmd-add').addEventListener('click', () => openCommandEditor(null));
$('#cmd-close').addEventListener('click', () => cmdsDlg.close());

/** Spustí vlastní příkaz nad výběrem v daném panelu. */
async function runCustomCommand(cmd, side) {
  if (cmd.target === 'remote' && !state.connected) return setLog('error', 'Nejste připojeni');
  if (cmd.target === 'remote' && active().info.protocol === 'ftp') {
    return setLog('error', 'Příkazy na serveru umí jen SFTP, ne FTP');
  }

  const files = selectedEntries(side).map((e) => fullPath(side, e));

  // Dotazy v šabloně vyřešíme předem, ať se hlavní proces nemusí ptát zpět.
  const prompts = await call(window.api.cmd.prompts(cmd.command)) || [];
  const answers = {};
  for (const p of prompts) {
    const v = await promptDialog(cmd.name, p.question || 'Hodnota', p.value || '');
    if (v === null) return undefined;
    answers[p.question] = v;
  }

  $('#console-where').textContent = `${cmd.name} — ${cmd.target === 'local' ? 'lokálně' : active().info.name}`;
  if (!consoleDlg.open) consoleDlg.showModal();

  await call(window.api.cmd.run(sid(), {
    template: cmd.command,
    target: cmd.target,
    cwd: state.remote.path,
    localDir: state.local.path,
    files,
    answers,
    each: cmd.each,
  }));
  return undefined;
}

/* --------------------------------------------------- hlídání složky */

const watchDlg = $('#dlg-watch');

function openWatch() {
  if (!state.connected) return setLog('error', 'Nejste připojeni');
  const st = state.watch;
  if (!st.running) {
    $('#watch-local').value = state.local.path;
    $('#watch-remote').value = state.remote.path;
    if (!$('#watch-mask').value) $('#watch-mask').value = state.settings.transferMask || '';
  }
  renderWatchState();
  watchDlg.showModal();
  return undefined;
}

function renderWatchState() {
  const st = state.watch;
  const running = Boolean(st.running);

  $('#watch-go').hidden = running;
  $('#watch-stop').hidden = !running;
  for (const id of ['#watch-local', '#watch-remote', '#watch-mask', '#watch-initial', '#watch-delete']) {
    $(id).disabled = running;
  }
  $('#watch-warn').hidden = !$('#watch-delete').checked;

  const box = $('#watch-state');
  box.hidden = !running;
  if (running) {
    const since = st.startedAt ? new Date(st.startedAt) : null;
    const p = (n) => String(n).padStart(2, '0');
    box.innerHTML = `<b>Běží</b> od ${since ? `${p(since.getHours())}:${p(since.getMinutes())}` : '—'}`
      + ` · nahráno ${st.uploaded || 0}`
      + (st.deleted ? ` · smazáno ${st.deleted}` : '')
      + (st.errors ? ` · chyb ${st.errors}` : '')
      + (st.pending ? ` · čeká ${st.pending}` : '');
    if (st.lastEvent) {
      const last = document.createElement('span');
      last.className = 'last';
      last.textContent = st.lastEvent.text;
      box.appendChild(last);
    }
  }

  // Ve stavovém řádku má být vidět, že něco běží na pozadí.
  const bar = $('#watch-status');
  bar.classList.toggle('on', running);
  bar.textContent = running
    ? `⟳ hlídám ${st.localDir || ''} (nahráno ${st.uploaded || 0})`
    : '';
}

$('#watch-delete').addEventListener('change', renderWatchState);
$('#watch-close').addEventListener('click', () => watchDlg.close());

$('#watch-go').addEventListener('click', async () => {
  const deleteRemote = $('#watch-delete').checked;
  if (deleteRemote && !window.confirm('Mazání na serveru poběží na pozadí bez ptaní.\n\n'
    + (state.trash.enabled
      ? `Smazané položky půjdou do koše (${state.trash.path}).`
      : 'Koš na serveru je u této relace vypnutý — smazané položky zmizí nenávratně.')
    + '\n\nPokračovat?')) return;

  const res = await call(window.api.watch.start(sid(), {
    localDir: $('#watch-local').value.trim(),
    remoteDir: $('#watch-remote').value.trim(),
    mask: $('#watch-mask').value.trim(),
    deleteRemote,
    initialSync: $('#watch-initial').checked,
  }));
  if (res) {
    state.watch = res;
    renderWatchState();
  }
});

$('#watch-stop').addEventListener('click', async () => {
  const res = await call(window.api.watch.stop(sid()));
  if (res) {
    state.watch = res;
    renderWatchState();
  }
});

window.api.onWatch(({ sid: id, payload }) => {
  const s = state.sessions.get(id);
  if (!s) return;
  s.watch = payload;
  if (id === state.activeId) renderWatchState();
});

/* ------------------------------------------------ hledání souborů */

const findDlg = $('#dlg-find');
const findState = { hits: [], running: false, sel: new Set() };

function openFind() {
  if (!state.connected) return setLog('error', 'Nejste připojeni');
  $('#find-root').value = state.remote.path || '/';
  if (!$('#find-mask').value) $('#find-mask').value = '*';
  findDlg.showModal();
  $('#find-mask').focus();
  return undefined;
}

function renderFindResults() {
  const box = $('#find-results');
  if (!findState.hits.length) {
    box.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'muted', style: 'padding:12px', textContent: 'Zatím nic nenalezeno.',
    }));
    return;
  }

  const head = document.createElement('div');
  head.className = 'fr head';
  head.innerHTML = '<span></span><span>Cesta</span><span>Velikost</span><span>Změněno</span>';

  // Kreslíme jen prvních 500 — u větších nálezů je stejně potřeba zúžit masku.
  const rows = findState.hits.slice(0, 500).map((h, i) => {
    const el = document.createElement('div');
    el.className = `fr${h.type === 'd' ? ' dir' : ''}`;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = findState.sel.has(i);
    cb.addEventListener('change', () => {
      if (cb.checked) findState.sel.add(i); else findState.sel.delete(i);
    });

    const pathEl = document.createElement('span');
    pathEl.className = 'p';
    pathEl.title = h.path;
    pathEl.appendChild(Object.assign(document.createElement('bdi'), { textContent: h.path }));

    const sizeEl = document.createElement('span');
    sizeEl.className = 'n';
    sizeEl.textContent = h.type === 'd' ? '' : fmtSize(h.size);

    const dateEl = document.createElement('span');
    dateEl.className = 'n';
    dateEl.textContent = fmtDate(h.mtime);

    el.append(cb, pathEl, sizeEl, dateEl);
    return el;
  });

  box.replaceChildren(head, ...rows);
}

function findSelection() {
  return [...findState.sel].map((i) => findState.hits[i]).filter(Boolean);
}

$('#find-go').addEventListener('click', async () => {
  findState.hits = [];
  findState.sel.clear();
  findState.running = true;
  renderFindResults();
  $('#find-go').hidden = true;
  $('#find-stop').hidden = false;
  $('#find-status').textContent = 'Hledám…';

  const res = await call(window.api.find.start(sid(), {
    root: $('#find-root').value.trim() || '/',
    mask: $('#find-mask').value.trim() || '*',
    includeDirs: $('#find-dirs').checked,
  }));

  findState.running = false;
  $('#find-go').hidden = false;
  $('#find-stop').hidden = true;
  if (res) {
    $('#find-status').textContent = `${res.canceled ? 'Zastaveno — ' : ''}`
      + `nalezeno ${res.total} ${plural(res.total, 'položka', 'položky', 'položek')}`
      + ` (prohledáno ${res.scanned})`
      + (findState.hits.length > 500 ? ' — zobrazeno prvních 500' : '');
  }
});

$('#find-stop').addEventListener('click', () => window.api.find.cancel(sid()));
$('#find-close').addEventListener('click', () => { window.api.find.cancel(sid()); findDlg.close(); });

$('#find-reveal').addEventListener('click', async () => {
  const [first] = findSelection();
  if (!first) return setLog('warn', 'Nic není vybráno');
  findDlg.close();
  await loadPane('remote', first.dir);
  state.remote.sel.add(first.name);
  state.remote.cursor = state.remote.view.findIndex((e) => e.name === first.name);
  renderPane('remote');
  scrollToCursor('remote');
  return undefined;
});

$('#find-edit').addEventListener('click', async () => {
  const files = findSelection().filter((h) => h.type !== 'd');
  if (!files.length) return setLog('warn', 'Vyberte soubor');
  findDlg.close();
  for (const f of files.slice(0, 5)) await editRemote(f.path);
  return undefined;
});

$('#find-download').addEventListener('click', async () => {
  const items = findSelection().map((h) => h.path);
  if (!items.length) return setLog('warn', 'Nic není vybráno');
  const r = await call(window.api.transfer.download(sid(), items, state.local.path));
  if (r) {
    setLog('ok', `Zařazeno ${r.count} ${plural(r.count, 'soubor', 'soubory', 'souborů')} ke stažení`);
    findDlg.close();
  }
  return undefined;
});

window.api.onFind(({ sid: id, payload: msg }) => {
  if (id !== state.activeId) return;
  if (msg.hit) {
    findState.hits.push(msg.hit);
    // Překreslujeme po dávkách, jinak by se u tisíců nálezů okno zadrhlo.
    if (findState.hits.length <= 500 && findState.hits.length % 25 === 0) renderFindResults();
  }
  if (msg.done) renderFindResults();
  else if (msg.scanned) $('#find-status').textContent = `Hledám… prohledáno ${msg.scanned}, nalezeno ${findState.hits.length}`;
});

/* ------------------------------- soubor se na serveru mezitím změnil */

const editConflictDlg = $('#dlg-editconflict');
let editConflictQueue = Promise.resolve();

function askEditConflict(req) {
  editConflictQueue = editConflictQueue.then(() => new Promise((resolve) => {
    $('#ec-path').textContent = req.remotePath;

    const cell = (v, cls = '') => `<span class="${cls}">${v}</span>`;
    $('#ec-cmp').innerHTML = [
      cell('', 'h'), cell('Když jste otevřel', 'h'), cell('Teď na serveru', 'h'),
      cell('Velikost', 'k'), cell(fmtSize(req.known?.size)), cell(fmtSize(req.current?.size)),
      cell('Změněno', 'k'), cell(fmtDate(req.known?.mtime) || '—'),
      cell(fmtDate(req.current?.mtime) || '—', 'newer'),
    ].join('');

    const done = (action) => {
      cleanup();
      window.api.answer(req.id, { action });
      editConflictDlg.close();
      resolve();
    };
    const onClick = (ev) => {
      const btn = ev.target.closest('button[data-action]');
      if (btn) done(btn.dataset.action);
    };
    // Esc znamená nenahrávat — cizí změnu je horší zahodit než neuložit vlastní.
    const onCancel = (ev) => { ev.preventDefault(); done('skip'); };
    const cleanup = () => {
      editConflictDlg.removeEventListener('click', onClick);
      editConflictDlg.removeEventListener('cancel', onCancel);
    };

    editConflictDlg.addEventListener('click', onClick);
    editConflictDlg.addEventListener('cancel', onCancel);
    editConflictDlg.showModal();
  }));
  return editConflictQueue;
}

/* --------------------------------------------- konflikt při přepisu */

const conflictDlg = $('#dlg-conflict');
let conflictQueue = Promise.resolve();

/**
 * Hlavní proces se ptá, co s existujícím cílovým souborem. Dotazy řadíme
 * za sebou — fronta je sériová, ale zpráva může dorazit, než se zavře
 * předchozí dialog, a `showModal()` na už otevřeném dialogu vyhodí chybu.
 */
function askConflict(req) {
  conflictQueue = conflictQueue.then(() => new Promise((resolve) => {
    const target = req.direction === 'up' ? req.remotePath : req.localPath;
    $('#conflict-path').textContent = target;

    const srcNewer = (req.source.mtime ?? 0) > (req.target.mtime ?? 0);
    const cell = (v, cls = '') => `<span class="${cls}">${v}</span>`;
    $('#conflict-cmp').innerHTML = [
      cell('', 'h'),
      cell(req.direction === 'up' ? 'Lokální (zdroj)' : 'Server (zdroj)', 'h'),
      cell(req.direction === 'up' ? 'Server (cíl)' : 'Lokální (cíl)', 'h'),
      cell('Velikost', 'k'), cell(fmtSize(req.source.size)), cell(fmtSize(req.target.size)),
      cell('Změněno', 'k'),
      cell(fmtDate(req.source.mtime) || '—', srcNewer ? 'newer' : ''),
      cell(fmtDate(req.target.mtime) || '—', srcNewer ? 'older' : 'newer'),
    ].join('');

    $('#conflict-resume').disabled = !req.canResume;
    $('#conflict-all').checked = false;

    const onClick = (ev) => {
      const btn = ev.target.closest('button[data-action]');
      if (!btn) return;
      cleanup();
      window.api.answer(req.id, { action: btn.dataset.action, applyToAll: $('#conflict-all').checked });
      conflictDlg.close();
      resolve();
    };
    const onCancel = (ev) => {
      // Esc nesmí znamenat „přepiš" — bereme ho jako přeskočení.
      ev.preventDefault();
      cleanup();
      window.api.answer(req.id, { action: 'skip', applyToAll: false });
      conflictDlg.close();
      resolve();
    };
    const cleanup = () => {
      conflictDlg.removeEventListener('click', onClick);
      conflictDlg.removeEventListener('cancel', onCancel);
    };

    conflictDlg.addEventListener('click', onClick);
    conflictDlg.addEventListener('cancel', onCancel);
    conflictDlg.showModal();
  }));
  return conflictQueue;
}

/* ---------------------------------------------------------- klávesnice */

document.addEventListener('keydown', async (ev) => {
  if (ev.target.matches('input, select, textarea') || document.querySelector('dialog[open]')) return;
  const side = state.activeSide;
  const other = side === 'local' ? 'remote' : 'local';
  const st = state[side];

  switch (ev.key) {
    case 'F5':
      ev.preventDefault();
      // Shift otevře dialog s cílem a maskou, jako „Transfer settings" ve WinSCP.
      if (ev.shiftKey) openTransferOptions(side); else await transfer(side, other);
      break;
    case 'F6': ev.preventDefault(); await transfer(side, other, { move: true }); break;
    case 'F2': ev.preventDefault(); await renameSelected(side); break;
    case 'F4': ev.preventDefault(); {
      const [e] = selectedEntries(side);
      if (side === 'remote' && e && e.type !== 'd') await editRemote(fullPath(side, e));
      break;
    }
    case 'F7': ev.preventDefault(); await mkdirIn(side); break;
    // Shift obchází koš — stejně jako ve WinSCP a ve Finderu.
    case 'Delete': case 'Backspace': ev.preventDefault(); await deleteSelected(side, ev.shiftKey); break;
    case 'Tab': ev.preventDefault(); setActive(other); break;
    case 'Enter': {
      ev.preventDefault();
      const [e] = selectedEntries(side);
      if (e) await openEntry(side, e);
      break;
    }
    case 'ArrowDown': case 'ArrowUp': {
      ev.preventDefault();
      if (!st.view || !st.view.length) break;
      const delta = ev.key === 'ArrowDown' ? 1 : -1;
      st.cursor = Math.max(0, Math.min(st.view.length - 1, (st.cursor < 0 ? -delta : st.cursor) + delta));
      if (!ev.shiftKey) st.sel.clear();
      st.sel.add(st.view[st.cursor].name);
      renderPane(side);
      scrollToCursor(side);
      break;
    }
    case '+': ev.preventDefault(); await selectByMask(side, true); break;
    case '-': ev.preventDefault(); await selectByMask(side, false); break;
    case '[':
      if (ev.metaKey) { ev.preventDefault(); await goHistory(side, -1); }
      break;
    case ']':
      if (ev.metaKey) { ev.preventDefault(); await goHistory(side, 1); }
      break;
    case 'a':
      if (ev.metaKey) {
        ev.preventDefault();
        st.sel = new Set((st.view || []).map((e) => e.name));
        renderPane(side);
      }
      break;
    case 'f':
      if (ev.metaKey) { ev.preventDefault(); if (side === 'remote') openFind(); else toggleFilter(side); }
      break;
    case 'l':
      if (ev.metaKey) { ev.preventDefault(); openConsole(); }
      break;
    case 'i':
      if (ev.metaKey) { ev.preventDefault(); await openProperties(side); }
      break;
    default:
      // Psaní písmen skáče na odpovídající položku. Modifikátory vynecháváme,
      // ať se to nepere se zkratkami.
      if (state.settings.typeAhead !== false
          && !ev.metaKey && !ev.ctrlKey && !ev.altKey
          && ev.key.length === 1 && /\S/.test(ev.key)) {
        ev.preventDefault();
        handleTypeAhead(side, ev.key);
      }
      break;
  }
});

/* ---------------------------------------------------- relace a připojení */

/** Popisek tlačítka v liště podle vybrané relace. */
function renderSiteButton() {
  const s = state.sites.find((x) => x.id === $('#site-select').value);
  $('#btn-sites-label').textContent = s
    ? `${s.folder ? `${s.folder} / ` : ''}${s.name}`
    : '— vyberte relaci —';
  $('#btn-sites').title = s ? `${s.username ? `${s.username}@` : ''}${s.host}:${s.port}` : 'Relace (⌘K)';
}

async function refreshSites(selectId) {
  state.sites = await call(window.api.sites.list()) || [];
  const sel = $('#site-select');
  const current = selectId || sel.value;
  sel.replaceChildren();
  sel.appendChild(new Option('— vyberte relaci —', ''));

  const byFolder = new Map();
  for (const s of state.sites) {
    const key = s.folder || '';
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(s);
  }
  for (const [folder, list] of [...byFolder].sort((a, b) => a[0].localeCompare(b[0], 'cs'))) {
    const parent = folder ? document.createElement('optgroup') : sel;
    if (folder) { parent.label = folder; sel.appendChild(parent); }
    for (const s of list.sort((a, b) => a.name.localeCompare(b.name, 'cs'))) {
      const o = new Option(`${s.name} — ${s.username ? `${s.username}@` : ''}${s.host}`, s.id);
      parent.appendChild(o);
    }
  }
  if (current) sel.value = current;
  renderSiteButton();
  if (sitesDlg.open) renderSitesTree();
}

/**
 * Otevře Terminál v aktuální cestě.
 *
 * U serveru se příkaz `ssh` jen připraví do schránky. Spustit ho za uživatele
 * by znamenalo psát mu do cizího shellu příkazy, o kterých neví — a heslo
 * bychom tam stejně nedostali.
 */
async function openTerminal(side) {
  const r = await call(window.api.files.openTerminal(sid(), side, state[side].path));
  if (!r) return;
  if (r.opened === 'remote') {
    setLog('ok', `Terminál otevřen; příkaz máte ve schránce: ${r.command}`);
  } else {
    setLog('ok', 'Terminál otevřen v této složce');
  }
}

/* -------------------------------------------- hromadné přejmenování */

const bulkDlg = $('#dlg-bulk');
const bulkState = { side: 'remote', names: [], existing: [], rows: [] };

function openBulkRename(side) {
  const sel = selectedEntries(side);
  if (sel.length < 2) return setLog('warn', 'Vyberte aspoň dvě položky; jednu přejmenujete přes F2');

  bulkState.side = side;
  bulkState.names = sel.map((e) => e.name);
  // Názvy ve složce potřebujeme, abychom poznali, že by nový název přepsal
  // něco, co se samo nepřejmenovává.
  bulkState.existing = (state[side].view || []).map((e) => e.name);

  $('#bulk-what').textContent = `${bulkState.names.length} ${
    plural(bulkState.names.length, 'položka', 'položky', 'položek')} v ${
    side === 'local' ? 'lokálním panelu' : 'serverovém panelu'}`;
  for (const id of ['#bulk-find', '#bulk-replace']) $(id).value = '';
  renderBulkPreview();
  bulkDlg.showModal();
  $('#bulk-find').focus();
  return undefined;
}

function bulkOptions() {
  return {
    find: $('#bulk-find').value,
    replace: $('#bulk-replace').value,
    regex: $('#bulk-regex').checked,
    caseSensitive: $('#bulk-case').checked,
    target: $('#bulk-target').value,
    start: Number($('#bulk-start').value) || 0,
    step: Number($('#bulk-step').value) || 1,
    pad: Number($('#bulk-pad').value) || 1,
    existing: bulkState.existing,
  };
}

/** Náhled se přepočítává při každé změně — přejmenování je nevratné. */
function renderBulkPreview() {
  const rows = window.BulkRename.plan(bulkState.names, bulkOptions());
  bulkState.rows = rows;
  const box = $('#bulk-preview');

  const head = document.createElement('div');
  head.className = 'sr head';
  head.style.gridTemplateColumns = 'minmax(0,1fr) 24px minmax(0,1fr)';
  head.innerHTML = '<span>Původní název</span><span></span><span>Nový název</span>';

  const el = rows.map((r) => {
    const row = document.createElement('div');
    row.className = 'sr';
    row.style.gridTemplateColumns = 'minmax(0,1fr) 24px minmax(0,1fr)';

    const from = document.createElement('span');
    from.textContent = r.from;
    const sip = document.createElement('span');
    sip.textContent = r.changed && !r.error ? '→' : '';

    const to = document.createElement('span');
    if (r.error) {
      to.innerHTML = '<span class="tag bad"></span>';
      to.firstChild.textContent = r.error;
    } else if (!r.changed) {
      to.textContent = 'beze změny';
      to.className = 'muted';
    } else {
      to.textContent = r.to;
    }
    row.append(from, sip, to);
    return row;
  });

  box.replaceChildren(head, ...el);

  const proveditelne = window.BulkRename.applicable(rows).length;
  const chyby = rows.filter((r) => r.error).length;
  $('#bulk-go').disabled = proveditelne === 0 || chyby > 0;
  $('#bulk-go').textContent = chyby
    ? `Nejdřív opravte ${chyby} ${plural(chyby, 'konflikt', 'konflikty', 'konfliktů')}`
    : `Přejmenovat ${proveditelne}`;
}

for (const id of ['#bulk-find', '#bulk-replace', '#bulk-start', '#bulk-step', '#bulk-pad']) {
  $(id).addEventListener('input', renderBulkPreview);
}
for (const id of ['#bulk-target', '#bulk-regex', '#bulk-case']) {
  $(id).addEventListener('change', renderBulkPreview);
}
$('#bulk-cancel').addEventListener('click', () => bulkDlg.close());

$('#bulk-go').addEventListener('click', async () => {
  const kroky = window.BulkRename.steps(bulkState.rows);
  if (!kroky.length) return;
  const dir = state[bulkState.side].path;

  const r = await call(window.api.files.renameMany(sid(), {
    side: bulkState.side, dir, steps: kroky,
  }));
  if (!r) return;

  bulkDlg.close();
  await loadPane(bulkState.side, dir, { refresh: true });
  setLog(r.failed.length ? 'warn' : 'ok',
    `Přejmenováno ${r.renamed} ${plural(r.renamed, 'položka', 'položky', 'položek')}`
    + (r.failed.length ? `; ${r.failed.length} se nepovedlo: ${r.failed[0]}` : ''));
});

/* ------------------------------------------------------ správce relací */

/**
 * Seznam relací jako strom se složkami.
 *
 * Selectbox stačil na pět relací; u sedmdesáti ve dvaceti složkách se v něm
 * nedá nic najít. Strom drží složky pohromadě, hledání zúží seznam na to,
 * co se hodí, a detail vpravo ukáže, kam se to vlastně připojuje — než se
 * klikne na Připojit, ne až potom.
 */
const sitesDlg = $('#dlg-sites');
const sitesUi = { query: '', selected: null, collapsed: new Set(), rows: [] };

function openSites() {
  sitesUi.query = '';
  $('#sites-search').value = '';
  sitesUi.selected = $('#site-select').value || null;
  sitesUi.collapsed = new Set(state.settings.collapsedFolders || []);
  renderSitesTree();
  sitesDlg.showModal();
  $('#sites-search').focus();
}

/** Relace rozdělené do složek, seřazené a případně profiltrované hledáním. */
function siteTreeData() {
  const q = sitesUi.query.trim().toLowerCase();
  const sedi = (s) => !q || [s.name, s.host, s.username, s.folder, s.note]
    .some((v) => String(v || '').toLowerCase().includes(q));

  const slozky = new Map();
  for (const s of state.sites) {
    if (!sedi(s)) continue;
    const key = s.folder || '';
    if (!slozky.has(key)) slozky.set(key, []);
    slozky.get(key).push(s);
  }
  for (const list of slozky.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'cs'));

  // Relace bez složky patří nahoru, zbytek podle abecedy.
  return [...slozky.entries()].sort((a, b) => {
    if (!a[0]) return -1;
    if (!b[0]) return 1;
    return a[0].localeCompare(b[0], 'cs');
  });
}

function renderSitesTree() {
  const box = $('#sites-tree');
  const data = siteTreeData();
  const q = sitesUi.query.trim();
  sitesUi.rows = [];

  const frag = document.createDocumentFragment();
  for (const [folder, list] of data) {
    // Při hledání složky rozbalujeme, jinak by výsledky zůstaly schované.
    const sbaleno = folder && !q && sitesUi.collapsed.has(folder);

    if (folder) {
      const row = document.createElement('div');
      row.className = 'st-row folder';
      row.innerHTML = '<span class="st-caret"></span><span class="st-name"></span><span class="st-count"></span>';
      row.children[0].textContent = sbaleno ? '▶' : '▼';
      row.children[1].textContent = folder;
      row.children[2].textContent = `${list.length}`;
      row.addEventListener('click', () => toggleFolder(folder));
      frag.appendChild(row);
      sitesUi.rows.push({ kind: 'folder', folder });
    }

    if (sbaleno) continue;
    for (const s of list) {
      const row = document.createElement('div');
      row.className = `st-row site${folder ? '' : ' top'}${s.id === sitesUi.selected ? ' sel' : ''}`;
      row.dataset.id = s.id;
      if (s.color) row.dataset.color = s.color;
      row.innerHTML = '<span class="st-dot"></span><span class="st-name"></span><span class="st-sub"></span>';
      row.children[1].textContent = s.name;
      row.children[2].textContent = `${s.username ? `${s.username}@` : ''}${s.host}`;
      row.title = `${s.protocol.toUpperCase()} · ${s.username ? `${s.username}@` : ''}${s.host}:${s.port}`
        + (s.note ? `\n${s.note}` : '');
      row.addEventListener('click', () => selectSite(s.id));
      row.addEventListener('dblclick', () => connectFromManager());
      frag.appendChild(row);
      sitesUi.rows.push({ kind: 'site', id: s.id });
    }
  }

  if (!sitesUi.rows.length) {
    frag.appendChild(Object.assign(document.createElement('p'), {
      className: 'cmd-empty',
      textContent: state.sites.length ? 'Hledání nic nenašlo.' : 'Zatím žádné relace.',
    }));
  }
  box.replaceChildren(frag);
  const vybrana = $('#sites-tree .st-row.sel');
  if (vybrana) vybrana.scrollIntoView({ block: 'nearest' });
  renderSiteDetail();
}

async function toggleFolder(folder) {
  if (sitesUi.collapsed.has(folder)) sitesUi.collapsed.delete(folder);
  else sitesUi.collapsed.add(folder);
  renderSitesTree();
  // Sbalené složky si pamatujeme; u dvaceti složek je otravné je pokaždé zavírat.
  const saved = await call(window.api.settings.set({ collapsedFolders: [...sitesUi.collapsed] }), { silent: true });
  if (saved) state.settings = { ...state.settings, collapsedFolders: saved.collapsedFolders };
}

/**
 * Vybere relaci ve stromu.
 *
 * Zvýraznění se přebarvuje na místě, ne překreslením celého stromu — druhé
 * kliknutí by jinak dopadlo na nově vyrobený řádek a dvojklik by se
 * neuskutečnil. Přesně tahle chyba se dřív projevila v panelech.
 */
function selectSite(id, { scroll = false } = {}) {
  sitesUi.selected = id;
  for (const row of $$('#sites-tree .st-row.site')) {
    row.classList.toggle('sel', row.dataset.id === id);
  }
  if (scroll) {
    const el = $('#sites-tree .st-row.sel');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
  renderSiteDetail();
}

function renderSiteDetail() {
  const box = $('#sites-detail');
  const s = state.sites.find((x) => x.id === sitesUi.selected);
  const maBarvu = s && s.color;
  for (const b of ['#sites-connect', '#sites-edit', '#sites-del', '#sites-dup']) $(b).disabled = !s;

  if (!s) {
    box.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'sites-empty', textContent: 'Vyberte relaci vlevo.',
    }));
    return;
  }

  const dl = document.createElement('dl');
  const radek = (k, v) => {
    if (!v) return;
    dl.appendChild(Object.assign(document.createElement('dt'), { textContent: k }));
    dl.appendChild(Object.assign(document.createElement('dd'), { textContent: v }));
  };
  radek('Protokol', s.protocol.toUpperCase() + (s.ftps && s.ftps !== 'none' ? ` (${s.ftps})` : ''));
  radek('Server', `${s.host}:${s.port}`);
  radek('Uživatel', s.username || '(nezadán)');
  radek('Přihlášení', s.hasPassword ? 'heslo uložené' : s.privateKeyPath ? `klíč ${s.privateKeyPath}` : 'zeptá se');
  radek('Složka', s.folder);
  radek('Vzdálený adresář', s.remoteDir);
  radek('Brána', s.tunnelHost ? `${s.tunnelUsername ? `${s.tunnelUsername}@` : ''}${s.tunnelHost}:${s.tunnelPort}` : '');
  radek('Proxy', s.proxyType && s.proxyType !== 'none' ? `${s.proxyType} ${s.proxyHost}:${s.proxyPort}` : '');
  radek('Koš na serveru', s.useRecycleBin ? 'zapnutý' : 'vypnutý');
  radek('Poznámka', s.note);

  const nadpis = document.createElement('h3');
  if (maBarvu) nadpis.dataset.color = s.color;
  nadpis.textContent = s.name;
  if (maBarvu) nadpis.style.color = 'var(--site)';
  box.replaceChildren(nadpis, dl);
}

/** Pohyb v seznamu z klávesnice — psát a šipkou vybrat je nejrychlejší cesta. */
function moveSiteSelection(delta) {
  const sites = sitesUi.rows.filter((r) => r.kind === 'site');
  if (!sites.length) return;
  const kde = sites.findIndex((r) => r.id === sitesUi.selected);
  const dalsi = kde === -1
    ? (delta > 0 ? 0 : sites.length - 1)
    : Math.min(sites.length - 1, Math.max(0, kde + delta));
  selectSite(sites[dalsi].id, { scroll: true });
}

async function connectFromManager() {
  if (!sitesUi.selected) return;
  $('#site-select').value = sitesUi.selected;
  renderSiteButton();
  sitesDlg.close();
  await connectSelected();
}

$('#btn-sites').addEventListener('click', openSites);
$('#sites-close').addEventListener('click', () => sitesDlg.close());
$('#sites-connect').addEventListener('click', connectFromManager);
$('#sites-search').addEventListener('input', () => {
  sitesUi.query = $('#sites-search').value;
  renderSitesTree();
});
$('#sites-search').addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSiteSelection(1); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveSiteSelection(-1); }
  else if (ev.key === 'Enter') { ev.preventDefault(); connectFromManager(); }
});
$('#sites-tree').addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSiteSelection(1); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveSiteSelection(-1); }
  else if (ev.key === 'Enter') { ev.preventDefault(); connectFromManager(); }
});

$('#sites-new').addEventListener('click', () => {
  sitesDlg.close();
  $('#btn-new-site').click();
});
$('#sites-edit').addEventListener('click', () => {
  $('#site-select').value = sitesUi.selected;
  sitesDlg.close();
  $('#btn-edit-site').click();
});
$('#sites-del').addEventListener('click', async () => {
  $('#site-select').value = sitesUi.selected;
  await deleteSelectedSite();
  renderSitesTree();
});
$('#sites-dup').addEventListener('click', async () => {
  const s = state.sites.find((x) => x.id === sitesUi.selected);
  if (!s) return;
  // Kopii dělá hlavní proces, aby se přenesla i hesla — ta se do okna nikdy
  // neposílají a bez nich by kopie byla k ničemu.
  const id = await call(window.api.sites.duplicate(s.id));
  if (!id) return;
  await refreshSites();
  selectSite(id);
  setLog('ok', `Vytvořena kopie relace ${s.name}`);
});

async function refreshTrashInfo() {
  // Nekontrolujeme state.connected — ten se nastavuje až z události „conn",
  // která může dorazit po odpovědi na připojení. Hlavní proces si stejně
  // ohlídá, že bez spojení vrátí vypnuto.
  const info = await call(window.api.trash.info(sid()), { silent: true });
  state.trash = info && info.enabled ? { enabled: true, path: info.path } : { enabled: false, path: '' };
}

async function connectSelected() {
  const id = $('#site-select').value;
  if (!id) return setLog('error', 'Nejdřív vyberte relaci');

  $('#conn-status').className = 'badge wait';
  $('#conn-status').textContent = 'Připojuji…';

  // Nová záložka převezme lokální cestu z té, ve které stojíme — obvykle
  // se pracuje na jednom projektu a jen se střídají servery.
  const carryLocal = active().local.path;

  const r = await call(window.api.sessions.open({ siteId: id }));
  if (!r) {
    renderTabs();
    return undefined;
  }

  await adoptSession(r, { local: carryLocal });
  return undefined;
}

/**
 * Zabydlí čerstvě otevřenou relaci v okně.
 *
 * Používá to připojení i otvírání pracovní plochy — kdyby si každý dělal svoje,
 * jedna z cest by dřív nebo později zapomněla třeba na nedokončenou frontu.
 */
async function adoptSession(r, { remote = '', local = '' } = {}) {
  const session = newSession(r.session);
  state.sessions.set(r.session.id, session);
  state.order.push(r.session.id);
  state.activeId = r.session.id;

  renderTabs();
  await refreshTrashInfo();

  // Přenosy, které nedoběhly před zavřením aplikace. Ptáme se: rozepsané
  // soubory mohly mezitím zestárnout a obnovovat je bez ptaní by překvapilo.
  if (r.unfinished) {
    const n = r.unfinished;
    if (window.confirm(`Z minula zbývá ${n} ${plural(n, 'nedokončený přenos', 'nedokončené přenosy', 'nedokončených přenosů')}.\n\nObnovit je?`)) {
      await call(window.api.queue.restore(sid()));
    } else {
      await call(window.api.queue.discard(sid()));
    }
  }

  await loadPane('remote', remote || r.home);
  await loadPane('local', local || r.localDir);
  renderQueue(await call(window.api.queue.snapshot(sid())) || session.queue);
}

/* ------------------------------------------------------------- záložky */

function renderTabs() {
  const bar = $('#tabs');
  const ids = state.order.filter((id) => state.sessions.has(id));
  state.order = ids;
  bar.hidden = ids.length === 0;

  const frag = document.createDocumentFragment();
  for (const id of ids) {
    const s = state.sessions.get(id);
    const info = s.info || {};
    const off = info.status !== 'connected';
    const busy = info.status === 'connecting';

    const tab = document.createElement('button');
    tab.className = `tab${id === state.activeId ? ' active' : ''}${off ? ' off' : ''}${busy ? ' busy' : ''}`;
    // Barva a poznámka relace: nejlevnější pojistka proti tomu, aby člověk
    // mazal na produkci v domnění, že je na testu.
    if (info.color) tab.dataset.color = info.color;
    tab.title = `${info.username ? `${info.username}@` : ''}${info.host || ''}`
      + (info.note ? `\n${info.note}` : '');
    tab.addEventListener('click', () => switchTo(id));

    const dot = document.createElement('span');
    dot.className = 'dot';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = info.name || info.host || 'relace';

    tab.append(dot, name);

    // Přenosy běží i v záložkách vzadu — ať je vidět, že se něco děje.
    if (s.queue && s.queue.pending) {
      const busy = document.createElement('span');
      busy.className = 'busy';
      busy.textContent = `↕${s.queue.pending}`;
      tab.appendChild(busy);
    }

    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '✕';
    x.title = 'Zavřít záložku (⌘W)';
    x.addEventListener('click', (ev) => { ev.stopPropagation(); closeTab(id); });
    tab.appendChild(x);

    frag.appendChild(tab);
  }

  const add = document.createElement('button');
  add.className = 'tab-add';
  add.textContent = '＋';
  add.title = 'Připojit v nové záložce (⌘O)';
  add.addEventListener('click', () => connectSelected());
  frag.appendChild(add);

  bar.replaceChildren(frag);
  applyConnState();
}

async function switchTo(id) {
  if (!state.sessions.has(id) || id === state.activeId) return;
  state.activeId = id;
  await call(window.api.sessions.activate(id), { silent: true });

  // Panely i fronta ukazují do nové záložky, takže se překreslí všechno.
  renderTabs();
  renderPane('local');
  renderPane('remote');
  $('[data-role=path]', panes.local).value = state.local.path;
  $('[data-role=path]', panes.remote).value = state.remote.path;
  updateHistoryButtons('local');
  updateHistoryButtons('remote');
  renderQueue(state.queue);
  renderWatchState();
  updateEditStatus();

  const s = state.sessions.get(id);
  if (s.info && s.info.siteId) $('#site-select').value = s.info.siteId;
}

async function closeTab(id) {
  const s = state.sessions.get(id);
  if (!s) return;
  if (s.queue && s.queue.pending
    && !window.confirm(`V záložce „${s.info.name}" ještě běží ${s.queue.pending} přenosů. Zavřít i tak?`)) return;

  const wasActive = state.activeId === id;
  await call(window.api.sessions.close(id));
  state.sessions.delete(id);
  state.order = state.order.filter((x) => x !== id);

  if (wasActive) {
    const next = state.order[state.order.length - 1] || null;
    // Nejdřív uvolnit, teprve pak přepnout: switchTo odchází, když se má
    // přepnout na záložku, která už je označená jako aktivní.
    state.activeId = null;
    if (next) {
      await switchTo(next);
      return;
    }
    // Poslední záložka zmizela — zbude náhradní stav s lokálním panelem.
    state.placeholder.local = s.local;
    renderPane('remote');
    $('[data-role=path]', panes.remote).value = '';
    renderQueue(state.queue);
    renderWatchState();
    updateEditStatus();
  }
  renderTabs();
}

function cycleTab(delta) {
  if (state.order.length < 2) return;
  const i = state.order.indexOf(state.activeId);
  const next = state.order[(i + delta + state.order.length) % state.order.length];
  switchTo(next);
}

/** Stavový řádek ukazuje záložku vpředu. */
function applyConnState() {
  const info = active().info;
  const badge = $('#conn-status');

  // Barva a poznámka relace se drží u serverového panelu — tam, kam se člověk
  // dívá, když maže. Panel bez připojení nemá co obarvovat.
  const barva = info && state.connected ? info.color || '' : '';
  if (barva) panes.remote.dataset.color = barva;
  else delete panes.remote.dataset.color;

  const note = $('#remote-note');
  const text = info && state.connected ? info.note || '' : '';
  note.textContent = text;
  note.hidden = !text;
  note.title = text;

  if (info && info.status === 'connecting') {
    badge.className = 'badge wait';
    badge.textContent = `Obnovuji spojení k ${info.host}…`;
    return;
  }
  badge.className = `badge ${state.connected ? 'on' : 'off'}`;
  badge.textContent = state.connected && info
    ? `${info.protocol.toUpperCase()} · ${info.username ? `${info.username}@` : ''}${info.host}`
    : 'Odpojeno';
}

/* ------------------------------------------------------- editor relace */

const siteDlg = $('#dlg-site');
const siteForm = $('form', siteDlg); // .elements má formulář, ne dialog

function toggleProtocolFields() {
  const proto = siteForm.elements.protocol.value;
  $$('[data-when]', siteDlg).forEach((el) => { el.hidden = el.dataset.when !== proto; });
}

function openSiteDialog(site) {
  const f = siteForm.elements;
  siteDlg.dataset.id = site ? site.id : '';
  $('#dlg-site-title').textContent = site ? `Relace: ${site.name}` : 'Nová relace';
  f.name.value = site?.name || '';
  f.folder.value = site?.folder || '';
  f.protocol.value = site?.protocol || 'sftp';
  f.host.value = site?.host || '';
  f.port.value = site?.port || 22;
  f.username.value = site?.username || '';
  f.password.value = '';
  f.passphrase.value = '';
  f.ftps.value = site?.ftps || 'none';
  f.privateKeyPath.value = site?.privateKeyPath || '';
  f.remoteDir.value = site?.remoteDir || '';
  f.localDir.value = site?.localDir || state.local.path || '';
  f.useAgent.checked = Boolean(site?.useAgent);
  f.useRecycleBin.checked = site ? site.useRecycleBin !== false : true;
  f.recycleBinPath.value = site?.recycleBinPath || '';
  f.recycleBinDays.value = site?.recycleBinDays || '';
  f.encoding.value = site?.encoding || 'auto';
  f.timeShiftMinutes.value = site?.timeShiftMinutes || '';
  f.color.value = site?.color || '';
  f.note.value = site?.note || '';
  f.tunnelHost.value = site?.tunnelHost || '';
  f.tunnelPort.value = site?.tunnelPort || 22;
  f.tunnelUsername.value = site?.tunnelUsername || '';
  f.tunnelKeyPath.value = site?.tunnelKeyPath || '';
  f.tunnelPassword.value = '';
  f.tunnelPassword.placeholder = site?.hasTunnelPassword ? 'uloženo — nechte prázdné' : '';
  f.proxyType.value = site?.proxyType || 'none';
  f.proxyHost.value = site?.proxyHost || '';
  f.proxyPort.value = site?.proxyPort || '';
  f.proxyUsername.value = site?.proxyUsername || '';
  f.proxyPassword.value = '';
  f.proxyPassword.placeholder = site?.hasProxyPassword ? 'uloženo — nechte prázdné' : '';
  // Rozbalíme jen když se něco takového používá; jinak ať nepřekáží.
  $('#site-path').open = Boolean(site?.tunnelHost || (site?.proxyType && site.proxyType !== 'none'));
  $('#site-look').open = Boolean(site?.color || site?.note);
  f.acceptAnyCert.checked = site ? site.rejectUnauthorized === false : false;
  f.password.placeholder = site?.hasPassword ? 'uloženo — nechte prázdné' : '';
  f.passphrase.placeholder = site?.hasPassphrase ? 'uloženo — nechte prázdné' : '';
  toggleProtocolFields();
  siteDlg.showModal();
}

siteForm.elements.protocol.addEventListener('change', () => {
  const f = siteForm.elements;
  f.port.value = f.protocol.value === 'ftp' ? 21 : 22;
  toggleProtocolFields();
});

siteDlg.addEventListener('close', async () => {
  if (siteDlg.returnValue === 'cancel' || !siteDlg.returnValue) return;
  const f = siteForm.elements;
  const payload = {
    id: siteDlg.dataset.id || undefined,
    name: f.name.value.trim(),
    folder: f.folder.value.trim(),
    protocol: f.protocol.value,
    host: f.host.value.trim(),
    port: Number(f.port.value),
    username: f.username.value.trim(),
    ftps: f.ftps.value,
    privateKeyPath: f.privateKeyPath.value.trim(),
    remoteDir: f.remoteDir.value.trim(),
    localDir: f.localDir.value.trim(),
    useAgent: f.useAgent.checked,
    rejectUnauthorized: !f.acceptAnyCert.checked,
    useRecycleBin: f.useRecycleBin.checked,
    recycleBinPath: f.recycleBinPath.value.trim(),
    recycleBinDays: Number(f.recycleBinDays.value) || 0,
    encoding: f.encoding.value,
    timeShiftMinutes: Number(f.timeShiftMinutes.value) || 0,
    color: f.color.value,
    note: f.note.value.trim(),
    tunnelHost: f.tunnelHost.value.trim(),
    tunnelPort: Number(f.tunnelPort.value) || 22,
    tunnelUsername: f.tunnelUsername.value.trim(),
    tunnelKeyPath: f.tunnelKeyPath.value.trim(),
    proxyType: f.proxyType.value,
    proxyHost: f.proxyHost.value.trim(),
    proxyPort: Number(f.proxyPort.value) || 0,
    proxyUsername: f.proxyUsername.value.trim(),
  };
  // Prázdné heslo znamená "nech uložené" — proto ho posíláme jen když je vyplněné.
  if (f.password.value) payload.password = f.password.value;
  if (f.passphrase.value) payload.passphrase = f.passphrase.value;
  if (f.tunnelPassword.value) payload.tunnelPassword = f.tunnelPassword.value;
  if (f.proxyPassword.value) payload.proxyPassword = f.proxyPassword.value;

  const id = await call(window.api.sites.save(payload));
  if (!id) return;
  await refreshSites(id);
  $('#site-select').value = id;
  if (siteDlg.returnValue === 'connect') await connectSelected();
});

$('#pick-key').addEventListener('click', async () => {
  const p = await call(window.api.local.pickFile({ title: 'Vyberte privátní klíč', defaultPath: '~/.ssh' }));
  if (p) siteForm.elements.privateKeyPath.value = p;
});
$('#pick-tunnel-key').addEventListener('click', async () => {
  const p = await call(window.api.local.pickFile({ title: 'Vyberte klíč pro bránu', defaultPath: '~/.ssh' }));
  if (p) siteForm.elements.tunnelKeyPath.value = p;
});
$('#pick-local').addEventListener('click', async () => {
  const p = await call(window.api.local.pickDir());
  if (p) siteForm.elements.localDir.value = p;
});

/* ------------------------------------------------------ import z WinSCP */

const importDlg = $('#dlg-import');

function renderImport(data) {
  state.importData = data;
  const list = $('#import-list');
  const warn = $('#import-warning');

  if (data.masterPassword) {
    warn.hidden = false;
    warn.textContent = 'WinSCP má zapnuté Master Password — hesla jsou navíc zašifrovaná a nelze je odsud přečíst. '
      + 'Relace se naimportují bez hesel; buď je doplníte ručně, nebo ve WinSCP master heslo dočasně vypněte '
      + '(Options → Preferences → Security) a export zopakujte.';
  } else {
    warn.hidden = true;
  }

  const head = document.createElement('div');
  head.className = 'ir head';
  head.innerHTML = '<span></span><span>Název</span><span>Server</span><span>Protokol</span><span>Heslo</span><span>Poznámka</span>';

  const rows = data.sessions.map((s, i) => {
    const el = document.createElement('div');
    el.className = 'ir';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s.supported;
    cb.disabled = !s.supported;
    cb.dataset.index = String(i);

    // Poznámku si zdroj může určit sám (tak to dělá ~/.ssh/config);
    // u WinSCP ji skládáme z toho, co se nepodařilo přenést.
    const note = !s.supported
      ? `<span class="tag bad">${s.rawProtocol.toUpperCase()} nepodporován</span>`
      : s.note !== undefined
        ? (s.note ? `<span class="tag mk">${escapeHtml(s.note)}</span>` : '')
        : s.passwordFailed
          ? '<span class="tag bad">heslo nešlo přečíst</span>'
          : s.privateKeyPath
            ? '<span class="tag mk">klíč .ppk — doplnit ručně</span>'
            : '';

    el.appendChild(cb);
    const rest = document.createElement('span');
    rest.textContent = s.name;
    el.appendChild(rest);
    const hostEl = document.createElement('span');
    hostEl.textContent = `${s.username ? `${s.username}@` : ''}${s.host}:${s.port}`;
    el.appendChild(hostEl);
    const protoEl = document.createElement('span');
    protoEl.textContent = s.protocol.toUpperCase() + (s.ftps && s.ftps !== 'none' ? ` (${s.ftps})` : '');
    el.appendChild(protoEl);
    const pwEl = document.createElement('span');
    pwEl.textContent = s.password ? '✓ ano' : '—';
    el.appendChild(pwEl);
    const noteEl = document.createElement('span');
    noteEl.innerHTML = note;
    el.appendChild(noteEl);
    return el;
  });

  list.replaceChildren(head, ...rows);
  const usable = data.sessions.filter((s) => s.supported).length;
  $('#import-go').disabled = usable === 0;
  const pocet = `${data.total} ${plural(data.total, 'relace', 'relace', 'relací')}`;
  $('#import-hint').textContent = data.source === 'ssh'
    // Konfigurace OpenSSH hesla neobsahuje, tak jimi nemá smysl strašit.
    ? `Soubor: ${data.file} — nalezeno ${pocet}. Hesla tu nejsou; přihlašuje se klíčem,`
      + ' případně je doplňte u relace ručně.'
    : `Soubor: ${data.file} — nalezeno ${pocet}, `
      + `${usable} podporovaných, hesel přečteno: ${data.sessions.filter((s) => s.password).length}.`;
}

function openImport() {
  $('#import-list').replaceChildren();
  $('#import-go').disabled = true;
  $('#import-hint').textContent = 'Vyberte WinSCP.ini nebo .reg export z Windows.';
  $('#import-warning').hidden = true;
  $('#import-pick').hidden = false;
  $('#import-ssh-pick').hidden = true;
  importDlg.showModal();
}

/** Import z konfigurace OpenSSH — jiný zdroj, stejný dialog. */
async function openSshImport() {
  $('#import-list').replaceChildren();
  $('#import-go').disabled = true;
  $('#import-warning').hidden = true;
  $('#import-pick').hidden = true;
  $('#import-ssh-pick').hidden = false;
  importDlg.showModal();

  const data = await call(window.api.ssh.read());
  if (!data) return;
  if (!data.sessions.length) {
    $('#import-hint').textContent = `V ${data.file} žádné servery nejsou (nebo soubor neexistuje).`
      + ' Zkuste vybrat jiný soubor.';
    return;
  }
  renderImport(data);
}

$('#btn-import').addEventListener('click', () => {
  // Import je schovaný v nastavení; to musí nejdřív zmizet, jinak by se
  // dva dialogy překrývaly.
  setDlg.close();
  openImport();
});
$('#import-cancel').addEventListener('click', () => importDlg.close());
$('#import-ssh-pick').addEventListener('click', async () => {
  const data = await call(window.api.ssh.pick());
  if (data) renderImport(data);
});
$('#btn-import-ssh').addEventListener('click', () => {
  setDlg.close();
  openSshImport();
});
$('#import-pick').addEventListener('click', async () => {
  const data = await call(window.api.winscp.pick());
  if (data) renderImport(data);
});
$('#import-go').addEventListener('click', async () => {
  const picked = $$('#import-list input[type=checkbox]:checked')
    .map((cb) => state.importData.sessions[Number(cb.dataset.index)]);
  if (!picked.length) return;
  const r = await call(window.api.winscp.import(picked, $('#import-overwrite').checked));
  if (r) {
    setLog('ok', `Naimportováno ${r.added} ${plural(r.added, 'relace', 'relace', 'relací')} (přeskočeno ${r.skipped})`);
    await refreshSites();
    importDlg.close();
  }
});

/* ------------------------------------------------------- synchronizace */

const syncDlg = $('#dlg-sync');

/** Uložená relace, ke které patří aktivní záložka. */
function activeSite() {
  const s = active();
  const id = s && s.info && s.info.siteId;
  return id ? (state.sites || []).find((x) => x.id === id) || null : null;
}

/** Nastavení synchronizace, které si relace pamatuje z minula. */
function syncProfile() {
  const site = activeSite();
  return (site && site.sync) || null;
}

function openSync() {
  if (!state.connected) return setLog('error', 'Nejste připojeni');
  // Cesty berou panely — synchronizovat se má to, na co se člověk dívá.
  $('#sync-local').value = state.local.path;
  $('#sync-remote').value = state.remote.path;

  // Zbytek si relace pamatuje z minula; pořád dokola to naklikávat je otrava.
  const profil = syncProfile();
  if (profil) {
    $('#sync-direction').value = profil.direction || $('#sync-direction').value;
    $('#sync-criteria').value = profil.criteria || $('#sync-criteria').value;
    $('#sync-mask').value = profil.mask || '';
    $('#sync-delete').checked = Boolean(profil.deleteExtra);
    $('#sync-mode').value = profil.mode || 'diff';
    $('#sync-existing').checked = Boolean(profil.onlyExisting);
  } else if (!$('#sync-mask').value) {
    $('#sync-mask').value = state.settings.transferMask || '';
  }
  const site = activeSite();
  $('#sync-note').textContent = site
    ? `Nastavení se pamatuje u relace ${site.name}; cesty ne, ty berou panely.`
    : 'Jednorázové připojení — nastavení se nikam neuloží.';
  $('#sync-conflict-bar').hidden = true;
  $('#sync-result').replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Zatím neporovnáno.' }));
  $('#sync-apply').disabled = true;
  syncDlg.showModal();
  return undefined;
}

const ACTION_TAG = {
  upload: ['up', '↑ nahrát'], download: ['down', '↓ stáhnout'],
  mkdirRemote: ['mk', '+ složka (server)'], mkdirLocal: ['mk', '+ složka (lokál)'],
  deleteRemote: ['del', '× smazat server'], deleteLocal: ['del', '× do koše'],
  rmdirRemote: ['del', '× složka server'], conflict: ['conflict', '! konflikt'],
  touchRemote: ['mk', '⏱ čas na serveru'], touchLocal: ['mk', '⏱ čas lokálně'],
};

/** Jak se konflikt vyřeší; vybírá se u každého řádku zvlášť. */
const CONFLICT_CHOICES = [
  ['skip', 'přeskočit'],
  ['upload', '↑ nahrát lokální'],
  ['download', '↓ stáhnout ze serveru'],
];

$('#sync-compare').addEventListener('click', async () => {
  const btn = $('#sync-compare');
  btn.disabled = true;
  btn.textContent = 'Porovnávám…';

  // Nastavení si relace zapamatuje. Ukládáme při porovnání, ne až při
  // provedení — i porovnání samo je platný způsob, jak se sem chodit dívat.
  const site = activeSite();
  if (site) {
    const sync = {
      direction: $('#sync-direction').value,
      criteria: $('#sync-criteria').value,
      mask: $('#sync-mask').value.trim(),
      deleteExtra: $('#sync-delete').checked,
      mode: $('#sync-mode').value,
      onlyExisting: $('#sync-existing').checked,
    };
    await call(window.api.sites.saveSync(site.id, sync), { silent: true });
    site.sync = sync;   // ať to platí i bez načtení seznamu relací znovu
  }
  const res = await call(window.api.sync.compare(sid(), {
    localDir: $('#sync-local').value.trim(),
    remoteDir: $('#sync-remote').value.trim(),
    direction: $('#sync-direction').value,
    criteria: $('#sync-criteria').value,
    deleteExtra: $('#sync-delete').checked,
    mask: $('#sync-mask').value.trim(),
    mode: $('#sync-mode').value,
    onlyExisting: $('#sync-existing').checked,
  }));
  btn.disabled = false;
  btn.textContent = 'Porovnat';
  if (!res) return;

  state.syncActions = res.actions;
  const box = $('#sync-result');

  const maskNote = res.skipped
    ? ` Maska vynechala ${res.skipped} ${plural(res.skipped, 'položku', 'položky', 'položek')}.`
    : '';

  if (!res.actions.length) {
    box.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: `Nic k přenosu — ${res.localCount} lokálních a ${res.remoteCount} vzdálených `
        + `souborů je shodných.${maskNote}`,
    }));
    $('#sync-apply').disabled = true;
    return;
  }
  if (maskNote) setLog('warn', maskNote.trim());

  const head = document.createElement('div');
  head.className = 'sr head';
  head.innerHTML = '<span></span><span>Akce</span><span>Soubor</span><span>Velikost</span><span>Důvod</span>';

  const rows = res.actions.map((a, i) => {
    const el = document.createElement('div');
    el.className = 'sr';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = a.action !== 'conflict';
    cb.dataset.index = String(i);
    el.appendChild(cb);

    const [cls, label] = ACTION_TAG[a.action] || ['', a.action];
    const tag = document.createElement('span');
    tag.innerHTML = `<span class="tag ${cls}"></span>`;
    tag.firstChild.textContent = label;
    el.appendChild(tag);

    const nameEl = document.createElement('span');
    nameEl.textContent = a.rel;
    nameEl.title = a.rel;
    el.appendChild(nameEl);

    const sizeEl = document.createElement('span');
    sizeEl.textContent = a.size ? fmtSize(a.size) : '';
    el.appendChild(sizeEl);

    const whyEl = document.createElement('span');
    if (a.action === 'conflict') {
      // U konfliktu se nedá rozhodnout za uživatele — obě strany se liší
      // a čas nenapoví. Nabídneme volbu rovnou v řádku.
      const sel = document.createElement('select');
      sel.className = 'conflict-pick';
      sel.dataset.index = String(i);
      for (const [value, label] of CONFLICT_CHOICES) {
        sel.appendChild(Object.assign(document.createElement('option'), { value, textContent: label }));
      }
      sel.value = a.resolve || 'skip';
      sel.title = `${a.why}\nlokálně ${fmtSize(a.localSize)} · ${fmtDate(a.localMtime) || '?'}`
        + `\nna serveru ${fmtSize(a.remoteSize)} · ${fmtDate(a.remoteMtime) || '?'}`;
      sel.addEventListener('change', () => {
        state.syncActions[i].resolve = sel.value;
        cb.checked = sel.value !== 'skip';
      });
      whyEl.appendChild(sel);
    } else {
      whyEl.textContent = a.why || '';
    }
    el.appendChild(whyEl);
    return el;
  });

  box.replaceChildren(head, ...rows);

  // Lišta na hromadné rozhodnutí — u dvaceti konfliktů by klikání po jednom
  // bylo trápení.
  const konflikty = res.actions.filter((a) => a.action === 'conflict').length;
  $('#sync-conflict-bar').hidden = konflikty === 0;
  $('#sync-conflict-count').textContent = konflikty
    ? `${konflikty} ${plural(konflikty, 'konflikt', 'konflikty', 'konfliktů')} — rozhodněte, která strana vyhraje:`
    : '';

  $('#sync-apply').disabled = false;
});

/** Vyřeší všechny konflikty naráz jedním směrem. */
function resolveAllConflicts(volba) {
  for (const sel of $$('#sync-result .conflict-pick')) {
    sel.value = volba;
    sel.dispatchEvent(new Event('change'));
  }
}
$('#sync-all-local').addEventListener('click', () => resolveAllConflicts('upload'));
$('#sync-all-remote').addEventListener('click', () => resolveAllConflicts('download'));

$('#sync-cancel').addEventListener('click', () => syncDlg.close());
$('#sync-apply').addEventListener('click', async () => {
  const picked = $$('#sync-result input[type=checkbox]:checked')
    .map((cb) => state.syncActions[Number(cb.dataset.index)])
    // Rozhodnutý konflikt je od téhle chvíle obyčejný přenos; nerozhodnutý
    // se nedělá, i kdyby byl zaškrtnutý.
    .map((a) => (a.action === 'conflict' && a.resolve && a.resolve !== 'skip'
      ? { ...a, action: a.resolve, size: a.resolve === 'upload' ? a.localSize : a.remoteSize }
      : a))
    .filter((a) => a.action !== 'conflict');
  if (!picked.length) return;
  const destructive = picked.filter((a) => a.action.startsWith('delete') || a.action === 'rmdirRemote');
  if (destructive.length && !window.confirm(`Součástí je ${destructive.length} mazání. Pokračovat?`)) return;

  const r = await call(window.api.sync.apply(sid(), picked));
  if (r) {
    const casy = r.touched ? `, srovnáno ${r.touched} ${plural(r.touched, 'razítko', 'razítka', 'razítek')} času` : '';
    setLog(r.failed ? 'warn' : 'ok',
      `Synchronizace: ${r.transfers} ${plural(r.transfers, 'přenos', 'přenosy', 'přenosů')} zařazeno${casy}`
      + (r.failed ? `, ${r.failed} × se čas srovnat nepodařilo` : ''));
    syncDlg.close();
    await loadPane('remote', state.remote.path);
    await loadPane('local', state.local.path);
  }
});

/* ------------------------------------------------------- fronta přenosů */

function renderQueue(snap) {
  state.queue = snap;
  const body = $('#queue-body');
  const visible = snap.items.slice(-200); // starší položky nemá smysl kreslit

  body.replaceChildren(...visible.map((it) => {
    const el = document.createElement('div');
    el.className = `q-item ${it.status}`;
    const pct = it.size ? Math.min(100, (it.transferred / it.size) * 100) : (it.status === 'done' ? 100 : 0);

    const icon = document.createElement('span');
    icon.textContent = it.direction === 'up' ? '↑' : '↓';

    const p = document.createElement('span');
    p.className = 'q-path';
    const bdi = document.createElement('bdi');
    bdi.textContent = it.direction === 'up' ? it.remotePath : it.localPath;
    p.appendChild(bdi);
    p.title = `${it.localPath}  ⇄  ${it.remotePath}`;

    const bar = document.createElement('span');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);

    const size = document.createElement('span');
    size.className = 'q-num';
    size.textContent = it.status === 'error' ? '' : `${fmtSize(it.transferred)} / ${fmtSize(it.size)}`;

    const rate = document.createElement('span');
    rate.className = it.status === 'error' ? 'q-err' : it.speedLimit ? 'q-num q-limited' : 'q-num';
    rate.textContent = it.status === 'error' ? it.error
      : it.status === 'active' ? fmtSpeed(it.speed)
        : ({
          done: 'hotovo', paused: it.held ? 'pozastaveno ručně' : 'pauza',
          canceled: 'zrušeno', pending: 'čeká',
          skipped: it.note ? `přeskočeno — ${it.note}` : 'přeskočeno',
        })[it.status] || '';
    rate.title = it.error || '';

    // Pravým tlačítkem na položku se dá omezit rychlost jen jí.
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const kb = it.speedLimit ? Math.round(it.speedLimit / 1024) : 0;
      const ceka = it.status === 'pending';
      const bezi = it.status === 'active';
      openMenu([
        // Řadit má smysl jen u čekajících — běžící přenos přeskočit nejde.
        ...(ceka ? [
          { label: '⤒ Provést hned', fn: () => window.api.queue.move(sid(), it.id, 'top') },
          { label: '↑ Posunout nahoru', fn: () => window.api.queue.move(sid(), it.id, 'up') },
          { label: '↓ Posunout dolů', fn: () => window.api.queue.move(sid(), it.id, 'down') },
          null,
        ] : []),
        ...(ceka || bezi
          ? [{ label: '❙❙ Pozastavit tuhle položku', fn: () => window.api.queue.hold(sid(), it.id) }]
          : []),
        ...(it.status === 'paused'
          ? [{ label: '▶ Pokračovat v této položce', fn: () => window.api.queue.release(sid(), it.id) }]
          : []),
        null,
        {
          label: kb ? `Změnit limit (nyní ${kb} kB/s)…` : 'Omezit rychlost této položky…',
          fn: () => askItemSpeed(it),
        },
        ...(kb ? [{ label: 'Zrušit limit položky', fn: () => window.api.queue.speedLimit(sid(), it.id, 0) }] : []),
        null,
        { label: 'Omezit rychlost všech přenosů…', fn: () => askGlobalSpeed() },
      ], ev.clientX, ev.clientY);
    });

    const x = document.createElement('button');
    x.className = 'q-x';
    x.textContent = ['error', 'canceled'].includes(it.status) ? '⟳' : '✕';
    x.title = ['error', 'canceled'].includes(it.status) ? 'Zkusit znovu' : 'Zrušit';
    x.addEventListener('click', () => {
      if (['error', 'canceled'].includes(it.status)) window.api.queue.retry(sid(), it.id);
      else window.api.queue.cancel(sid(), it.id);
    });

    el.append(icon, p, bar, size, rate, x);
    return el;
  }));

  const pct = snap.totalBytes ? Math.round((snap.doneBytes / snap.totalBytes) * 100) : 0;
  const running = snap.active > 1 ? ` · ${snap.active} naráz` : '';
  // Odhad ukazujeme, jen když je z čeho počítat. Když u některé položky neznáme
  // velikost, řekneme to — je to poctivější než odhad, který nemůže vyjít.
  const eta = snap.eta ? ` · zbývá ~${fmtEta(snap.eta)}` : '';
  const nejasne = snap.unknownSizes
    ? ` · ${snap.unknownSizes} ${plural(snap.unknownSizes, 'položka neznámé velikosti', 'položky neznámé velikosti', 'položek neznámé velikosti')}`
    : '';
  $('#queue-summary').textContent = snap.pending
    ? `${snap.pending} ve frontě · ${fmtSize(snap.doneBytes)} / ${fmtSize(snap.totalBytes)} (${pct} %)`
      + `${eta}${running}${nejasne}${snap.paused ? ' · pozastaveno' : ''}`
    : (snap.items.length ? 'hotovo' : 'prázdná');

  const limit = snap.speedLimit ? ` (strop ${fmtSize(snap.speedLimit)}/s)` : '';
  $('#queue-speed').textContent = snap.speed ? `${fmtSpeed(snap.speed)}${limit}` : limit.trim();
  $('#q-pause').hidden = snap.paused;
  $('#q-resume').hidden = !snap.paused;
}

async function askItemSpeed(item) {
  const cur = item.speedLimit ? String(Math.round(item.speedLimit / 1024)) : '';
  const v = await promptDialog('Limit rychlosti položky', 'kB/s (0 = bez omezení)', cur);
  if (v === null) return;
  await call(window.api.queue.speedLimit(sid(), item.id, Number(v) || 0));
}

async function askGlobalSpeed() {
  const cur = state.settings.speedLimitKb ? String(state.settings.speedLimitKb) : '';
  const v = await promptDialog('Limit rychlosti všech přenosů', 'kB/s (0 = bez omezení)', cur);
  if (v === null) return;
  const kb = Math.max(0, Number(v) || 0);
  await call(window.api.queue.speedLimit(sid(), null, kb));
  state.settings = { ...state.settings, speedLimitKb: kb };
  setLog('ok', kb ? `Rychlost omezena na ${kb} kB/s` : 'Omezení rychlosti zrušeno');
}

$('#q-pause').addEventListener('click', () => window.api.queue.pause(sid()));
$('#q-resume').addEventListener('click', () => window.api.queue.resume(sid()));
$('#q-cancel').addEventListener('click', () => window.api.queue.cancelAll(sid()));
$('#q-clear').addEventListener('click', () => window.api.queue.clear(sid()));
$('#q-toggle').addEventListener('click', () => {
  const q = $('#queue');
  q.classList.toggle('collapsed');
  $('#q-toggle').textContent = q.classList.contains('collapsed') ? '▸' : '▾';
});

/* ------------------------------------------------------------ nastavení */

const setDlg = $('#dlg-settings');
const setForm = $('form', setDlg);

$('#btn-settings').addEventListener('click', () => {
  const f = setForm.elements;
  const cur = { ...DEFAULT_SETTINGS, ...state.settings };
  f.editor.value = cur.editor;
  f.transferMask.value = cur.transferMask || '';
  f.maxConcurrent.value = cur.maxConcurrent || 3;
  f.speedLimitKb.value = cur.speedLimitKb || 0;
  f.tempName.checked = cur.tempName !== false;
  f.cacheListings.checked = cur.cacheListings !== false;
  f.tempNameMinKb.value = cur.tempNameMinKb || 0;
  f.doubleClick.value = cur.doubleClick;
  f.theme.value = cur.theme || 'system';
  f.uploadPerms.value = cur.uploadPerms || 'keep';
  f.uploadFileMode.value = cur.uploadFileMode || '';
  f.uploadDirMode.value = cur.uploadDirMode || '';
  f.typeAhead.checked = cur.typeAhead !== false;
  f.colOwner.checked = Boolean(cur.colOwner);
  f.colGroup.checked = Boolean(cur.colGroup);
  setDlg.showModal();
});

setDlg.addEventListener('close', async () => {
  if (setDlg.returnValue !== 'save') return;
  const f = setForm.elements;
  const saved = await call(window.api.settings.set({
    editor: f.editor.value.trim(),
    transferMask: f.transferMask.value.trim(),
    maxConcurrent: Math.max(1, Math.min(16, Number(f.maxConcurrent.value) || 1)),
    speedLimitKb: Math.max(0, Number(f.speedLimitKb.value) || 0),
    tempName: f.tempName.checked,
    cacheListings: f.cacheListings.checked,
    tempNameMinKb: Math.max(0, Number(f.tempNameMinKb.value) || 0),
    doubleClick: f.doubleClick.value,
    theme: f.theme.value,
    uploadPerms: f.uploadPerms.value,
    uploadFileMode: f.uploadFileMode.value.trim(),
    uploadDirMode: f.uploadDirMode.value.trim(),
    typeAhead: f.typeAhead.checked,
    colOwner: f.colOwner.checked,
    colGroup: f.colGroup.checked,
  }));
  if (saved) applySettings(saved);
});

function applySettings(next) {
  state.settings = { ...DEFAULT_SETTINGS, ...next };
  $('#app').classList.toggle('c-owner', Boolean(state.settings.colOwner));
  $('#app').classList.toggle('c-group', Boolean(state.settings.colGroup));
  applyTheme(state.settings.theme);
}

/**
 * Nastaví motiv.
 *
 * „Podle systému" se pozná tak, že na <html> není nic — pak rozhoduje
 * color-scheme: light dark a systémové nastavení. Vlastní volba ho přebije.
 */
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

/* ----------------------------------------------------------- rozdělovač */

(function wireSplitter() {
  const sp = $('#splitter');
  let dragging = false;
  sp.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const total = $('.panes').getBoundingClientRect();
    const ratio = Math.min(0.8, Math.max(0.2, (e.clientX - total.left) / total.width));
    panes.local.style.flex = `1 1 ${ratio * 100}%`;
    panes.remote.style.flex = `1 1 ${(1 - ratio) * 100}%`;
  });
  window.addEventListener('mouseup', () => { dragging = false; });
}());

/* ------------------------------------------------------------- toolbar */

$('#btn-connect').addEventListener('click', connectSelected);
$('#btn-new-site').addEventListener('click', () => openSiteDialog(null));
$('#btn-edit-site').addEventListener('click', () => {
  const s = state.sites.find((x) => x.id === $('#site-select').value);
  if (s) openSiteDialog(s); else setLog('error', 'Nejdřív vyberte relaci');
});
async function deleteSelectedSite() {
  const s = state.sites.find((x) => x.id === $('#site-select').value);
  if (!s) return setLog('error', 'Nejdřív vyberte relaci');
  if (!window.confirm(`Smazat relaci „${s.name}"?`)) return undefined;
  await call(window.api.sites.remove(s.id));
  if (sitesUi.selected === s.id) sitesUi.selected = null;
  $('#site-select').value = '';
  await refreshSites();
  return undefined;
}
$('#btn-del-site').addEventListener('click', deleteSelectedSite);
$('#btn-refresh').addEventListener('click', async () => {
  // Ruční obnovení jde vždycky na server, uložený výpis se přeskočí.
  await loadPane('local', state.local.path);
  if (state.connected) await loadPane('remote', state.remote.path, { refresh: true });
});
$('#btn-sync').addEventListener('click', openSync);
$('#site-select').addEventListener('dblclick', connectSelected);

/* --------------------------------------------------------------- start */

window.api.onSessions((list) => {
  for (const info of list) {
    const s = state.sessions.get(info.id);
    if (s) s.info = info;
  }
  renderTabs();
});

window.api.onConn(({ sid: id, payload }) => {
  const s = state.sessions.get(id);
  if (!s) return;
  s.info = payload;
  renderTabs();
});

window.api.onAsk(askConflict);
window.api.onAskEdit(askEditConflict);

window.api.onQueue(({ sid: id, payload }) => {
  const s = state.sessions.get(id);
  if (!s) return;
  s.queue = payload;
  // Záložka vzadu jen přepočítá odznak, kreslit její frontu nemá smysl.
  if (id === state.activeId) renderQueue(payload);
  else renderTabs();
});
window.api.onLog(({ level, text }) => setLog(level, text));

window.api.onEdit(({ sid: id, payload }) => {
  const s = state.sessions.get(id);
  if (!s) return;
  s.editing = payload;
  if (id === state.activeId) updateEditStatus();
});

function updateEditStatus() {
  const list = state.editing || [];
  $('#edit-status').textContent = list.length
    ? `✎ ${list.length} otevřeno v editoru (${list.filter((e) => e.status === 'uploading').length} se nahrává)`
    : '';
}
window.api.onMenu(async (cmd) => {
  if (cmd === 'connect') connectSelected();
  else if (cmd === 'closetab') { if (state.activeId) closeTab(state.activeId); }
  else if (cmd === 'nexttab') cycleTab(1);
  else if (cmd === 'prevtab') cycleTab(-1);
  else if (cmd === 'import') openImport();
  else if (cmd === 'sync') openSync();
  else if (cmd === 'emptytrash') emptyRemoteTrash();
  else if (cmd === 'find') openFind();
  else if (cmd === 'watch') openWatch();
  else if (cmd === 'console') openConsole();
  else if (cmd === 'commands') openCommands();
  else if (cmd === 'workspaces') openWorkspaces();
  else if (cmd === 'sites') openSites();
  else if (cmd === 'refresh') $('#btn-refresh').click();
});

(async function init() {
  wirePane('local');
  wirePane('remote');
  applySettings(await call(window.api.settings.get()) || {});
  await refreshSites();
  renderTabs();
  await loadPane('local', await call(window.api.local.home()));
  renderQueue(state.queue);
  setActive('local');
}());
