const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeStorage, app } = require('electron');
const { signInWithGoogle } = require('./auth');
const settingsStore = require('./settings-store');
const { pinnedFetch } = require('./pinned-https');

// Same storage pattern the old Drive-token code used, just holding a
// different payload: our own Resync session token instead of Google's.
function tokenStorePath() {
  return path.join(app.getPath('userData'), 'session.enc');
}

function saveToken(token) {
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, 'utf8');
  fs.writeFileSync(tokenStorePath(), data);
}

function loadToken() {
  const storePath = tokenStorePath();
  if (!fs.existsSync(storePath)) return null;
  const data = fs.readFileSync(storePath);
  return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(data) : data.toString('utf8');
}

function clearToken() {
  const storePath = tokenStorePath();
  if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
}

async function apiFetch(pathname, options = {}) {
  const serverUrl = settingsStore.getServerUrl();
  if (!serverUrl) throw new Error('No server configured');
  return pinnedFetch(serverUrl + pathname, options);
}

async function login() {
  const idToken = await signInWithGoogle();
  const res = await apiFetch('/api/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Label': os.hostname() },
    body: JSON.stringify({ idToken }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  saveToken(data.token);
  return data.user;
}

async function logout() {
  const token = loadToken();
  if (token) {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch {
      // best effort — clear the local token regardless of server reachability
    }
  }
  clearToken();
}

async function status() {
  const token = loadToken();
  if (!token) return { signedIn: false };
  try {
    const res = await apiFetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { signedIn: false };
    const data = await res.json();
    return { signedIn: true, profile: data.user };
  } catch {
    return { signedIn: false };
  }
}

function getToken() {
  return loadToken();
}

module.exports = { login, logout, status, getToken };
