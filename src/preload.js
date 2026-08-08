const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  theme: {
    setOverlay: (isDark) => ipcRenderer.send('theme:setOverlay', isDark),
  },
  // Synchronous on purpose — needed before first paint (see main.js). Every
  // other IPC call in this file is intentionally async; this is the one
  // deliberate exception.
  getInitialTheme: () => ipcRenderer.sendSync('settings:getThemeSync'),
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
  dismissUpdate: (version) => ipcRenderer.invoke('app:dismissUpdate', version),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  performUpdate: () => ipcRenderer.invoke('app:performUpdate'),
  onUpdateProgress: (callback) => ipcRenderer.on('app:updateProgress', (_event, data) => callback(data)),
  confirmQuitForUpdate: () => ipcRenderer.send('app:confirmQuitForUpdate'),
  settings: {
    getServerUrl: () => ipcRenderer.invoke('settings:getServerUrl'),
    setServerUrl: (serverUrl) => ipcRenderer.invoke('settings:setServerUrl', serverUrl),
    forgetCertificate: (serverUrl) => ipcRenderer.invoke('settings:forgetCertificate', serverUrl),
    getSyncFolder: () => ipcRenderer.invoke('settings:getSyncFolder'),
    chooseSyncFolder: () => ipcRenderer.invoke('settings:chooseSyncFolder'),
    setTheme: (theme) => ipcRenderer.invoke('settings:setTheme', theme),
  },
  sync: {
    getStatus: (projectId) => ipcRenderer.invoke('sync:getStatus', projectId),
    pull: (projectId) => ipcRenderer.invoke('sync:pull', projectId),
    push: (projectId) => ipcRenderer.invoke('sync:push', projectId),
    unlink: (projectId) => ipcRenderer.invoke('sync:unlink', projectId),
    isLinked: (projectId) => ipcRenderer.invoke('sync:isLinked', projectId),
  },
  auth: {
    signIn: () => ipcRenderer.invoke('auth:signIn'),
    signOut: () => ipcRenderer.invoke('auth:signOut'),
    status: () => ipcRenderer.invoke('auth:status'),
  },
  server: {
    listProjects: () => ipcRenderer.invoke('server:listProjects'),
    createProject: (name) => ipcRenderer.invoke('server:createProject', name),
    deleteProject: (projectId) => ipcRenderer.invoke('server:deleteProject', projectId),
    shareProject: (projectId, email, role) => ipcRenderer.invoke('server:shareProject', { projectId, email, role }),
    unshareProject: (projectId, email) => ipcRenderer.invoke('server:unshareProject', { projectId, email }),
    getProjectMembers: (projectId) => ipcRenderer.invoke('server:getProjectMembers', projectId),
    updateMemberRole: (projectId, userId, role) => ipcRenderer.invoke('server:updateMemberRole', { projectId, userId, role }),
    updateProjectSyncMode: (projectId, syncMode) => ipcRenderer.invoke('server:updateProjectSyncMode', { projectId, syncMode }),
    uploadProjectCover: (projectId) => ipcRenderer.invoke('server:uploadProjectCover', projectId),
    downloadProjectCover: (projectId) => ipcRenderer.invoke('server:downloadProjectCover', projectId),
    getFolder: (folderId) => ipcRenderer.invoke('server:getFolder', folderId),
    createFolder: (parentId, name) => ipcRenderer.invoke('server:createFolder', { parentId, name }),
    chooseFilesToUpload: () => ipcRenderer.invoke('server:chooseFilesToUpload'),
    uploadVersion: (fileId, message) => ipcRenderer.invoke('server:uploadVersion', { fileId, message }),
    restoreVersion: (fileId, versionId) => ipcRenderer.invoke('server:restoreVersion', { fileId, versionId }),
    listVersions: (fileId) => ipcRenderer.invoke('server:listVersions', fileId),
    downloadVersion: (versionId) => ipcRenderer.invoke('server:downloadVersion', versionId),
    openFileInDefaultApp: (fileId, versionId, fileName) =>
      ipcRenderer.invoke('server:openFileInDefaultApp', { fileId, versionId, fileName }),
    getDefaultAppName: (fileName) => ipcRenderer.invoke('server:getDefaultAppName', fileName),
    generateBOM: (fileId, fileName, folderId) => ipcRenderer.invoke('server:generateBOM', { fileId, fileName, folderId }),
    checkoutFile: (fileId) => ipcRenderer.invoke('server:checkoutFile', fileId),
    checkinFile: (fileId) => ipcRenderer.invoke('server:checkinFile', fileId),
    uploadFilePath: (folderId, filePath) => ipcRenderer.invoke('server:uploadFilePath', { folderId, filePath }),
    renameFile: (fileId, name) => ipcRenderer.invoke('server:renameFile', { fileId, name }),
    moveFile: (fileId, folderId) => ipcRenderer.invoke('server:moveFile', { fileId, folderId }),
    deleteFile: (fileId) => ipcRenderer.invoke('server:deleteFile', fileId),
    restoreFile: (fileId) => ipcRenderer.invoke('server:restoreFile', fileId),
    renameFolder: (folderId, name) => ipcRenderer.invoke('server:renameFolder', { folderId, name }),
    moveFolder: (folderId, parentId) => ipcRenderer.invoke('server:moveFolder', { folderId, parentId }),
    deleteFolder: (folderId) => ipcRenderer.invoke('server:deleteFolder', folderId),
    restoreFolder: (folderId) => ipcRenderer.invoke('server:restoreFolder', folderId),
    getTrash: (projectId) => ipcRenderer.invoke('server:getTrash', projectId),
    searchProject: (projectId, opts) => ipcRenderer.invoke('server:searchProject', { projectId, ...opts }),
    syncProjectToLocal: (projectId, projectName, rootFolderId) =>
      ipcRenderer.invoke('server:syncProjectToLocal', { projectId, projectName, rootFolderId }),
    getProjectActivity: (projectId) => ipcRenderer.invoke('server:getProjectActivity', projectId),
    listNotifications: () => ipcRenderer.invoke('server:listNotifications'),
    markNotificationRead: (id) => ipcRenderer.invoke('server:markNotificationRead', id),
    markAllNotificationsRead: () => ipcRenderer.invoke('server:markAllNotificationsRead'),
    listProjectTags: (projectId) => ipcRenderer.invoke('server:listProjectTags', projectId),
    createTag: (projectId, name, color) => ipcRenderer.invoke('server:createTag', { projectId, name, color }),
    deleteTag: (tagId) => ipcRenderer.invoke('server:deleteTag', tagId),
    addFileTag: (fileId, tagId) => ipcRenderer.invoke('server:addFileTag', { fileId, tagId }),
    removeFileTag: (fileId, tagId) => ipcRenderer.invoke('server:removeFileTag', { fileId, tagId }),
  },
  sldprt: {
    decodeBuffer: (bytes) => ipcRenderer.invoke('sldprt:decodeBuffer', bytes),
  },
  // webUtils is preload/renderer-only (Electron 32+) — the replacement for
  // the deprecated File.path, needed to get a real filesystem path out of
  // a drag-and-dropped file so it can be streamed from disk like every
  // other upload in this app, rather than round-tripped through IPC as
  // bytes.
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
