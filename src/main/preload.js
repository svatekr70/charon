'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * Renderer nemá přístup k Node — všechno jde přes tenhle úzký můstek.
 * Každé volání vrací {ok, data} nebo {ok:false, error}, chyby se tedy
 * nepropagují jako výjimky přes IPC hranici.
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
  conn: {
    status: () => invoke('conn:status'),
    connect: (payload) => invoke('conn:connect', payload),
    disconnect: () => invoke('conn:disconnect'),
  },
  remote: {
    list: (p) => invoke('remote:list', p),
    home: () => invoke('remote:home'),
    mkdir: (p) => invoke('remote:mkdir', p),
    rename: (from, to) => invoke('remote:rename', { from, to }),
    chmod: (remotePath, mode) => invoke('remote:chmod', { remotePath, mode }),
    remove: (paths, permanent) => invoke('remote:delete', { paths, permanent: Boolean(permanent) }),
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
  },
  trash: {
    info: () => invoke('trash:info'),
    empty: () => invoke('trash:empty'),
  },
  transfer: {
    upload: (items, remoteDir) => invoke('transfer:upload', { items, remoteDir }),
    download: (items, localDir) => invoke('transfer:download', { items, localDir }),
  },
  queue: {
    snapshot: () => invoke('queue:snapshot'),
    pause: () => invoke('queue:pause'),
    resume: () => invoke('queue:resume'),
    cancel: (id) => invoke('queue:cancel', id),
    cancelAll: () => invoke('queue:cancelAll'),
    retry: (id) => invoke('queue:retry', id),
    clear: () => invoke('queue:clear'),
  },
  sync: {
    compare: (opts) => invoke('sync:compare', opts),
    apply: (actions) => invoke('sync:apply', actions),
  },
  edit: {
    open: (remotePath) => invoke('edit:open', remotePath),
    stop: (remotePath) => invoke('edit:stop', remotePath),
    stopAll: () => invoke('edit:stopAll'),
    list: () => invoke('edit:list'),
  },
  // Electron už na File neposkytuje .path — cestu k přetaženému souboru
  // z Finderu je potřeba získat takhle.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  // Hlavní proces se ptá okna (konflikt při přepisu). Odpověď se posílá
  // zpátky pod stejným id, jinak by fronta čekala donekonečna.
  onAsk: (cb) => on('conflict', cb),
  answer: (id, answer) => invoke('prompt:answer', { id, answer }),
  onQueue: (cb) => on('queue', cb),
  onConn: (cb) => on('conn', cb),
  onEdit: (cb) => on('edit', cb),
  onLog: (cb) => on('log', cb),
  onMenu: (cb) => on('menu', cb),
});
