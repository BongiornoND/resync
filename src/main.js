const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const { createStaticServer } = require('./static-server');
const serverAuth = require('./server-auth');
const serverClient = require('./server-client');
const settingsStore = require('./settings-store');
const sldprt = require('./sldprt');
const sldprtColors = require('./sldprt-colors');
const localSync = require('./local-sync');

let mainWindow;

// Hand-matched to the light/dark tokens in renderer/styles.css — the
// native titlebar overlay takes a real color, not a CSS var(), so these
// need updating by hand if that palette moves. Windows/Linux only;
// titleBarOverlay has no effect on macOS (its traffic-light inset is a
// separate mechanism this app doesn't currently customize). Neutral gray
// is now the default "dark" (was "dark-gray"); the original teal theme
// lives on as the explicit "resync" choice (was "dark").
const TITLEBAR_COLORS = {
  light: { color: '#ffffff', symbolColor: '#1c2223' },
  dark: { color: '#161616', symbolColor: '#dbdbdb' },
  resync: { color: '#10181d', symbolColor: '#dbe3e4' },
};

async function createWindow() {
  // Load the UI over http://127.0.0.1 (not file://) so occt-import-js can
  // fetch() its .wasm file — fetch against file:// is unreliable in Chromium.
  const { port } = await createStaticServer(path.join(__dirname, '..'));

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    // Hides the native title/menu strip but keeps the minimize/maximize/
    // close buttons, drawn over titleBarOverlay's color — lets the app's
    // own topbar fill the rest of that strip instead of sitting below a
    // separate OS-colored bar. renderer/index.html marks the topbar
    // -webkit-app-region: drag (with its buttons/inputs carved out as
    // no-drag) so the window is still movable from the bar itself.
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin' ? { titleBarOverlay: { ...TITLEBAR_COLORS.light, height: 40 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/renderer/index.html`);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  localSync.stopAll();
  if (process.platform !== 'darwin') app.quit();
});

// Renderer tells us its resolved theme key ('light' | 'dark' | 'resync',
// both on load and on every change, including the OS preference flipping
// while "System" is selected) — the renderer is the one place that already
// knows how to resolve that.
ipcMain.on('theme:setOverlay', (_event, themeKey) => {
  if (!mainWindow || process.platform === 'darwin') return;
  mainWindow.setTitleBarOverlay({ ...(TITLEBAR_COLORS[themeKey] || TITLEBAR_COLORS.light), height: 40 });
});

// Synchronous by design: the renderer's early <head> script needs this
// value before first paint to avoid a flash of the wrong theme, and IPC
// invoke() is async. Stored via settingsStore (userData/settings.json),
// not localStorage — the renderer loads over a fresh, randomly-assigned
// http://127.0.0.1:<port> origin every launch (see static-server.js), so
// localStorage looked like it was silently resetting on every restart.
ipcMain.on('settings:getThemeSync', (event) => {
  event.returnValue = settingsStore.getTheme();
});

ipcMain.handle('settings:setTheme', async (_event, theme) => {
  settingsStore.setTheme(theme);
  return { ok: true };
});

// --- Check for updates (GitHub Releases) ---

function githubApiGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'api.github.com', path: pathname, method: 'GET', headers: { 'User-Agent': 'resync-client', Accept: 'application/vnd.github+json' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(githubApiGet(res.headers.location.replace('https://api.github.com', '')));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API returned ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error('Could not parse GitHub API response: ' + err.message));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Numeric segment-by-segment compare (not string compare — "0.10.0" must
// beat "0.9.0") — good enough for this project's plain MAJOR.MINOR.PATCH
// tags, no need for a full semver dependency.
function isNewerVersion(latest, current) {
  const a = latest.replace(/^v/, '').split('.').map(Number);
  const b = current.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

ipcMain.handle('app:checkForUpdates', async () => {
  const currentVersion = app.getVersion();
  try {
    const release = await githubApiGet('/repos/BongiornoND/resync/releases/latest');
    const latestVersion = release.tag_name;
    return {
      ok: true,
      currentVersion,
      latestVersion,
      updateAvailable: isNewerVersion(latestVersion, currentVersion),
      releaseUrl: release.html_url,
      dismissedVersion: settingsStore.getDismissedUpdateVersion(),
    };
  } catch (err) {
    return { ok: false, currentVersion, error: err.message };
  }
});

ipcMain.handle('app:dismissUpdate', async (_event, version) => {
  settingsStore.setDismissedUpdateVersion(version);
  return { ok: true };
});

ipcMain.handle('app:openExternal', async (_event, url) => {
  // Only ever called with a URL this app itself received from the GitHub
  // API response above, not anything user-suppliable — no need to
  // allowlist further, but still worth keeping this handler narrow rather
  // than a generic "open any URL" passthrough.
  if (typeof url === 'string' && url.startsWith('https://github.com/')) {
    await shell.openExternal(url);
  }
});

// --- Self-update: download the latest release and swap it in ---
//
// The running process holds an OS-level lock on its own exe and DLLs (we
// hit this ourselves as a plain EBUSY error while repackaging with the app
// open), so this process can never overwrite its own files. The standard
// pattern applies: download the new build, hand off to a small detached
// helper script that waits for this process to actually exit, does the
// file swap, relaunches the new exe, then quit. PowerShell's built-in
// Expand-Archive/Copy-Item cover the swap with no new dependency.

let updateInProgress = false;

function downloadUpdateZip(url, destPath, totalSize) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let downloaded = 0;

    function get(u) {
      const req = https.get(u, { headers: { 'User-Agent': 'resync-client' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (mainWindow) {
            mainWindow.webContents.send('app:updateProgress', {
              fraction: totalSize ? downloaded / totalSize : 0,
              label: 'Downloading update…',
            });
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      });
      req.on('error', reject);
    }

    get(url);
  });
}

// Single-quoted throughout — every path here comes from app.getPath()/
// process.execPath, never user input, but single-quoting is still the
// right default for embedding arbitrary paths in a PowerShell string.
function buildUpdateScript({ pid, zipPath, extractDir, installDir, exeName }) {
  const exePath = path.join(installDir, exeName);
  return [
    `Wait-Process -Id ${pid} -Timeout 30 -ErrorAction SilentlyContinue`,
    'Start-Sleep -Milliseconds 500',
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
    `Copy-Item -Path '${extractDir}\\*' -Destination '${installDir}' -Recurse -Force`,
    `Remove-Item -Path '${zipPath}' -Force -ErrorAction SilentlyContinue`,
    `Remove-Item -Path '${extractDir}' -Recurse -Force -ErrorAction SilentlyContinue`,
    `Start-Process -FilePath '${exePath}'`,
    'Remove-Item -Path $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
  ].join('\r\n');
}

ipcMain.handle('app:performUpdate', async () => {
  if (!app.isPackaged) return { ok: false, error: 'Self-update only works in a packaged build, not in dev mode.' };
  if (updateInProgress) return { ok: false, error: 'An update is already in progress.' };

  const exeName = path.basename(process.execPath);
  if (exeName.toLowerCase() !== 'resync.exe') {
    return { ok: false, error: `Unexpected executable name (${exeName}) — refusing to self-update.` };
  }

  updateInProgress = true;
  try {
    const release = await githubApiGet('/repos/BongiornoND/resync/releases/latest');
    const asset = (release.assets || []).find((a) => a.name.endsWith('.zip'));
    if (!asset) throw new Error('Latest release has no .zip asset attached');

    const installDir = path.dirname(process.execPath);
    const stamp = Date.now();
    const tmpDir = app.getPath('temp');
    const zipPath = path.join(tmpDir, `resync-update-${stamp}.zip`);
    const extractDir = path.join(tmpDir, `resync-update-extract-${stamp}`);
    const scriptPath = path.join(tmpDir, `resync-update-${stamp}.ps1`);

    await downloadUpdateZip(asset.browser_download_url, zipPath, asset.size);

    fs.writeFileSync(scriptPath, buildUpdateScript({ pid: process.pid, zipPath, extractDir, installDir, exeName }), 'utf8');

    // Detached so it survives this process quitting — that's the whole
    // point, it's waiting specifically for that to happen.
    const helper = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      detached: true,
      stdio: 'ignore',
    });
    helper.unref();

    return { ok: true, version: release.tag_name };
  } catch (err) {
    updateInProgress = false;
    return { ok: false, error: err.message };
  }
});

