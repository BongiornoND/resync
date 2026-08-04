const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Just the Resync server URL for now — replaces the old projects-store.js
// entirely (that whole "linked Drive folder" workaround only existed
// because Drive couldn't be written to across accounts; irrelevant now that
// the server owns storage outright).
function storePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch {
    return {};
  }
}

function save(settings) {
  fs.writeFileSync(storePath(), JSON.stringify(settings, null, 2));
}

// Normalizes a user-typed server address to a full https:// URL — the
// server only ever listens on HTTPS (self-signed cert, pinned on first
// connect — see pinned-https.js), so "192.168.1.42:8420" and
// "http://192.168.1.42:8420" both become "https://192.168.1.42:8420".
// Both the connect-time health check and every later request need to
// agree on this exact string, since it's the key the certificate pin is
// stored under.
function normalizeServerUrl(input) {
  let url = input.trim().replace(/\/+$/, '');
  if (url.startsWith('http://')) url = 'https://' + url.slice('http://'.length);
  else if (!url.startsWith('https://')) url = 'https://' + url;
  return url;
}

function getServerUrl() {
  return load().serverUrl || null;
}

function setServerUrl(serverUrl) {
  const settings = load();
  settings.serverUrl = normalizeServerUrl(serverUrl);
  save(settings);
}

// TLS certificate pinning (trust-on-first-use, same model as SSH's
// known_hosts) — a self-signed server has no real CA to vouch for it, so
// the client remembers the certificate fingerprint it saw the first time
// and refuses to silently accept a different one later. Keyed by server
// URL so switching servers doesn't collide with an old pin.
function getPinnedFingerprint(serverUrl) {
  return (load().pinnedFingerprints || {})[serverUrl] || null;
}

function setPinnedFingerprint(serverUrl, fingerprint) {
  const settings = load();
  settings.pinnedFingerprints = settings.pinnedFingerprints || {};
  settings.pinnedFingerprints[serverUrl] = fingerprint;
  save(settings);
}

function clearPinnedFingerprint(serverUrl) {
  const settings = load();
  if (settings.pinnedFingerprints) delete settings.pinnedFingerprints[serverUrl];
  save(settings);
}

// The local root folder projects get mirrored into — e.g. "C:\Users\me\Resync".
// Each project gets its own subfolder inside it.
function getSyncFolder() {
  return load().syncFolder || null;
}

function setSyncFolder(folderPath) {
  const settings = load();
  settings.syncFolder = folderPath;
  save(settings);
}

module.exports = {
  getServerUrl,
  setServerUrl,
  normalizeServerUrl,
  getPinnedFingerprint,
  setPinnedFingerprint,
  clearPinnedFingerprint,
  getSyncFolder,
  setSyncFolder,
};
