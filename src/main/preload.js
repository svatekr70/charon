'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * Renderer nemá přístup k Node — všechno jde přes tenhle úzký můstek.
 * Každé volání vrací {ok, data} nebo {ok:false, error}, chyby se tedy
 * nepropagují jako výjimky přes IPC hranici.
 *
 * Skoro všechno se vztahuje ke konkrétní záložce, proto `sid` jako první
 * parametr. Lokální souborový systém a nastavení jsou společné.
 */
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const on = (channel, cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },
  sites: {
    list: () => invoke('sites:list'),
    save: (site) => invoke('sites:save', site),
    remove: (id) => invoke('sites:delete', id),
  },
  winscp: {
    pick: () => invoke('winscp:pick'),
    import: (sessions, overwrite) => invoke('winscp:import', { sessions, overwrite }),
  },
  sessions: {
    list: () => invoke('sessions:list'),
    open: (payload) => invoke('sessions:open', payload),
    close: (sid) => invoke('sessions:close', sid),
    activate: (sid) => invoke('sessions:activate', sid),
  },
  remote: {
    list: (sid, path) => invoke('remote:list', { sid, path }),
    home: (sid) => invoke('remote:home', { sid }),
    mkdir: (sid, path) => invoke('remote:mkdir', { sid, path }),
    rename: (sid, from, to) => invoke('remote:rename', { sid, from, to }),
    chmod: (sid, remotePath, mode) => invoke('remote:chmod', { sid, remotePath, mode }),
    remove: (sid, paths, permanent) => invoke('remote:delete', { sid, paths, permanent: Boolean(permanent) }),
    dirSize: (sid, path) => invoke('remote:dirSize', { sid, path }),
    properties: (sid, paths) => invoke('remote:properties', { sid, paths }),
    applyProperties: (sid, opts) => invoke('remote:applyProperties', { sid, ...opts }),
    checksum: (sid, paths, algo) => invoke('remote:checksum', { sid, paths, algo }),
  },
  trash: {
    info: (sid) => invoke('trash:info', { sid }),
    empty: (sid) => invoke('trash:empty', { sid }),
  },
  local: {
    home: () => invoke('local:home'),
    list: (p) => invoke('local:list', p),
    mkdir: (p) => invoke('local:mkdir', p),
    rename: (from, to) => invoke('local:rename', { from, to }),
    remove: (paths) => invoke('local:delete', paths),
    reveal: (p) => invoke('local:reveal', p),
    pickDir: () => invoke('local:pickDir'),
    pickFile: (opts) => invoke('local:pickFile', opts),
    dirSize: (p) => invoke('local:dirSize', p),
  },
  transfer: {
    upload: (sid, items, remoteDir, mask) => invoke('transfer:upload', { sid, items, remoteDir, mask }),
    download: (sid, items, localDir, mask) => invoke('transfer:download', { sid, items, localDir, mask }),
    move: (sid, items, targetDir, from, mask) => invoke('transfer:move', { sid, items, targetDir, from, mask }),
  },
  find: {
    start: (sid, opts) => invoke('find:start', { sid, ...opts }),
    cancel: (sid) => invoke('find:cancel', { sid }),
  },
  cmd: {
    prompts: (template) => invoke('cmd:prompts', { template }),
    run: (sid, opts) => invoke('cmd:run', { sid, ...opts }),
  },
  watch: {
    start: (sid, opts) => invoke('watch:start', { sid, ...opts }),
    stop: (sid) => invoke('watch:stop', { sid }),
    status: (sid) => invoke('watch:status', { sid }),
  },
  queue: {
    snapshot: (sid) => invoke('queue:snapshot', { sid }),
    pause: (sid) => invoke('queue:pause', { sid }),
    resume: (sid) => invoke('queue:resume', { sid }),
    cancel: (sid, id) => invoke('queue:cancel', { sid, id }),
    cancelAll: (sid) => invoke('queue:cancelAll', { sid }),
    retry: (sid, id) => invoke('queue:retry', { sid, id }),
    clear: (sid) => invoke('queue:clear', { sid }),
    speedLimit: (sid, id, kb) => invoke('queue:speedLimit', { sid, id, kb }),
  },
  sync: {
    compare: (sid, opts) => invoke('sync:compare', { sid, ...opts }),
    apply: (sid, actions) => invoke('sync:apply', { sid, actions }),
  },
  edit: {
    open: (sid, remotePath) => invoke('edit:open', { sid, remotePath }),
    stop: (sid, remotePath) => invoke('edit:stop', { sid, remotePath }),
    stopAll: (sid) => invoke('edit:stopAll', { sid }),
    list: (sid) => invoke('edit:list', { sid }),
  },
  // Electron už na File neposkytuje .path — cestu k přetaženému souboru
  // z Finderu je potřeba získat takhle.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  // Hlavní proces se ptá okna (konflikt při přepisu). Odpověď se posílá
  // zpátky pod stejným id, jinak by fronta čekala donekonečna.
  onAsk: (cb) => on('conflict', cb),
  onAskEdit: (cb) => on('editconflict', cb),
  answer: (id, answer) => invoke('prompt:answer', { id, answer }),

  // Události relací nesou sid, ať je okno přiřadí správné záložce.
  onSessions: (cb) => on('sessions', cb),
  onQueue: (cb) => on('queue', cb),
  onConn: (cb) => on('conn', cb),
  onEdit: (cb) => on('edit', cb),
  onWatch: (cb) => on('watch', cb),
  onFind: (cb) => on('find', cb),
  onConsole: (cb) => on('console', cb),
  onLog: (cb) => on('log', cb),
  onMenu: (cb) => on('menu', cb),
});
