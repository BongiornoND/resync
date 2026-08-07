const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const serverClient = require('./server-client');
const syncStateStore = require('./sync-state-store');

// Continuous, protected, two-way sync between a project's local folder and
// the server. One in-memory "registry entry" per project currently syncing
// — see startSync() for its shape. Persistent state (what's been synced,
// unresolved conflicts, which projects are linked at all) lives in
// sync-state-store.js instead, so it survives an app restart.
//
// Push (local -> remote) is automatic and continuous, protected by the
// existing checkout/check-in locks in advisory/checkin-mode projects. Pull
// (remote -> local) is detect-only here — polling just populates
// `pendingPull`; nothing is written to disk until pull(projectId) is called
// explicitly (the renderer's "Pull changes" button). This split is
// deliberate: a background push can only ever add a new version (never
// destroy one — version history covers it), but a background *pull* could
// silently overwrite someone's in-progress local edit, which is exactly
// what this whole feature exists to prevent.

// Both overridable by env var for fast automated testing — production
// always runs at the real defaults, nothing here is user-facing config.
const POLL_INTERVAL_MS = Number(process.env.RESYNC_SYNC_POLL_MS) || 30000;
const WRITE_STABILITY_MS = Number(process.env.RESYNC_SYNC_DEBOUNCE_MS) || 2000;
const SYNC_MESSAGE = 'Synced from local folder';

const registry = new Map(); // projectId -> entry

function toRelPath(localDir, absPath) {
  return path.relative(localDir, absPath).split(path.sep).join('/');
}

function toAbsPath(localDir, relPath) {
  return path.join(localDir, ...relPath.split('/'));
}

function conflictPathFor(absPath) {
  const ext = path.extname(absPath);
  const base = absPath.slice(0, absPath.length - ext.length);
  return `${base} (server copy)${ext}`;
}

// Mirrors main.js's old syncFolderRecursive sanitization — kept here too
// (rather than importing from main.js) since this module has no other
// dependency on the Electron main process and shouldn't need one.
function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

// --- Remote tree walking ---

async function refreshRemoteTree(entry) {
  const filesByRelPath = new Map();
  const folderIdByRelPath = new Map([['', entry.rootFolderId]]);
  const idToRelPath = new Map();
  let syncMode = entry.syncMode;

  async function walk(folderId, relDir) {
    const data = await serverClient.getFolder(folderId);
    if (relDir === '') syncMode = data.syncMode;
    for (const item of data.items) {
      const relPath = relDir ? `${relDir}/${sanitizeFilename(item.name)}` : sanitizeFilename(item.name);
      if (item.isFolder) {
        folderIdByRelPath.set(relPath, item.id);
        await walk(item.id, relPath);
      } else {
        filesByRelPath.set(relPath, {
          fileId: item.id,
          latestVersionId: item.latestVersionId,
          size: item.size,
          name: item.name,
        });
        idToRelPath.set(item.id, relPath);
      }
    }
  }

  await walk(entry.rootFolderId, '');
  entry.filesByRelPath = filesByRelPath;
  entry.folderIdByRelPath = folderIdByRelPath;
  entry.idToRelPath = idToRelPath;
  entry.syncMode = syncMode;
}

// A local file with no manifest entry yet, but that already matches a
// remote file of the same size, is almost certainly a leftover from the old
// one-shot "Sync a local copy" pull — treat it as already-synced rather
// than re-uploading everything the first time continuous sync turns on for
// an existing folder. A size mismatch is left alone here; the watcher's own
// initial scan will pick it up as a genuine pending push (no manifest entry
// looks the same as "changed" to handleLocalChange).
function reconcileBaseline(entry) {
  for (const [relPath, remoteInfo] of entry.filesByRelPath) {
    if (syncStateStore.getFileState(entry.projectId, relPath)) continue;
    const absPath = toAbsPath(entry.localDir, relPath);
    if (!fs.existsSync(absPath)) continue;
    const stat = fs.statSync(absPath);
    if (stat.size !== remoteInfo.size) continue;
    syncStateStore.setFileState(entry.projectId, relPath, {
      fileId: remoteInfo.fileId,
      lastSyncedVersionId: remoteInfo.latestVersionId,
      lastSyncedSize: stat.size,
      lastLocalMtimeMs: stat.mtimeMs,
    });
  }
}

