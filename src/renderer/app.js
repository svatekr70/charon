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

const state = {
  sites: [],
  connected: false,
  local: newPane(false),
  remote: newPane(true),
  activeSide: 'local',
  queue: { items: [], paused: false },
  editing: [],
  settings: {},
  trash: { enabled: false, path: '' },
  importData: null,
  syncActions: [],
};

/** Výchozí nastavení; hlavní proces posílá jen to, co je uložené. */
const DEFAULT_SETTINGS = {
  editor: '', doubleClick: 'edit', typeAhead: true, colOwner: false, colGroup: false,
  transferMask: '',
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
async function loadPane(side, targetPath, { fromHistory = false } = {}) {
  const api = side === 'local' ? window.api.local : window.api.remote;
  const data = await call(api.list(targetPath));
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
    else if (act === 'home') await loadPane('remote', await call(window.api.remote.home()));
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
    renderPane(side);
  });

  listEl.addEventListener('dblclick', async (ev) => {
    const row = ev.target.closest('.row');
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
        renderPane(side);
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
      renderPane(side);
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
      const r = await call(window.api.transfer.upload(files, state.remote.path));
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

    const r = await call(window.api.transfer.move(items, targetDir, from, mask));
    if (r) setLog('ok', `K přesunu zařazeno ${r.count} ${plural(r.count, 'soubor', 'soubory', 'souborů')}`);
    return undefined;
  }

  const r = from === 'local'
    ? await call(window.api.transfer.upload(items, targetDir, mask))
    : await call(window.api.transfer.download(items, targetDir, mask));
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
    const toTrash = side === 'local' || state.trash.enabled;
    items.push({
      label: `${toTrash ? 'Smazat do koše' : 'Smazat'} ${sel.length > 1 ? `(${sel.length})` : ''}`,
      key: '⌫',
      fn: () => deleteSelected(side),
    });
    if (toTrash) {
      items.push({ label: 'Smazat natrvalo', key: '⇧⌫', fn: () => deleteSelected(side, true) });
    }
    if (side === 'remote' && sel.length === 1) {
      items.push({ label: 'Změnit práva…', fn: () => chmodSelected(side) });
    }
    items.push(null);
  }

  items.push({ label: 'Nová složka…', key: 'F7', fn: () => mkdirIn(side) });
  items.push({ label: 'Vybrat podle masky…', key: '+', fn: () => selectByMask(side, true) });
  items.push({ label: 'Odznačit podle masky…', key: '−', fn: () => selectByMask(side, false) });
  items.push({
    label: state[side].filterText ? 'Zrušit filtr' : 'Filtrovat…',
    fn: () => toggleFilter(side),
  });
  items.push({ label: 'Obnovit', key: '⌘R', fn: () => loadPane(side, state[side].path) });
  items.push({
    label: state[side].showHidden ? 'Skrýt skryté soubory' : 'Zobrazit skryté soubory',
    fn: () => { state[side].showHidden = !state[side].showHidden; renderPane(side); },
  });
  if (side === 'remote') {
    items.push({ label: '🔍 Najít soubory…', key: '⌘F', fn: () => openFind() });
    items.push({ label: '⇅ Synchronizovat tuto složku…', fn: () => openSync() });
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
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
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
  const api = side === 'local' ? window.api.local : window.api.remote;
  if (await call(api.mkdir(target)) !== null) await loadPane(side, state[side].path);
}

async function renameSelected(side) {
  const [entry] = selectedEntries(side);
  if (!entry) return;
  const name = await promptDialog('Přejmenovat', 'Nový název', entry.name);
  if (!name || name === entry.name) return;
  const from = fullPath(side, entry);
  const to = side === 'local' ? localJoin(state.local.path, name) : posixJoin(state.remote.path, name);
  const api = side === 'local' ? window.api.local : window.api.remote;
  if (await call(api.rename(from, to)) !== null) await loadPane(side, state[side].path);
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
    : await call(window.api.remote.remove(paths, permanent));
  if (res === null) return;

  const n = sel.length;
  setLog('ok', `${res && res.toTrash ? 'Přesunuto do koše na serveru' : 'Smazáno'}: `
    + `${n} ${plural(n, 'položka', 'položky', 'položek')}`);
  await loadPane(side, state[side].path);
}