// Separate from performUpdate's own promise so the renderer can render the
// "restarting…" state and let the user actually see it before the process
// disappears, rather than quitting out from under an in-flight IPC reply.
ipcMain.on('app:confirmQuitForUpdate', () => {
  app.quit();
});

// --- Server connection settings ---

ipcMain.handle('settings:getServerUrl', () => {
  return { ok: true, serverUrl: settingsStore.getServerUrl() };
});

ipcMain.handle('settings:forgetCertificate', async (_event, serverUrl) => {
  const normalized = settingsStore.normalizeServerUrl(serverUrl);
  settingsStore.clearPinnedFingerprint(normalized);
  return { ok: true };
});

ipcMain.handle('settings:setServerUrl', async (_event, serverUrl) => {
  const normalized = settingsStore.normalizeServerUrl(serverUrl);
  try {
    await serverClient.checkHealth(normalized);
    settingsStore.setServerUrl(normalized);
    return { ok: true };
  } catch (err) {
    if (err instanceof serverClient.CertificateMismatchError) {
      return { ok: false, error: err.message, certMismatch: true };
    }
    return { ok: false, error: 'Could not reach that server: ' + err.message };
  }
});

// --- Local sync folder — the initial one-shot download that seeds a
// project's local copy. Once it finishes, server:syncProjectToLocal below
// hands the project off to local-sync.js, which keeps it continuously
// synced both ways (protected push, detect-and-notify pull) for as long as
// the app runs — see that module for the real sync engine. ---

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

// Downloads are skipped when a same-sized local file already exists —
// cheap and avoids re-transferring everything on every sync, but it's a
// size check, not a content hash, so it can't detect a same-size edit.
// Good enough for "give me a local copy," not a substitute for real
// change detection.
async function syncFolderRecursive(remoteFolderId, localDirPath) {
  fs.mkdirSync(localDirPath, { recursive: true });
  const { items } = await serverClient.getFolder(remoteFolderId);
  let fileCount = 0;
  for (const item of items) {
    const localPath = path.join(localDirPath, sanitizeFilename(item.name));
    if (item.isFolder) {
      fileCount += await syncFolderRecursive(item.id, localPath);
    } else {
      const upToDate = fs.existsSync(localPath) && fs.statSync(localPath).size === item.size;
      if (!upToDate) {
        const buffer = await serverClient.downloadVersion(item.latestVersionId);
        fs.writeFileSync(localPath, buffer);
      }
      fileCount++;
    }
  }
  return fileCount;
}

ipcMain.handle('settings:getSyncFolder', () => {
  return { ok: true, syncFolder: settingsStore.getSyncFolder() };
});

ipcMain.handle('settings:chooseSyncFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a Resync folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  settingsStore.setSyncFolder(result.filePaths[0]);
  return { ok: true, syncFolder: result.filePaths[0] };
});

