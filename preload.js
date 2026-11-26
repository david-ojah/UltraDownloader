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
  torrents: {
    list: () => ipcRenderer.invoke('torrents:list'),
    add: (source, opts) => ipcRenderer.invoke('torrents:add', source, opts),
    pause: (id) => ipcRenderer.invoke('torrents:pause', id),
    pauseAll: () => ipcRenderer.invoke('torrents:pauseAll'),
    resumeAll: () => ipcRenderer.invoke('torrents:resumeAll'),
    resume: (id) => ipcRenderer.invoke('torrents:resume', id),
    remove: (id) => ipcRenderer.invoke('torrents:remove', id),
    queueState: () => ipcRenderer.invoke('torrents:queueState'),
    setFilePriorities: (id, priorities) => ipcRenderer.invoke('torrents:setFilePriorities', id, priorities),
    setLimits: (id, uploadKbps, downloadKbps) => ipcRenderer.invoke('torrents:setLimits', id, uploadKbps, downloadKbps),
    getPeerList: (id) => ipcRenderer.invoke('torrents:peerList', id),
    updateTrackers: (id) => ipcRenderer.invoke('torrents:updateTrackers', id),
    chooseFolder: () => ipcRenderer.invoke('torrents:chooseFolder')
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    onboardingStatus: () => ipcRenderer.invoke('app:onboardingStatus')
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
