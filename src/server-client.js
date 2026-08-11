const fs = require('fs');
const settingsStore = require('./settings-store');
const serverAuth = require('./server-auth');
const { pinnedFetch, CertificateMismatchError } = require('./pinned-https');

async function apiFetch(pathname, options = {}) {
  const serverUrl = settingsStore.getServerUrl();
  if (!serverUrl) throw new Error('No server configured');
  const token = serverAuth.getToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return pinnedFetch(serverUrl + pathname, { ...options, headers });
}

// Every route here is assumed to answer with JSON, but that's only true
// when the client and server are the same version — an older server
// missing a newer route (or a proxy/crash in between) answers with an HTML
// error page instead, and res.json() throws a raw parse error before the
// !res.ok check ever runs. Parsing defensively here means a version
// mismatch surfaces as a real, readable error instead of a JSON syntax
// exception with no useful message.
async function parseJsonBody(res, fallbackLabel) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    // not JSON — data stays null, handled below
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `${fallbackLabel} (${res.status} ${res.statusText || 'error'})`);
  }
  return data || {};
}

async function checkHealth(serverUrl) {
  const res = await pinnedFetch(serverUrl.replace(/\/+$/, '') + '/health');
  if (!res.ok) throw new Error('Server not responding');
  try {
    return await res.json();
  } catch {
    throw new Error('That address answered, but not as a Resync server');
  }
}

async function listProjects() {
  const res = await apiFetch('/api/projects');
  const data = await parseJsonBody(res, 'Failed to list projects');
  return data.projects;
}

async function createProject(name) {
  const res = await apiFetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await parseJsonBody(res, 'Failed to create project');
  return data;
}

async function deleteProject(projectId) {
  const res = await apiFetch(`/api/projects/${projectId}`, { method: 'DELETE' });
  const data = await parseJsonBody(res, 'Failed to delete project');
  return data;
}

async function getFolder(folderId) {
  const res = await apiFetch(`/api/folders/${folderId}`);
  const data = await parseJsonBody(res, 'Failed to load folder');
  return data;
}

async function createFolder(parentId, name) {
  const res = await apiFetch('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId, name }),
  });
  const data = await parseJsonBody(res, 'Failed to create folder');
  return data;
}

async function shareProject(projectId, email, role = 'member') {
  const res = await apiFetch(`/api/projects/${projectId}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role }),
  });
  const data = await parseJsonBody(res, 'Failed to share project');
  return data;
}

async function unshareProject(projectId, email) {
  const res = await apiFetch(`/api/projects/${projectId}/share`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await parseJsonBody(res, 'Failed to remove member');
  return data;
}

async function getProjectMembers(projectId) {
  const res = await apiFetch(`/api/projects/${projectId}/members`);
  const data = await parseJsonBody(res, 'Failed to load members');
  return data;
}

async function updateMemberRole(projectId, userId, role) {
  const res = await apiFetch(`/api/projects/${projectId}/members/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  const data = await parseJsonBody(res, 'Failed to update role');
  return data;
}

async function updateProjectSyncMode(projectId, syncMode) {
  const res = await apiFetch(`/api/projects/${projectId}/sync-mode`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ syncMode }),
  });
  const data = await parseJsonBody(res, 'Failed to update sync mode');
  return data;
}

async function uploadProjectCover(projectId, filePath, mimeType) {
  const res = await apiFetch(`/api/projects/${projectId}/cover`, {
    method: 'POST',
    headers: { 'X-Content-Type': mimeType },
    body: fs.createReadStream(filePath),
    duplex: 'half',
  });
  const data = await parseJsonBody(res, 'Cover upload failed');
  return data;
}

async function downloadProjectCover(projectId) {
  const res = await apiFetch(`/api/projects/${projectId}/cover`);
  if (!res.ok) return null; // no cover set, or no access — either way, nothing to show
  return Buffer.from(await res.arrayBuffer());
}

// filePath is a real path on disk (from dialog.showOpenDialog) — streamed
// straight from disk into the request, never round-tripped through the
// renderer as bytes.
async function uploadFile(folderId, filePath, fileName) {
  const res = await apiFetch('/api/files', {
    method: 'POST',
    headers: { 'X-Folder-Id': String(folderId), 'X-File-Name': fileName },
    body: fs.createReadStream(filePath),
    duplex: 'half',
  });
  const data = await parseJsonBody(res, 'Upload failed');
  return data;
}

async function uploadVersion(fileId, filePath, message) {
  const headers = {};
  if (message) headers['X-Version-Message'] = encodeURIComponent(message);
  const res = await apiFetch(`/api/files/${fileId}/versions`, {
    method: 'POST',
    headers,
    body: fs.createReadStream(filePath),
    duplex: 'half',
  });
  const data = await parseJsonBody(res, 'Upload failed');
  return data;
}

async function restoreVersion(fileId, versionId) {
  const res = await apiFetch(`/api/files/${fileId}/versions/${versionId}/restore`, { method: 'POST' });
  const data = await parseJsonBody(res, 'Restore failed');
  return data;
}

async function listVersions(fileId) {
  const res = await apiFetch(`/api/files/${fileId}/versions`);
  const data = await parseJsonBody(res, 'Failed to list versions');
  return data.versions;
}

async function downloadVersion(versionId) {
  const res = await apiFetch(`/api/versions/${versionId}/download`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Download failed');
  }
  return Buffer.from(await res.arrayBuffer());
}