ipcMain.handle('server:syncProjectToLocal', async (_event, { projectId, projectName, rootFolderId }) => {
  const syncFolder = settingsStore.getSyncFolder();
  if (!syncFolder) return { ok: false, error: 'No local sync folder set yet' };
  try {
    const wasAlreadyLinked = localSync.isLinked(projectId);
    const projectDir = path.join(syncFolder, sanitizeFilename(projectName));
    const fileCount = await syncFolderRecursive(rootFolderId, projectDir);
    const { syncMode } = await serverClient.getFolder(rootFolderId);
    await localSync.startSync({ projectId, projectName, rootFolderId, localDir: projectDir, syncMode });
    return { ok: true, fileCount, localPath: projectDir, firstSync: !wasAlreadyLinked };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('sync:getStatus', (_event, projectId) => {
  return { ok: true, ...localSync.getStatus(projectId) };
});

ipcMain.handle('sync:pull', async (_event, projectId) => {
  return localSync.pull(projectId);
});

ipcMain.handle('sync:unlink', (_event, projectId) => {
  localSync.unlinkSync(projectId);
  return { ok: true };
});

ipcMain.handle('sync:isLinked', (_event, projectId) => {
  return { ok: true, linked: localSync.isLinked(projectId) };
});

// --- Auth (Google for identity only — everything else is our own server) ---

ipcMain.handle('auth:signIn', async () => {
  try {
    const profile = await serverAuth.login();
    // Fire-and-forget — bringing every linked project's watcher/poller back
    // up shouldn't hold up the sign-in response the renderer is waiting on.
    localSync.resumeAll().catch(() => {});
    return { ok: true, profile };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:signOut', async () => {
  localSync.stopAll();
  await serverAuth.logout();
  return { ok: true };
});

ipcMain.handle('auth:status', async () => {
  const result = await serverAuth.status();
  if (result.signedIn) localSync.resumeAll().catch(() => {});
  return result;
});

// --- Projects / folders ---

ipcMain.handle('server:listProjects', async () => {
  try {
    return { ok: true, projects: await serverClient.listProjects() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:createProject', async (_event, name) => {
  try {
    return { ok: true, project: await serverClient.createProject(name) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:getFolder', async (_event, folderId) => {
  try {
    return { ok: true, ...(await serverClient.getFolder(folderId)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:createFolder', async (_event, { parentId, name }) => {
  try {
    return { ok: true, folder: await serverClient.createFolder(parentId, name) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:shareProject', async (_event, { projectId, email, role }) => {
  try {
    return { ok: true, ...(await serverClient.shareProject(projectId, email, role)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:unshareProject', async (_event, { projectId, email }) => {
  try {
    return { ok: true, ...(await serverClient.unshareProject(projectId, email)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:getProjectMembers', async (_event, projectId) => {
  try {
    return { ok: true, ...(await serverClient.getProjectMembers(projectId)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:updateMemberRole', async (_event, { projectId, userId, role }) => {
  try {
    return { ok: true, ...(await serverClient.updateMemberRole(projectId, userId, role)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:updateProjectSyncMode', async (_event, { projectId, syncMode }) => {
  try {
    return { ok: true, ...(await serverClient.updateProjectSyncMode(projectId, syncMode)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

const COVER_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

ipcMain.handle('server:uploadProjectCover', async (_event, projectId) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a cover image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  const filePath = result.filePaths[0];
  const mime = COVER_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  try {
    await serverClient.uploadProjectCover(projectId, filePath, mime);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:downloadProjectCover', async (_event, projectId) => {
  try {
    const buffer = await serverClient.downloadProjectCover(projectId);
    if (!buffer) return { ok: false };
    return { ok: true, data: new Uint8Array(buffer) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Files: uploads open a native picker in the main process and stream
// straight from disk, so bytes never round-trip through the renderer ---

// Just the picker — multiple files at once. The renderer queues each
// returned path through server:uploadFilePath one at a time (see the
// upload queue in app.js), rather than this handler uploading them itself,
// so the button can stay clickable and keep accepting more files while a
// batch is still working through the queue.
ipcMain.handle('server:chooseFilesToUpload', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Upload files',
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, filePaths: result.filePaths };
});

ipcMain.handle('server:uploadVersion', async (_event, { fileId, message }) => {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Upload new version', properties: ['openFile'] });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  const filePath = result.filePaths[0];
  try {
    const file = await serverClient.uploadVersion(fileId, filePath, message);
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:restoreVersion', async (_event, { fileId, versionId }) => {
  try {
    const file = await serverClient.restoreVersion(fileId, versionId);
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:listVersions', async (_event, fileId) => {
  try {
    return { ok: true, versions: await serverClient.listVersions(fileId) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Shared with local-sync.js's own pre-push checkout — see guardCheckout's
// doc comment for why a stale local copy must never be checked out against.
ipcMain.handle('server:checkoutFile', async (_event, fileId) => {
  const guard = await localSync.guardCheckout(fileId);
  if (!guard.ok) return { ok: false, error: guard.reason };
  try {
    return { ok: true, lock: await serverClient.checkoutFile(fileId) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:checkinFile', async (_event, fileId) => {
  try {
    return { ok: true, lock: await serverClient.checkinFile(fileId) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// A dropped OS file already has a real path (via webUtils.getPathForFile
// in preload) — no need for the dialog.showOpenDialog round trip the
// button-triggered upload uses.
ipcMain.handle('server:uploadFilePath', async (_event, { folderId, filePath }) => {
  try {
    const file = await serverClient.uploadFile(folderId, filePath, path.basename(filePath));
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:renameFile', async (_event, { fileId, name }) => {
  try {
    return { ok: true, ...(await serverClient.updateFile(fileId, { name })) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:moveFile', async (_event, { fileId, folderId }) => {
  try {
    return { ok: true, ...(await serverClient.updateFile(fileId, { folderId })) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:deleteFile', async (_event, fileId) => {
  try {
    return { ok: true, ...(await serverClient.deleteFile(fileId)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:restoreFile', async (_event, fileId) => {
  try {
    return { ok: true, ...(await serverClient.restoreFile(fileId)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:renameFolder', async (_event, { folderId, name }) => {
  try {
    return { ok: true, ...(await serverClient.updateFolder(folderId, { name })) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:moveFolder', async (_event, { folderId, parentId }) => {
  try {
    return { ok: true, ...(await serverClient.updateFolder(folderId, { parentId })) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:deleteFolder', async (_event, folderId) => {
  try {
    return { ok: true, ...(await serverClient.deleteFolder(folderId)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:restoreFolder', async (_event, folderId) => {
  try {
    return { ok: true, ...(await serverClient.restoreFolder(folderId)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:getTrash', async (_event, projectId) => {
  try {
    return { ok: true, ...(await serverClient.getTrash(projectId)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:searchProject', async (_event, { projectId, query }) => {
  try {
    return { ok: true, ...(await serverClient.searchProject(projectId, query)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:downloadVersion', async (_event, versionId) => {
  try {
    const buffer = await serverClient.downloadVersion(versionId);
    return { ok: true, data: new Uint8Array(buffer) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Activity feed, notifications, tags ---

ipcMain.handle('server:getProjectActivity', async (_event, projectId) => {
  try {
    return { ok: true, entries: await serverClient.getProjectActivity(projectId) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:listNotifications', async () => {
  try {
    return { ok: true, ...(await serverClient.listNotifications()) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:markNotificationRead', async (_event, id) => {
  try {
    return { ok: true, ...(await serverClient.markNotificationRead(id)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:markAllNotificationsRead', async () => {
  try {
    return { ok: true, ...(await serverClient.markAllNotificationsRead()) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:listProjectTags', async (_event, projectId) => {
  try {
    return { ok: true, tags: await serverClient.listProjectTags(projectId) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:createTag', async (_event, { projectId, name, color }) => {
  try {
    return { ok: true, tag: await serverClient.createTag(projectId, name, color) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:deleteTag', async (_event, tagId) => {
  try {
    return { ok: true, ...(await serverClient.deleteTag(tagId)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:addFileTag', async (_event, { fileId, tagId }) => {
  try {
    return { ok: true, ...(await serverClient.addFileTag(fileId, tagId)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:removeFileTag', async (_event, { fileId, tagId }) => {
  try {
    return { ok: true, ...(await serverClient.removeFileTag(fileId, tagId)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- SolidWorks .sldprt decoding (backend-agnostic, unchanged) ---

// Per-face colour is a display enhancement layered on top of an
// already-working decode — resolving it depends on SolidWorks being
// installed locally (see sldprt-colors.js), so a failure here should never
// take down the base mesh preview that worked before this feature existed.
function decodeSldprtColors(buffer, mesh) {
  try {
    const result = sldprtColors.vertexColorsFromSpans(buffer, mesh.spans, mesh.vertexCount);
    return result.hasColor ? result.array : null;
  } catch (err) {
    console.error('SLDPRT colour extraction failed:', err);
    return null;
  }
}

ipcMain.handle('sldprt:decodeBuffer', async (_event, data) => {
  try {
    const buffer = Buffer.from(data);
    const mesh = sldprt.loadMeshFromBuffer(buffer);
    return {
      ok: true,
      positions: mesh.positions,
      normals: mesh.normals,
      indices: mesh.indices,
      colors: decodeSldprtColors(buffer, mesh),
      vertexCount: mesh.vertexCount,
      triangleCount: mesh.triangleCount,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