async function ensureRemoteFolder(entry, relDir) {
  if (!relDir) return entry.rootFolderId;
  if (entry.folderIdByRelPath.has(relDir)) return entry.folderIdByRelPath.get(relDir);
  const parentRel = path.posix.dirname(relDir) === '.' ? '' : path.posix.dirname(relDir);
  const parentId = await ensureRemoteFolder(entry, parentRel);
  const folder = await serverClient.createFolder(parentId, path.posix.basename(relDir));
  entry.folderIdByRelPath.set(relDir, folder.id);
  return folder.id;
}

// --- Push (local -> remote) ---

async function handleLocalChange(entry, relPath) {
  if (!relPath) return;
  const absPath = toAbsPath(entry.localDir, relPath);
  if (!fs.existsSync(absPath)) {
    entry.expectedWrites.delete(absPath);
    return; // deletions are never propagated automatically
  }

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return;
  }

  // The state comparison (does this file's current mtime/size already match
  // what we last recorded as synced?) is the primary self-echo guard — it's
  // exact regardless of how many fs events a write generates or whether
  // chokidar's awaitWriteFinish coalesces several rapid writes into one
  // event. expectedWrites (below) only exists to cover the one case state
  // can't: a brand-new file the engine itself just created (a pull
  // conflict copy), which has no prior synced state to compare against.
  const state = syncStateStore.getFileState(entry.projectId, relPath);
  if (state && state.lastLocalMtimeMs === stat.mtimeMs && state.lastSyncedSize === stat.size) return; // not a real change

  const expectedSize = entry.expectedWrites.get(absPath);
  if (expectedSize !== undefined) {
    entry.expectedWrites.delete(absPath);
    // Only swallow if the file still looks like exactly what we wrote — if
    // it's since been written again (e.g. a genuine edit landed in the same
    // debounce window as our own write), fall through and treat it as real
    // instead of silently dropping it.
    if (expectedSize === stat.size) return;
  }

  if (syncStateStore.getConflicts(entry.projectId)[relPath]) {
    entry.blockedPush.set(relPath, 'Unresolved sync conflict — resolve the "(server copy)" file first');
    entry.status = 'blocked';
    return;
  }

  // Basic mode has no checkout to protect a push, so pushing isn't
  // automatic here at all — it's just flagged as pending until the user
  // clicks "Push changes" (push(), below) to send everything at once.
  // Advisory/check-in still push the instant a change is detected,
  // protected by checkout.
  if (entry.syncMode === 'basic') {
    entry.pendingPush.set(relPath, true);
    return;
  }

  entry.status = 'syncing';
  const remoteInfo = entry.filesByRelPath.get(relPath);
  const fileId = state?.fileId || remoteInfo?.fileId || null;

  try {
    let newVersionId;
    if (!fileId) {
      const parentRel = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
      const folderId = await ensureRemoteFolder(entry, parentRel);
      const created = await serverClient.uploadFile(folderId, absPath, path.posix.basename(relPath));
      const versions = await serverClient.listVersions(created.id);
      newVersionId = versions[0].id;
      entry.filesByRelPath.set(relPath, { fileId: created.id, latestVersionId: newVersionId, size: stat.size, name: created.name });
      entry.idToRelPath.set(created.id, relPath);
      syncStateStore.setFileState(entry.projectId, relPath, {
        fileId: created.id,
        lastSyncedVersionId: newVersionId,
        lastSyncedSize: stat.size,
        lastLocalMtimeMs: stat.mtimeMs,
      });
    } else {
      // Advisory / check-in: checkout is the actual protection. If someone
      // else holds it, leave the local file untouched and retry later
      // rather than failing silently.
      try {
        await serverClient.checkoutFile(fileId);
      } catch (err) {
        entry.blockedPush.set(relPath, err.message);
        entry.status = 'blocked';
        return;
      }
      await serverClient.uploadVersion(fileId, absPath, SYNC_MESSAGE);
      // The server releases the lock automatically on version upload (see
      // resync-server/src/routes/files.js) — no separate check-in call needed.
      const versions = await serverClient.listVersions(fileId);
      newVersionId = versions[0].id;
      syncStateStore.setFileState(entry.projectId, relPath, {
        fileId,
        lastSyncedVersionId: newVersionId,
        lastSyncedSize: stat.size,
        lastLocalMtimeMs: stat.mtimeMs,
      });
    }
    entry.blockedPush.delete(relPath);
  } catch (err) {
    entry.lastError = err.message;
    entry.blockedPush.set(relPath, err.message);
  } finally {
    entry.status = entry.blockedPush.size > 0 ? 'blocked' : 'idle';
  }
}

