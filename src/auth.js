const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { shell, app } = require('electron');
const { OAuth2Client } = require('google-auth-library');

// Identity only — this is the ONLY thing Google is used for now. No Drive
// scope: the resulting id_token gets handed once to the Resync server
// (server-auth.js), which verifies it and issues its own session token.
// Nothing from Google is persisted after that handoff.
const SCOPES = ['openid', 'email', 'profile'];

// Checked out-of-tree first (survives `npm start` dev runs), then falls back
// to the project root. Keeping this outside the app bundle means it's never
// wiped when the packaged .exe gets rebuilt as we add features.
function configCandidates() {
  return [path.join(app.getPath('userData'), 'config.json'), path.join(__dirname, '..', 'config.json')];
}

function loadConfig() {
  const candidate = configCandidates().find((p) => fs.existsSync(p));
  if (!candidate) {
    throw new Error(
      `Missing config.json. Create it at ${path.join(app.getPath('userData'), 'config.json')} ` +
        '(copy config.example.json and fill in your Google OAuth Client ID/secret — see README.md).'
    );
  }
  return JSON.parse(fs.readFileSync(candidate, 'utf8'));
}

function createClient() {
  const { clientId, clientSecret } = loadConfig();
  return new OAuth2Client({ clientId, clientSecret });
}

// RFC 8252 "installed app" loopback flow: spin up a one-shot local HTTP
// server, send the user to Google's real consent screen in their system
// browser (never automated), and capture the redirect containing the code.
function startLoopbackServer(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let resolveCode, rejectCode;
    const codePromise = new Promise((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const error = url.searchParams.get('error');
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (error || state !== expectedState || !code) {
        res.end('<html><body><h3>Sign-in failed. You can close this tab and return to the app.</h3></body></html>');
        rejectCode(new Error(error || 'Invalid OAuth state or missing code'));
      } else {
        res.end('<html><body><h3>Signed in. You can close this tab and return to the app.</h3></body></html>');
        resolveCode(code);
      }
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        redirectUri: `http://127.0.0.1:${port}/oauth2callback`,
        waitForCode: () => codePromise,
        close: () => server.close(),
      });
    });
  });
}

// Runs the loopback flow once and returns Google's id_token — a one-time
// proof of identity, not a credential this app holds onto afterward.
async function signInWithGoogle() {
  const client = createClient();
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = crypto.randomBytes(16).toString('hex');

  const { redirectUri, waitForCode, close } = await startLoopbackServer(state);

  const authUrl = client.generateAuthUrl({
    scope: SCOPES,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  await shell.openExternal(authUrl);

  try {
    const code = await waitForCode();
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.id_token) throw new Error('Google did not return an id_token');
    return tokens.id_token;
  } finally {
    close();
  }
}

module.exports = { signInWithGoogle };
