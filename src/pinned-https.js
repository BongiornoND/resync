const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const settingsStore = require('./settings-store');

// The server's certificate is self-signed (no real CA for a box on
// someone's LAN), so the usual chain-of-trust check is off
// (rejectUnauthorized: false) and replaced with trust-on-first-use
// fingerprint pinning — same model as SSH's known_hosts. The trust
// decision is made by hand in the 'secureConnect' handler below and
// enforced by destroying the socket synchronously on mismatch, *not* via
// the `checkServerIdentity` option — that hook is documented for hostname
// verification, but empirically does NOT abort the connection when
// rejectUnauthorized is false (verified directly against this server
// before writing this), so relying on it here would silently provide no
// protection at all.
class CertificateMismatchError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CertificateMismatchError';
    this.details = details;
  }
}

function fingerprintOf(cert) {
  return crypto.createHash('sha256').update(cert.raw).digest('hex');
}

// A stale/unreachable LAN IP (server moved, DHCP lease renewed) often isn't
// actively refused — the OS just gets silence, and Node's default connect
// timeout can be minutes or effectively unbounded. Fail fast instead so the
// UI can actually offer "change server address" in a reasonable window.
const REQUEST_TIMEOUT_MS = 10000;

function pinnedFetch(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (err) {
      reject(err);
      return;
    }

    const serverKey = url.origin;
    const pinned = settingsStore.getPinnedFingerprint(serverKey);
    let trusted = false;

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        rejectUnauthorized: false,
        // The certificate check below runs in 'secureConnect', which only
        // fires on a fresh TLS handshake — a keep-alive-reused socket skips
        // it entirely, and this app's request volume is low enough that
        // the cost of a full handshake per call is not worth reasoning
        // about that edge case for. Verified empirically: without this,
        // the second request over a reused connection was correctly (but
        // unhelpfully) rejected by the "no verified cert" fail-closed check.
        agent: false,
      },
      (res) => {
        if (!trusted) {
          // Unreachable in practice — the socket is destroyed synchronously
          // in 'secureConnect' on any mismatch, before a response can
          // arrive — but never hand back a body without an explicit trust
          // decision having been made first.
          res.destroy();
          reject(new Error('Refusing to process a response without a verified TLS certificate'));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            json: async () => (body.length ? JSON.parse(body.toString('utf8')) : {}),
            arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
          });
        });
        res.on('error', reject);
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Could not reach the server (timed out after ${REQUEST_TIMEOUT_MS / 1000}s) — check the server address.`));
    });

    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        const cert = socket.getPeerCertificate(false);
        if (!cert || !cert.raw) {
          req.destroy(new Error('Server did not present a TLS certificate'));
          return;
        }
        const fingerprint = fingerprintOf(cert);
        if (!pinned) {
          settingsStore.setPinnedFingerprint(serverKey, fingerprint);
          trusted = true;
        } else if (pinned === fingerprint) {
          trusted = true;
        } else {
          req.destroy(
            new CertificateMismatchError(
              "This server's security certificate has changed since you last connected. " +
                'If the server was reinstalled or its data reset, that\'s expected — reconnecting will trust the new one. ' +
                'Otherwise, someone may be intercepting the connection — verify with the server operator before proceeding.',
              { serverKey, pinned, actual: fingerprint }
            )
          );
        }
      });
    });

    req.on('error', reject);

    const body = options.body;
    if (body && typeof body.pipe === 'function') {
      body.on('error', (err) => req.destroy(err));
      body.pipe(req);
    } else if (body != null) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

module.exports = { pinnedFetch, CertificateMismatchError };