async function checkoutFile(fileId) {
  const res = await apiFetch(`/api/files/${fileId}/checkout`, { method: 'POST' });
  const data = await parseJsonBody(res, 'Checkout failed');
  return data.lock;
}

async function checkinFile(fileId) {
  const res = await apiFetch(`/api/files/${fileId}/checkin`, { method: 'POST' });
  const data = await parseJsonBody(res, 'Check-in failed');
  return data.lock;
}

async function updateFile(fileId, { name, folderId } = {}) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (folderId !== undefined) body.folderId = folderId;
  const res = await apiFetch(`/api/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await parseJsonBody(res, 'Update failed');
  return data;
}

async function deleteFile(fileId) {
  const res = await apiFetch(`/api/files/${fileId}`, { method: 'DELETE' });
  const data = await parseJsonBody(res, 'Delete failed');
  return data;
}

async function restoreFile(fileId) {
  const res = await apiFetch(`/api/files/${fileId}/restore`, { method: 'POST' });
  const data = await parseJsonBody(res, 'Restore failed');
  return data;
}

async function updateFolder(folderId, { name, parentId } = {}) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (parentId !== undefined) body.parentId = parentId;
  const res = await apiFetch(`/api/folders/${folderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await parseJsonBody(res, 'Update failed');
  return data;
}

async function deleteFolder(folderId) {
  const res = await apiFetch(`/api/folders/${folderId}`, { method: 'DELETE' });
  const data = await parseJsonBody(res, 'Delete failed');
  return data;
}

async function restoreFolder(folderId) {
  const res = await apiFetch(`/api/folders/${folderId}/restore`, { method: 'POST' });
  const data = await parseJsonBody(res, 'Restore failed');
  return data;
}

async function getTrash(projectId) {
  const res = await apiFetch(`/api/projects/${projectId}/trash`);
  const data = await parseJsonBody(res, 'Failed to load trash');
  return data;
}

async function getProjectFolders(projectId) {
  const res = await apiFetch(`/api/projects/${projectId}/folders`);
  const data = await parseJsonBody(res, 'Failed to load project folders');
  return data;
}

// { query, tags, exts, kind, by, size, locked } — matches the search box's
// tag:/type:/by:/size:/locked: operators (see app.js's parseSearchQuery).
// kind is 'all' | 'files' | 'folders'; by/size/locked are forwarded as raw
// strings for the server to interpret (see resync-server's search route).
async function searchProject(projectId, { query = '', tags = [], exts = [], kind = 'all', by = '', size = '', locked = '' } = {}) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (tags.length) params.set('tag', tags.join(','));
  if (exts.length) params.set('ext', exts.join(','));
  if (kind !== 'all') params.set('kind', kind);
  if (by) params.set('by', by);
  if (size) params.set('size', size);
  if (locked) params.set('locked', locked);
  const res = await apiFetch(`/api/projects/${projectId}/search?${params.toString()}`);
  const data = await parseJsonBody(res, 'Search failed');
  return data;
}

async function getProjectActivity(projectId) {
  const res = await apiFetch(`/api/projects/${projectId}/activity`);
  const data = await parseJsonBody(res, 'Failed to load activity');
  return data.entries;
}

async function listNotifications() {
  const res = await apiFetch('/api/notifications');
  const data = await parseJsonBody(res, 'Failed to load notifications');
  return data;
}

async function markNotificationRead(id) {
  const res = await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' });
  const data = await parseJsonBody(res, 'Failed to update notification');
  return data;
}

async function markAllNotificationsRead() {
  const res = await apiFetch('/api/notifications/read-all', { method: 'POST' });
  const data = await parseJsonBody(res, 'Failed to update notifications');
  return data;
}

async function listProjectTags(projectId) {
  const res = await apiFetch(`/api/projects/${projectId}/tags`);
  const data = await parseJsonBody(res, 'Failed to load tags');
  return data.tags;
}

async function createTag(projectId, name, color) {
  const res = await apiFetch(`/api/projects/${projectId}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color }),
  });
  const data = await parseJsonBody(res, 'Failed to create tag');
  return data;
}

async function deleteTag(tagId) {
  const res = await apiFetch(`/api/tags/${tagId}`, { method: 'DELETE' });
  const data = await parseJsonBody(res, 'Failed to delete tag');
  return data;
}

async function addFileTag(fileId, tagId) {
  const res = await apiFetch(`/api/files/${fileId}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tagId }),
  });
  const data = await parseJsonBody(res, 'Failed to add tag');
  return data;
}

async function removeFileTag(fileId, tagId) {
  const res = await apiFetch(`/api/files/${fileId}/tags/${tagId}`, { method: 'DELETE' });
  const data = await parseJsonBody(res, 'Failed to remove tag');
  return data;
}

module.exports = {
  checkHealth,
  listProjects,
  createProject,
  deleteProject,
  shareProject,
  unshareProject,
  getProjectMembers,
  updateMemberRole,
  updateProjectSyncMode,
  uploadProjectCover,
  downloadProjectCover,
  getFolder,
  createFolder,
  uploadFile,
  uploadVersion,
  restoreVersion,
  listVersions,
  downloadVersion,
  checkoutFile,
  checkinFile,
  updateFile,
  deleteFile,
  restoreFile,
  updateFolder,
  deleteFolder,
  restoreFolder,
  getTrash,
  getProjectFolders,
  searchProject,
  getProjectActivity,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  listProjectTags,
  createTag,
  deleteTag,
  addFileTag,
  removeFileTag,
  CertificateMismatchError,
};