async function emptyRemoteTrash() {
  if (!state.trash.enabled) return setLog('error', 'Koš na serveru není u této relace zapnutý');
  const info = await call(window.api.trash.info());
  if (!info || !info.days.length) return setLog('ok', 'Koš na serveru je prázdný');
  if (!window.confirm(`Nevratně smazat obsah koše na serveru? Obsahuje ${info.days.length} `
    + `${plural(info.days.length, 'den', 'dny', 'dnů')} mazání (${info.path}).`)) return undefined;
  await call(window.api.trash.empty());
  await loadPane('remote', state.remote.path);
  return undefined;
}

async function chmodSelected(side) {
  const [entry] = selectedEntries(side);
  if (!entry) return;
  const v = await promptDialog('Změnit práva', 'Osmičkově, např. 644', fmtPerm(entry.mode) || '644');
  if (!v) return;
  const mode = parseInt(v, 8);
  if (Number.isNaN(mode)) return setLog('error', 'Neplatná hodnota práv');
  if (await call(window.api.remote.chmod(fullPath(side, entry), mode)) !== null) {
    await loadPane('remote', state.remote.path);
  }
  return undefined;
}

async function editRemote(remotePath) {
  setLog('warn', `Otevírám ${remotePath}…`);
  const r = await call(window.api.edit.open(remotePath));
  if (r) setLog('ok', `${remotePath} — změny se budou nahrávat automaticky`);
}

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

  const res = await call(window.api.find.start({
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

$('#find-stop').addEventListener('click', () => window.api.find.cancel());
$('#find-close').addEventListener('click', () => { window.api.find.cancel(); findDlg.close(); });

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
  const r = await call(window.api.transfer.download(items, state.local.path));
  if (r) {
    setLog('ok', `Zařazeno ${r.count} ${plural(r.count, 'soubor', 'soubory', 'souborů')} ke stažení`);
    findDlg.close();
  }
  return undefined;
});

window.api.onFind((msg) => {
  if (msg.hit) {
    findState.hits.push(msg.hit);
    // Překreslujeme po dávkách, jinak by se u tisíců nálezů okno zadrhlo.
    if (findState.hits.length <= 500 && findState.hits.length % 25 === 0) renderFindResults();
  }
  if (msg.done) renderFindResults();
  else if (msg.scanned) $('#find-status').textContent = `Hledám… prohledáno ${msg.scanned}, nalezeno ${findState.hits.length}`;
});

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
}

async function refreshTrashInfo() {
  // Nekontrolujeme state.connected — ten se nastavuje až z události „conn",
  // která může dorazit po odpovědi na připojení. Hlavní proces si stejně
  // ohlídá, že bez spojení vrátí vypnuto.
  const info = await call(window.api.trash.info(), { silent: true });
  state.trash = info && info.enabled ? { enabled: true, path: info.path } : { enabled: false, path: '' };
}

async function connectSelected() {
  const id = $('#site-select').value;
  if (!id) return setLog('error', 'Nejdřív vyberte relaci');
  $('#conn-status').className = 'badge wait';
  $('#conn-status').textContent = 'Připojuji…';
  const r = await call(window.api.conn.connect({ siteId: id }));
  if (!r) {
    $('#conn-status').className = 'badge off';
    $('#conn-status').textContent = 'Odpojeno';
    return undefined;
  }
  await refreshTrashInfo();
  await loadPane('remote', r.home);
  if (r.localDir) await loadPane('local', r.localDir);
  return undefined;
}

