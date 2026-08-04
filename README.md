# Resync (client)

Electron desktop client: connect to your own **resync-server** (running on whichever machine you've
turned into your file server), sign in with Google (identity only — no Drive, no Drive storage),
browse projects/folders/files, upload, and preview STEP/SolidWorks files in 3D with real version
history.

Storage lives entirely on your resync-server, not in this repo. See `../resync-server/README.md`
for setting that up first — you'll need it running before this client can do anything beyond local
file preview.

## 1. Create a Google OAuth Client ID (one-time, do this yourself in your Google account)

Used purely to prove who you are when signing in — no Drive access is requested.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/), create a new project (or
   reuse one).
2. **APIs & Services → OAuth consent screen** → choose **External**, fill in the required fields,
   and add your own Google account under **Test users** (the app stays unverified/in testing mode,
   which is fine for personal use — only test users you add can sign in).
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → Application type
   **Desktop app**. Save it.
4. Copy the generated **Client ID** and **Client secret**.
5. Use the **same Client ID** when configuring `resync-server` (`resync.config.json` there) — it
   verifies the token this client obtains, so they must match.

## 2. Configure the app

Create `config.json` with your Client ID and Client secret (copy `config.example.json` as a
starting point). It's read from **outside** the app bundle so it survives rebuilds/repackaging:

- Running via `npm start`: `config.json` in the project root also works, for convenience.
- Running the packaged `.exe`: put it at `%APPDATA%\resync\config.json`.

Either location works with either way of running the app — the userData path is checked first.

## 3. Install and run (dev mode)

```bash
npm install
npm start
```

On first launch you'll be asked for your resync-server's address (e.g. `http://192.168.1.42:8420`
— its LAN IP, see `resync-server`'s README for finding it). Then click **Sign in with Google** — it
opens your system browser to the real Google consent screen (the app never sees or handles your
password). Once connected, you can create/browse projects, upload files, and preview CAD files.

## Testing just the viewer (no server needed)

```bash
npm run viewer:dev
```

Serves the renderer standalone at `http://127.0.0.1:<port>/`. Use the **Local file** picker to
load a `.step`/`.stp` file directly, or the SolidWorks decoder — useful for iterating on the 3D
viewer without a server or Google sign-in at all.

## Notes / current limitations

- LAN access only for now — remote/internet access to your resync-server isn't set up yet.
- The session token (from your resync-server, not Google) is stored encrypted via Electron
  `safeStorage` in the app's user data directory.
- The assembly tree lets you show/hide individual parts and subassemblies via checkboxes.
- No file/folder rename, move, or delete yet — additive only for now (upload, new version, browse).
- No checkout/locking yet — two people uploading a new version of the same file at once will just
  both succeed as separate versions; whoever uploads second doesn't overwrite the first.
