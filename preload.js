const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  connections: {
    list: () => ipcRenderer.invoke('connections:list'),
    setEnabled: (id, enabled) => ipcRenderer.invoke('connections:setEnabled', id, enabled),
    setCap: (id, cap) => ipcRenderer.invoke('connections:setCap', id, cap)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (s) => ipcRenderer.invoke('settings:set', s)
  },
  downloads: {
    list: () => ipcRenderer.invoke('downloads:list'),
    add: (url, opts) => ipcRenderer.invoke('downloads:add', url, opts),
    start: (id) => ipcRenderer.invoke('downloads:start', id),
    pause: (id) => ipcRenderer.invoke('downloads:pause', id),
    resume: (id) => ipcRenderer.invoke('downloads:resume', id),
    pauseAll: () => ipcRenderer.invoke('downloads:pauseAll'),
    resumeAll: () => ipcRenderer.invoke('downloads:resumeAll'),
    queueState: () => ipcRenderer.invoke('downloads:queueState'),
    cancel: (id) => ipcRenderer.invoke('downloads:cancel', id),
    remove: (id, opts) => ipcRenderer.invoke('downloads:remove', id, opts),
    refreshLink: (id, url) => ipcRenderer.invoke('downloads:refreshLink', id, url),
    chooseFolder: () => ipcRenderer.invoke('downloads:chooseFolder')
  },
  app: {
    info: () => ipcRenderer.invoke('app:info')
  },
  updater: {
    check: () => ipcRenderer.invoke('app:updateCheck'),
    status: () => ipcRenderer.invoke('app:updateStatus'),
    download: () => ipcRenderer.invoke('app:updateDownload'),
    install: () => ipcRenderer.invoke('app:updateInstall'),
    promptInstall: () => ipcRenderer.invoke('app:updatePromptInstall'),
    openReleases: () => ipcRenderer.invoke('app:updateOpenReleases')
  },
  firefox: {
    openExtension: () => ipcRenderer.invoke('app:openExtension')
  },
  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
    openFile: (p) => ipcRenderer.invoke('shell:openFile', p)
  },
  on: (channel, cb) => ipcRenderer.on(channel, (e, ...args) => cb(...args))
});