function applyConnState(connected, site) {
  state.connected = connected;
  $('#btn-connect').hidden = connected;
  $('#btn-disconnect').hidden = !connected;
  const badge = $('#conn-status');
  badge.className = `badge ${connected ? 'on' : 'off'}`;
  badge.textContent = connected && site
    ? `${site.protocol.toUpperCase()} · ${site.username ? `${site.username}@` : ''}${site.host}`
    : 'Odpojeno';
  if (!connected) {
    state.trash = { enabled: false, path: '' };
    state.remote.entries = [];
    state.remote.path = '';
    $('[data-role=path]', panes.remote).value = '';
    renderPane('remote');
  }
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
  };
  // Prázdné heslo znamená "nech uložené" — proto ho posíláme jen když je vyplněné.
  if (f.password.value) payload.password = f.password.value;
  if (f.passphrase.value) payload.passphrase = f.passphrase.value;

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

    const note = !s.supported
      ? `<span class="tag bad">${s.rawProtocol.toUpperCase()} nepodporován</span>`
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
    protoEl.textContent = s.protocol.toUpperCase() + (s.ftps !== 'none' ? ` (${s.ftps})` : '');
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
  $('#import-hint').textContent = `Soubor: ${data.file} — nalezeno ${data.total} ${plural(data.total, 'relace', 'relace', 'relací')}, `
    + `${usable} podporovaných, hesel přečteno: ${data.sessions.filter((s) => s.password).length}.`;
}

$('#btn-import').addEventListener('click', () => {
  $('#import-list').replaceChildren();
  $('#import-go').disabled = true;
  importDlg.showModal();
});
$('#import-cancel').addEventListener('click', () => importDlg.close());
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

function openSync() {
  if (!state.connected) return setLog('error', 'Nejste připojeni');
  $('#sync-local').value = state.local.path;
  $('#sync-remote').value = state.remote.path;
  if (!$('#sync-mask').value) $('#sync-mask').value = state.settings.transferMask || '';
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
};

$('#sync-compare').addEventListener('click', async () => {
  const btn = $('#sync-compare');
  btn.disabled = true;
  btn.textContent = 'Porovnávám…';
  const res = await call(window.api.sync.compare({
    localDir: $('#sync-local').value.trim(),
    remoteDir: $('#sync-remote').value.trim(),
    direction: $('#sync-direction').value,
    criteria: $('#sync-criteria').value,
    deleteExtra: $('#sync-delete').checked,
    mask: $('#sync-mask').value.trim(),
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
    whyEl.textContent = a.why || '';
    el.appendChild(whyEl);
    return el;
  });

  box.replaceChildren(head, ...rows);
  $('#sync-apply').disabled = false;
});

$('#sync-cancel').addEventListener('click', () => syncDlg.close());
$('#sync-apply').addEventListener('click', async () => {
  const picked = $$('#sync-result input[type=checkbox]:checked')
    .map((cb) => state.syncActions[Number(cb.dataset.index)]);
  if (!picked.length) return;
  const destructive = picked.filter((a) => a.action.startsWith('delete') || a.action === 'rmdirRemote');
  if (destructive.length && !window.confirm(`Součástí je ${destructive.length} mazání. Pokračovat?`)) return;

  const r = await call(window.api.sync.apply(picked));
  if (r) {
    setLog('ok', `Synchronizace: ${r.transfers} ${plural(r.transfers, 'přenos', 'přenosy', 'přenosů')} zařazeno`);
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
    rate.className = it.status === 'error' ? 'q-err' : 'q-num';
    rate.textContent = it.status === 'error' ? it.error
      : it.status === 'active' ? fmtSpeed(it.speed)
        : ({
          done: 'hotovo', paused: 'pauza', canceled: 'zrušeno', pending: 'čeká',
          skipped: it.note ? `přeskočeno — ${it.note}` : 'přeskočeno',
        })[it.status] || '';
    rate.title = it.error || '';

    const x = document.createElement('button');
    x.className = 'q-x';
    x.textContent = ['error', 'canceled'].includes(it.status) ? '⟳' : '✕';
    x.title = ['error', 'canceled'].includes(it.status) ? 'Zkusit znovu' : 'Zrušit';
    x.addEventListener('click', () => {
      if (['error', 'canceled'].includes(it.status)) window.api.queue.retry(it.id);
      else window.api.queue.cancel(it.id);
    });

    el.append(icon, p, bar, size, rate, x);
    return el;
  }));

  const pct = snap.totalBytes ? Math.round((snap.doneBytes / snap.totalBytes) * 100) : 0;
  $('#queue-summary').textContent = snap.pending
    ? `${snap.pending} ve frontě · ${fmtSize(snap.doneBytes)} / ${fmtSize(snap.totalBytes)} (${pct} %)${snap.paused ? ' · pozastaveno' : ''}`
    : (snap.items.length ? 'hotovo' : 'prázdná');
  $('#q-pause').hidden = snap.paused;
  $('#q-resume').hidden = !snap.paused;
}

