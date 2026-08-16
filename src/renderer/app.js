'use strict';

/* ------------------------------------------------------------------ stav */

const state = {
  sites: [],
  connected: false,
  local: { path: '', entries: [], sel: new Set(), cursor: -1, sort: { key: 'name', dir: 1 }, showHidden: false },
  remote: { path: '', entries: [], sel: new Set(), cursor: -1, sort: { key: 'name', dir: 1 }, showHidden: true },
  activeSide: 'local',
  queue: { items: [], paused: false },
  editing: [],
  settings: {},
  trash: { enabled: false, path: '' },
  importData: null,
  syncActions: [],
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

async function loadPane(side, targetPath) {
  const api = side === 'local' ? window.api.local : window.api.remote;
  const data = await call(api.list(targetPath));
  if (!data) return;
  const st = state[side];
  st.path = data.path;
  st.entries = data.entries;
  st.sel.clear();
  st.cursor = -1;
  $('[data-role=path]', panes[side]).value = data.path;
  renderPane(side);
}

function sortedEntries(side) {
  const st = state[side];
  const list = st.entries.filter((e) => (side === 'local' && !st.showHidden ? !e.hidden : true));
  const { key, dir } = st.sort;
  return list.sort((a, b) => {
    // Adresáře vždy nahoře, jako ve WinSCP.
    if ((a.type === 'd') !== (b.type === 'd')) return a.type === 'd' ? -1 : 1;
    let r = 0;
    if (key === 'size') r = (a.size || 0) - (b.size || 0);
    else if (key === 'date') r = (a.mtime || 0) - (b.mtime || 0);
    else r = a.name.localeCompare(b.name, 'cs', { numeric: true });
    return r * dir;
  });
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
    row.className = `row ${e.type === 'd' ? 'dir' : e.type === 'l' ? 'link' : ''}${e.hidden ? ' hidden-file' : ''}`;
    row.dataset.index = String(i);
    row.draggable = true;
    if (st.sel.has(e.name)) row.classList.add('sel');
    row.innerHTML = `<span class="name"></span><span class="size">${e.type === 'd' ? '' : fmtSize(e.size)}</span>`
      + `<span class="date">${fmtDate(e.mtime)}</span><span class="perm">${fmtPerm(e.mode)}</span>`;
    row.firstChild.textContent = e.name; // textContent kvůli názvům s < >
    frag.appendChild(row);
  });

  listEl.replaceChildren(frag);
  updateFoot(side);
}

function updateFoot(side) {
  const st = state[side];
  const files = st.view ? st.view.filter((e) => e.type !== 'd') : [];
  const selBytes = (st.view || []).filter((e) => st.sel.has(e.name)).reduce((a, e) => a + (e.size || 0), 0);
  const total = files.reduce((a, e) => a + (e.size || 0), 0);
  const dirs = (st.view || []).filter((e) => e.type === 'd').length;
  $('[data-role=foot]', panes[side]).textContent = st.sel.size
    ? `Vybráno ${st.sel.size} ${plural(st.sel.size, 'položka', 'položky', 'položek')}, ${fmtSize(selBytes)}`
    : `${files.length} ${plural(files.length, 'soubor', 'soubory', 'souborů')} (${fmtSize(total)}), `
      + `${dirs} ${plural(dirs, 'složka', 'složky', 'složek')}`;
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
  } else if (side === 'remote') {
    await editRemote(fullPath(side, entry));
  } else {
    await call(window.api.local.reveal(fullPath(side, entry)));
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

  $$('[data-act]', pane).forEach((btn) => btn.addEventListener('click', async () => {
    const act = btn.dataset.act;
    if (act === 'up') await loadPane(side, side === 'local' ? localParent(state[side].path) : posixParent(state[side].path));
    else if (act === 'home') await loadPane('remote', await call(window.api.remote.home()));
    else if (act === 'browse') {
      const dir = await call(window.api.local.pickDir());
      if (dir) await loadPane('local', dir);
    }
  }));

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

/** Přesun vybraných položek z jednoho panelu do druhého. */
async function transfer(from, to) {
  if (!state.connected) return setLog('error', 'Nejste připojeni');
  const items = selectedEntries(from).map((e) => fullPath(from, e));
  if (!items.length) return setLog('warn', 'Nic není vybráno');

  const r = from === 'local'
    ? await call(window.api.transfer.upload(items, state.remote.path))
    : await call(window.api.transfer.download(items, state.local.path));
  if (r) setLog('ok', `Zařazeno ${r.count} ${plural(r.count, 'soubor', 'soubory', 'souborů')} do fronty`);
  return undefined;
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
  items.push({ label: 'Obnovit', key: '⌘R', fn: () => loadPane(side, state[side].path) });
  if (side === 'local') {
    items.push({
      label: state.local.showHidden ? 'Skrýt skryté soubory' : 'Zobrazit skryté soubory',
      fn: () => { state.local.showHidden = !state.local.showHidden; renderPane('local'); },
    });
  }
  if (side === 'remote') {
    items.push({ label: '⇅ Synchronizovat tuto složku…', fn: () => openSync() });
    if (state.trash.enabled) items.push({ label: 'Vysypat koš na serveru…', fn: () => emptyRemoteTrash() });
  }

  menu.replaceChildren(...items.map((it) => {
    if (!it) return document.createElement('hr');
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.key) {
      const s = document.createElement('span');
      s.className = 'shortcut';
      s.textContent = it.key;
      b.appendChild(s);
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
    case 'F5': ev.preventDefault(); await transfer(side, other); break;
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
      $('[data-role=list]', panes[side]).children[st.cursor + (st.path !== '/' ? 1 : 0)]
        ?.scrollIntoView({ block: 'nearest' });
      break;
    }
    case 'a':
      if (ev.metaKey) {
        ev.preventDefault();
        st.sel = new Set((st.view || []).map((e) => e.name));
        renderPane(side);
      }
      break;
    default: break;
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
  }));
  btn.disabled = false;
  btn.textContent = 'Porovnat';
  if (!res) return;

  state.syncActions = res.actions;
  const box = $('#sync-result');

  if (!res.actions.length) {
    box.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: `Nic k přenosu — ${res.localCount} lokálních a ${res.remoteCount} vzdálených souborů je shodných.`,
    }));
    $('#sync-apply').disabled = true;
    return;
  }

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
  setForm.elements.editor.value = state.settings.editor || '';
  setDlg.showModal();
});
setDlg.addEventListener('close', async () => {
  if (setDlg.returnValue !== 'save') return;
  state.settings = await call(window.api.settings.set({ editor: setForm.elements.editor.value.trim() })) || state.settings;
});

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
  else if (cmd === 'refresh') $('#btn-refresh').click();
});

(async function init() {
  wirePane('local');
  wirePane('remote');
  state.settings = await call(window.api.settings.get()) || {};
  await refreshSites();
  await loadPane('local', await call(window.api.local.home()));
  renderQueue(await call(window.api.queue.snapshot()) || { items: [], pending: 0, totalBytes: 0, doneBytes: 0, paused: false });
  setActive('local');
}());