// --- Manual batch push (basic mode only) — the "Push changes" button. ---

async function pushOne(entry, relPath) {
  const absPath = toAbsPath(entry.localDir, relPath);
  if (!fs.existsSync(absPath)) {
    entry.pendingPush.delete(relPath); // gone since it was flagged — nothing to push
    return;
  }
  const stat = fs.statSync(absPath);
  const state = syncStateStore.getFileState(entry.projectId, relPath);
  const remoteInfo = entry.filesByRelPath.get(relPath);
  const fileId = state?.fileId || remoteInfo?.fileId || null;

  let newVersionId;
  if (!fileId) {
    const parentRel = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
    const folderId = await ensureRemoteFolder(entry, parentRel);
    const created = await serverClient.uploadFile(folderId, absPath, path.posix.basename(relPath));
    const versions = await serverClient.listVersions(created.id);
    newVersionId = versions[0].id;
    entry.filesByRelPath.set(relPath, { fileId: created.id, latestVersionId: newVersionId, size: stat.size, name: created.name });
    entry.idToRelPath.set(created.id, relPath);
    syncStateStore.setFileState(entry.projectId, relPath, {
      fileId: created.id,
      lastSyncedVersionId: newVersionId,
      lastSyncedSize: stat.size,
      lastLocalMtimeMs: stat.mtimeMs,
    });
  } else {
    await serverClient.uploadVersion(fileId, absPath, SYNC_MESSAGE);
    const versions = await serverClient.listVersions(fileId);
    newVersionId = versions[0].id;
    syncStateStore.setFileState(entry.projectId, relPath, {
      fileId,
      lastSyncedVersionId: newVersionId,
      lastSyncedSize: stat.size,
      lastLocalMtimeMs: stat.mtimeMs,
    });
  }
  entry.pendingPush.delete(relPath);
}

async function push(projectId) {
  const entry = registry.get(projectId);
  if (!entry) return { ok: false, error: 'This project is not syncing' };
  let pushed = 0;
  const errors = [];
  for (const relPath of Array.from(entry.pendingPush.keys())) {
    try {
      await pushOne(entry, relPath);
      pushed++;
    } catch (err) {
      entry.lastError = err.message;
      errors.push({ relPath, error: err.message });
    }
  }
  entry.status = 'idle';
  return { ok: true, pushed, errors };
}

// --- Poll (detect remote changes — never writes to disk) ---

async function pollRemote(entry) {
  // Retry any push that was blocked by someone else's checkout before
  // refreshing the tree — if they've since checked the file back in, this
  // is what actually unblocks it rather than leaving it stuck until the
  // next unrelated local edit happens to touch the same file.
  for (const relPath of Array.from(entry.blockedPush.keys())) {
    await handleLocalChange(entry, relPath);
  }

  await refreshRemoteTree(entry);
  const pendingPull = new Map();
  for (const [relPath, remoteInfo] of entry.filesByRelPath) {
    const state = syncStateStore.getFileState(entry.projectId, relPath);
    if (!state || state.lastSyncedVersionId !== remoteInfo.latestVersionId) {
      pendingPull.set(relPath, remoteInfo);
    }
  }
  entry.pendingPull = pendingPull;
  entry.status = entry.blockedPush.size > 0 ? 'blocked' : 'idle';
}

// --- Pull (remote -> local) — the only code path that writes a remote
// change to disk. Called either in bulk by pull(projectId) (the "Pull
// changes" button) or for a single file by the checkout guard below. ---