$('#q-pause').addEventListener('click', () => window.api.queue.pause());
$('#q-resume').addEventListener('click', () => window.api.queue.resume());
$('#q-cancel').addEventListener('click', () => window.api.queue.cancelAll());
$('#q-clear').addEventListener('click', () => window.api.queue.clear());
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
  f.doubleClick.value = cur.doubleClick;
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
    doubleClick: f.doubleClick.value,
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
$('#btn-disconnect').addEventListener('click', () => window.api.conn.disconnect());
$('#btn-new-site').addEventListener('click', () => openSiteDialog(null));
$('#btn-edit-site').addEventListener('click', () => {
  const s = state.sites.find((x) => x.id === $('#site-select').value);
  if (s) openSiteDialog(s); else setLog('error', 'Nejdřív vyberte relaci');
});
$('#btn-del-site').addEventListener('click', async () => {
  const s = state.sites.find((x) => x.id === $('#site-select').value);
  if (!s) return setLog('error', 'Nejdřív vyberte relaci');
  if (!window.confirm(`Smazat relaci „${s.name}"?`)) return undefined;
  await call(window.api.sites.remove(s.id));
  await refreshSites();
  return undefined;
});
$('#btn-refresh').addEventListener('click', async () => {
  await loadPane('local', state.local.path);
  if (state.connected) await loadPane('remote', state.remote.path);
});
$('#btn-sync').addEventListener('click', openSync);
$('#site-select').addEventListener('dblclick', connectSelected);

/* --------------------------------------------------------------- start */

window.api.onConn(({ status, site }) => {
  if (status === 'connected') applyConnState(true, site);
  else if (status === 'disconnected') applyConnState(false, null);
});
window.api.onAsk(askConflict);
window.api.onQueue(renderQueue);
window.api.onLog(({ level, text }) => setLog(level, text));
window.api.onEdit((list) => {
  state.editing = list;
  $('#edit-status').textContent = list.length
    ? `✎ ${list.length} otevřeno v editoru (${list.filter((e) => e.status === 'uploading').length} se nahrává)`
    : '';
});
window.api.onMenu(async (cmd) => {
  if (cmd === 'connect') connectSelected();
  else if (cmd === 'disconnect') window.api.conn.disconnect();
  else if (cmd === 'import') $('#btn-import').click();
  else if (cmd === 'sync') openSync();
  else if (cmd === 'emptytrash') emptyRemoteTrash();
  else if (cmd === 'find') openFind();
  else if (cmd === 'refresh') $('#btn-refresh').click();
});

(async function init() {
  wirePane('local');
  wirePane('remote');
  applySettings(await call(window.api.settings.get()) || {});
  await refreshSites();
  await loadPane('local', await call(window.api.local.home()));
  renderQueue(await call(window.api.queue.snapshot()) || { items: [], pending: 0, totalBytes: 0, doneBytes: 0, paused: false });
  setActive('local');
}());
