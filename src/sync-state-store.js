const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// One manifest per project, tracking what the sync engine last saw on both
// sides — not a dotfile inside the user's synced folder (that would clutter
// what they see there), so it lives in userData instead, same as
// settings.json.
//
// Shape:
//   {
//     files: {
//       "<relative/path.ext>": { fileId, versionId, size, syncedMtimeMs }
//     },
//     conflicts: {
//       "<relative/path.ext>": { conflictPath: "<relative/path (server copy).ext>" }
//     }
//   }
//
// `files` records the last state both sides agreed on — used to detect a
// local edit (current mtime newer than syncedMtimeMs) and a remote edit
// (folder listing's latestVersionId different from versionId) independently,
// which is what lets push/pull tell "nothing changed" apart from "one side
// changed" apart from "both sides changed" (a conflict).
//
// `conflicts` records files with an unresolved `(server copy)` sitting next
// to them from a previous pull — checked by relative path, and considered
// resolved once that conflict file is gone from disk (see local-sync.js),
// so there's no separate "mark resolved" action needed.

function dirFor() {
  return path.join(app.getPath('userData'), 'sync-state');
}

function manifestPath(projectId) {
  return path.join(dirFor(), `${projectId}.json`);
}

function loadManifest(projectId) {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(projectId), 'utf8'));
    return { files: raw.files || {}, conflicts: raw.conflicts || {}, link: raw.link || null };
  } catch {
    return { files: {}, conflicts: {}, link: null };
  }
}

function saveManifest(projectId, manifest) {
  fs.mkdirSync(dirFor(projectId), { recursive: true });
  fs.writeFileSync(manifestPath(projectId), JSON.stringify(manifest, null, 2));
}

function getFileState(projectId, relPath) {
  return loadManifest(projectId).files[relPath] || null;
}

function setFileState(projectId, relPath, state) {
  const manifest = loadManifest(projectId);
  manifest.files[relPath] = state;
  saveManifest(projectId, manifest);
}

function deleteFileState(projectId, relPath) {
  const manifest = loadManifest(projectId);
  delete manifest.files[relPath];
  saveManifest(projectId, manifest);
}

function addConflict(projectId, relPath, conflictPath) {
  const manifest = loadManifest(projectId);
  manifest.conflicts[relPath] = { conflictPath };
  saveManifest(projectId, manifest);
}

function removeConflict(projectId, relPath) {
  const manifest = loadManifest(projectId);
  delete manifest.conflicts[relPath];
  saveManifest(projectId, manifest);
}

function getConflicts(projectId) {
  return loadManifest(projectId).conflicts;
}

// Deletes the whole manifest — called on unlink, since the local files
// themselves are left in place but nothing should be tracked against them
// anymore (re-linking later starts fresh rather than trusting stale state).
function clearManifest(projectId) {
  try {
    fs.unlinkSync(manifestPath(projectId));
  } catch {
    // Nothing to clear — fine.
  }
}

// The `link` record is what makes a project's continuous sync resumable
// across app restarts without asking the user to re-pick anything: which
// local folder, which project it mirrors, and the sync mode last seen (a
// cheap fallback the engine uses only until its first real poll refreshes
// it from the server). Its mere presence is also how the engine discovers,
// on startup, *which* projects should have sync running at all.
function setLink(projectId, link) {
  const manifest = loadManifest(projectId);
  manifest.link = link;
  saveManifest(projectId, manifest);
}

function getLink(projectId) {
  return loadManifest(projectId).link;
}

// Scans userData/sync-state for every project with a link record — used at
// startup to resume continuous sync for each one without the caller needing
// to already know which projects are linked.
function listLinkedProjectIds() {
  let entries;
  try {
    entries = fs.readdirSync(dirFor());
  } catch {
    return [];
  }
  const ids = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const projectId = entry.slice(0, -'.json'.length);
    if (loadManifest(projectId).link) ids.push(projectId);
  }
  return ids;
}

module.exports = {
  loadManifest,
  saveManifest,
  getFileState,
  setFileState,
  deleteFileState,
  addConflict,
  removeConflict,
  getConflicts,
  clearManifest,
  setLink,
  getLink,
  listLinkedProjectIds,
};
