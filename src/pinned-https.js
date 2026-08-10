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

// Shared + keep-alive so the many requests this app fires off in quick
// succession (a single folder open can trigger several) reuse one TLS
// connection per server instead of paying a full handshake every time.
// Safe with cert pinning specifically because trust is tracked per-socket
// below, not per-call, and re-checked against the *current* pin on every
// request — a reused connection can't silently outlive a pin change.
//
// secureOptions disables OpenSSL's TLS session-ticket resumption. That
// alone wasn't enough, though — https.Agent *also* keeps its own separate
// session cache (_getSession/_cacheSession, session-ID based, nothing to
// do with tickets) and hands a cached session to a brand-new socket
// connecting to the same host. A resumed handshake — ticket- or
// session-ID-based — never retransmits the full certificate, so
// getPeerCertificate() comes back empty on that *new* socket even though
// it never reused an existing connection (verified directly: this is
// exactly what broke a fresh reconnection during testing, independent of
// the ticket setting). Every new socket needs the real certificate to
// verify against the pin, so both resumption paths have to stay off;
// neither affects keep-alive itself (reusing one already-open,
// already-verified socket across multiple requests needs no resumption at
// all, since nothing is being re-established).
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 6,
  secureOptions: require('constants').SSL_OP_NO_TICKET,
});
keepAliveAgent._getSession = () => undefined;

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

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        rejectUnauthorized: false,
        agent: keepAliveAgent,
      },
      (res) => {
        const socket = res.socket;
        // A keep-alive-reused socket skips 'secureConnect' (and the trust
        // check below) entirely — its verified fingerprint was cached on
        // the socket object itself the first time *that socket* connected.
        // Re-checked against the pin fresh on every request (not just
        // trusted forever once set) so an already-open connection verified
        // under an old pin can't bypass a since-changed one.
        if (!socket.__resyncTrustedFingerprint || socket.__resyncTrustedFingerprint !== settingsStore.getPinnedFingerprint(serverKey)) {
          res.destroy();
          // Deliberately not forcing the socket closed here — manually
          // tearing down a socket mid-response interacts with Node's own
          // agent bookkeeping and TLS session-resumption in ways that are
          // easy to get subtly wrong (verified: it is). __resyncTrustedFingerprint
          // stays stale on this socket, so every further request over it
          // keeps failing safe the same way until the connection's own
          // keep-alive timeout closes it (default: a few seconds of
          // inactivity) and the agent opens a fresh one next time — a rare
          // edge case (only reachable via an explicit pin change) that's
          // fine to self-heal on that timescale rather than forcing it.
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
      if (socket.__resyncTrustedFingerprint) return; // already verified on an earlier request over this reused socket
      socket.once('secureConnect', () => {
        const cert = socket.getPeerCertificate(false);
        if (!cert || !cert.raw) {
          req.destroy(new Error('Server did not present a TLS certificate'));
          return;
        }
        const fingerprint = fingerprintOf(cert);
        if (!pinned) {
          settingsStore.setPinnedFingerprint(serverKey, fingerprint);
          socket.__resyncTrustedFingerprint = fingerprint;
        } else if (pinned === fingerprint) {
          socket.__resyncTrustedFingerprint = fingerprint;
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