async function pullOne(entry, relPath, remoteInfo) {
  // A pending (unpushed) local push means a local edit hasn't reached the
  // server yet — pulling now would silently overwrite it before "Push
  // changes" ever got a chance to send it. Basic mode has no conflict-file
  // mechanism (see below), so the safest thing is to just leave this one
  // file alone; it stays in pendingPull and is retried on the next pull.
  // Pushing it is what actually resolves the race — still "whoever syncs
  // last wins" the mode has always promised, just without a pull clobbering
  // an edit still sitting in the outbox.
  if (entry.pendingPush.has(relPath)) return { conflict: false, skipped: true };

  const absPath = toAbsPath(entry.localDir, relPath);
  const state = syncStateStore.getFileState(entry.projectId, relPath);
  let localChanged = false;
  if (fs.existsSync(absPath)) {
    if (state) {
      const stat = fs.statSync(absPath);
      localChanged = stat.mtimeMs !== state.lastLocalMtimeMs || stat.size !== state.lastSyncedSize;
    } else {
      // A local file with this name exists but was never tracked as synced
      // — safer to treat it as a conflict than to silently clobber it.
      localChanged = true;
    }
  }
  if (entry.blockedPush.has(relPath)) localChanged = true; // pushed edit still blocked on someone else's checkout

  if (entry.syncMode !== 'basic' && localChanged) {
    const buffer = await serverClient.downloadVersion(remoteInfo.latestVersionId);
    const conflictAbsPath = conflictPathFor(absPath);
    fs.mkdirSync(path.dirname(conflictAbsPath), { recursive: true });
    entry.expectedWrites.set(conflictAbsPath, buffer.length);
    fs.writeFileSync(conflictAbsPath, buffer);
    syncStateStore.addConflict(entry.projectId, relPath, toRelPath(entry.localDir, conflictAbsPath));
    entry.pendingPull.delete(relPath);
    return { conflict: true };
  }

  // Basic mode always wins here (last sync wins, by design); anything else
  // reaching this branch simply has no local edit to protect against.
  const buffer = await serverClient.downloadVersion(remoteInfo.latestVersionId);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  entry.expectedWrites.set(absPath, buffer.length);
  fs.writeFileSync(absPath, buffer);
  const stat = fs.statSync(absPath);
  syncStateStore.setFileState(entry.projectId, relPath, {
    fileId: remoteInfo.fileId,
    lastSyncedVersionId: remoteInfo.latestVersionId,
    lastSyncedSize: stat.size,
    lastLocalMtimeMs: stat.mtimeMs,
  });
  entry.blockedPush.delete(relPath);
  entry.pendingPull.delete(relPath);
  return { conflict: false };
}

async function pull(projectId) {
  const entry = registry.get(projectId);
  if (!entry) return { ok: false, error: 'This project is not syncing' };
  let pulled = 0;
  let conflicts = 0;
  let skipped = 0;
  for (const [relPath, remoteInfo] of Array.from(entry.pendingPull.entries())) {
    try {
      const result = await pullOne(entry, relPath, remoteInfo);
      if (result.skipped) skipped++;
      else if (result.conflict) conflicts++;
      else pulled++;
    } catch (err) {
      entry.lastError = err.message;
    }
  }
  entry.status = entry.blockedPush.size > 0 ? 'blocked' : 'idle';
  return { ok: true, pulled, conflicts, skipped };
}

// --- Checkout guard — shared by the manual "Check Out" button and this
// engine's own pre-push checkout, wired in from main.js. See the plan's
// "Checkout requires an up-to-date local copy first" section. ---

function findByFileId(fileId) {
  for (const entry of registry.values()) {
    const relPath = entry.idToRelPath.get(fileId);
    if (relPath) return { entry, relPath };
  }
  return null;
}

async function guardCheckout(fileId) {
  const found = findByFileId(fileId);
  if (!found) return { ok: true }; // not a synced project — nothing to guard
  const { entry, relPath } = found;

  const conflict = syncStateStore.getConflicts(entry.projectId)[relPath];
  if (conflict) {
    const conflictAbs = toAbsPath(entry.localDir, conflict.conflictPath);
    if (fs.existsSync(conflictAbs)) {
      return { ok: false, reason: `Resolve the sync conflict first — see "${path.basename(conflictAbs)}" next to this file` };
    }
    // The conflict file is gone, so the user resolved it by hand.
    syncStateStore.removeConflict(entry.projectId, relPath);
  }

  const absPath = toAbsPath(entry.localDir, relPath);
  const state = syncStateStore.getFileState(entry.projectId, relPath);
  let localChanged = false;
  if (fs.existsSync(absPath) && state) {
    const stat = fs.statSync(absPath);
    localChanged = stat.mtimeMs !== state.lastLocalMtimeMs || stat.size !== state.lastSyncedSize;
  }
  if (localChanged || entry.blockedPush.has(relPath)) {
    return { ok: false, reason: 'This file has unsynced local changes — let them sync before checking out' };
  }

  if (entry.pendingPull.has(relPath)) {
    try {
      await pullOne(entry, relPath, entry.pendingPull.get(relPath));
    } catch (err) {
      return { ok: false, reason: `Could not refresh the local copy before checkout: ${err.message}` };
    }
  }

  return { ok: true };
}

// --- Lifecycle ---

async function startSync({ projectId, projectName, rootFolderId, localDir, syncMode }) {
  if (registry.has(projectId)) return;

  const entry = {
    projectId,
    projectName,
    rootFolderId,
    localDir,
    syncMode: syncMode || 'advisory',
    filesByRelPath: new Map(),
    folderIdByRelPath: new Map([['', rootFolderId]]),
    idToRelPath: new Map(),
    pendingPull: new Map(),
    pendingPush: new Map(),
    blockedPush: new Map(),
    expectedWrites: new Map(),
    status: 'idle',
    lastError: null,
    watcher: null,
    pollTimer: null,
  };
  registry.set(projectId, entry);
  syncStateStore.setLink(projectId, { localDir, rootFolderId, syncMode: entry.syncMode, projectName });

  try {
    await refreshRemoteTree(entry);
    reconcileBaseline(entry);
  } catch (err) {
    entry.lastError = err.message;
  }

  entry.watcher = chokidar.watch(localDir, {
    ignoreInitial: false,
    // dotfiles, plus Office/SolidWorks-style lock files ("~$Part1.SLDPRT")
    // left behind next to a file that's open (or wasn't closed cleanly) —
    // real content never lives in one, so they'd otherwise get pushed to
    // the server as junk the moment a linked folder is first scanned.
    ignored: /(^|[/\\])(\.|~\$)/,
    awaitWriteFinish: { stabilityThreshold: WRITE_STABILITY_MS, pollInterval: Math.min(200, WRITE_STABILITY_MS) },
  });
  const onFsEvent = (absPath) => {
    handleLocalChange(entry, toRelPath(localDir, absPath)).catch((err) => {
      entry.lastError = err.message;
    });
  };
  entry.watcher.on('add', onFsEvent);
  entry.watcher.on('change', onFsEvent);

  entry.pollTimer = setInterval(() => {
    pollRemote(entry).catch((err) => {
      entry.lastError = err.message;
    });
  }, POLL_INTERVAL_MS);
}

function stopSync(projectId) {
  const entry = registry.get(projectId);
  if (!entry) return;
  if (entry.watcher) entry.watcher.close();
  if (entry.pollTimer) clearInterval(entry.pollTimer);
  registry.delete(projectId);
}

function unlinkSync(projectId) {
  stopSync(projectId);
  syncStateStore.clearManifest(projectId);
}

// Called once after sign-in to bring every previously-linked project's
// continuous sync back up — this is what makes "Sync a local copy" a
// one-time on-switch rather than something the user re-triggers every launch.
async function resumeAll() {
  for (const projectId of syncStateStore.listLinkedProjectIds()) {
    const link = syncStateStore.getLink(projectId);
    if (!link) continue;
    await startSync({ projectId, ...link });
  }
}

function stopAll() {
  for (const projectId of Array.from(registry.keys())) stopSync(projectId);
}

function getStatus(projectId) {
  const entry = registry.get(projectId);
  if (!entry) return { registered: false };
  const conflicts = syncStateStore.getConflicts(projectId);
  return {
    registered: true,
    syncMode: entry.syncMode,
    status: entry.status,
    pendingPullCount: entry.pendingPull.size,
    pendingPushCount: entry.pendingPush.size,
    conflicts: Object.entries(conflicts).map(([relPath, c]) => ({ relPath, conflictPath: c.conflictPath })),
    blocked: Array.from(entry.blockedPush.entries()).map(([relPath, reason]) => ({ relPath, reason })),
    lastError: entry.lastError,
  };
}

function isLinked(projectId) {
  return !!syncStateStore.getLink(projectId);
}

module.exports = {
  startSync,
  stopSync,
  unlinkSync,
  resumeAll,
  stopAll,
  pull,
  push,
  getStatus,
  guardCheckout,
  isLinked,
};
