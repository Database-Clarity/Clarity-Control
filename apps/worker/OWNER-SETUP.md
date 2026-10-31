# Owner setup (StardustD2)

These are instructions for the owner to carry out later. Creating this Worker
package does **not** deploy it, publish any tooltip, or merge anything into main.
Keep `LIVE_BRANCH=converter-v2-test` until an explicit production cut-over.

## 1. Prepare the computer and Cloudflare account

1. Install Node.js 24 LTS from <https://nodejs.org/> if needed. Open this
   repository's `v2` checkout in VS Code. Open **Terminal → New Terminal**.
2. Run `npm ci` in the repository root. Then run
   `Set-Location apps\worker`. All remaining terminal commands in this guide are
   run in that folder, unless stated otherwise.
3. Go to <https://dash.cloudflare.com/sign-up>, create or sign in to a Cloudflare
   account, and verify your email.
4. In the terminal run `npx wrangler login`. A browser opens. Check that the
   intended Cloudflare account is selected and click **Allow**. Run
   `npx wrangler whoami` to confirm the account.
5. In Cloudflare, open **Workers & Pages** (sometimes under **Compute**). Follow
   the prompt to choose your account's `workers.dev` subdomain if you have not
   done so. The Worker name in `wrangler.jsonc` is `clarity-editor-api`.
   Your expected API address is
   `https://clarity-editor-api.YOUR-SUBDOMAIN.workers.dev`.
   Write down that address, without a trailing slash. It is not the website URL.

## 2. Create a GitHub App owned by the organization

1. Sign in to <https://github.com/> as **StardustD2** (organization owner).
2. Click your profile picture → **Your organizations** → **Database-Clarity**
   → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**.
   The direct organization settings page is
   <https://github.com/organizations/Database-Clarity/settings/apps>.
   Do not create an OAuth App; choose **GitHub App**.
3. Enter a unique App name, for example `Clarity Editor Backend`. Set
   **Homepage URL** to the editor website's actual HTTPS address.
4. Under **Identifying and authorizing users**, set **Callback URL** to
   `https://clarity-editor-api.YOUR-SUBDOMAIN.workers.dev/auth/callback`.
   Replace the subdomain with the one from step 1.
5. Leave **Request user authorization (OAuth) during installation** **unchecked**.
   Installing the App and signing in to the editor are separate steps. The
   editor's `/auth/login` endpoint starts user authorization explicitly.
   Leave **Enable Device Flow** unchecked. Expiring user authorization tokens may
   stay enabled: this Worker uses the user token once and then discards it.
6. Leave **Setup URL** blank. Under **Webhook**, uncheck **Active**: this Worker
   does not receive webhooks.
7. Expand **Repository permissions**. Set **Contents** and **Actions** to **Read and write**.
   Actions access is used only to refresh Compendium data and read refresh status.
   **Metadata: Read-only** is automatically required by GitHub. Leave **all
   other repository permissions**, all organization permissions, and all account
   permissions at **No access**. Do not request Administration,
   Workflows, Members, or email permissions. No event subscriptions are needed.
8. Under **Where can this GitHub App be installed?**, select **Only on this
   account**. Click **Create GitHub App**.
9. On the App settings page, copy the numeric **App ID** and **Client ID**
   (usually starts `Iv...` or `Ov...`). Record the App's URL slug from the last
   part of its public URL, for example `clarity-editor-backend`.
10. Click **Generate a new client secret**. Copy it now into a password manager:
    GitHub will not show it again.
11. Under **Private keys**, click **Generate a private key**. A `.pem` file
    downloads. Keep it private; do not put it in the repository, chat or screenshots.

## 3. Install on the two data repositories

1. On the App's settings page, click **Install App** in the left menu.
2. Choose **Database-Clarity** → **Install**.
3. Select **Only select repositories**, then select **Live-Clarity-Database**
   and **Compendium-data**, and no others. Confirm that GitHub shows Contents and Actions read/write and
   Metadata read-only. Click **Install**.
4. The resulting page URL contains `/installations/12345678`. Record that
   number as `GITHUB_INSTALLATION_ID`; it is different from the App ID.
5. Confirm the repository has `editor-data` with `tooltips/`,
   `config/permissions.json`, and `live/pushed.json`. In the permissions file,
   StardustD2's **numeric GitHub user id** must have role `maintainer`.
   The login is display information; access checks use the numeric id.
6. Before test publishing, create **`converter-v2-test` from `converter`** using
   the repository branch selector → type `converter-v2-test` → **Create branch
   from converter**. It must include `liveDescriptions.json`. Do not edit or push
   the production `converter`, `live` or `main` branches.
   Testing marks the selected records in the configured data branch's
   `live/pushed.json`; prefer a complete scratch repository for local tests.
7. `Database-Clarity/Compendium-data` is a separate public repository. Its
   default `main` branch holds the daily/manual `compendium.yml` Action,
   dependency-free runner/parser and `compendium.json`; see the editor's
   `scripts/compendium/README.md` for the reviewed bootstrap/update procedure.
   Enable Actions and its Contents write permission in that repository.
   Existing App installations must accept the new Actions permission and add
   this repository. A refresh failure does not block ordinary translation saves.
   The Worker never parses spreadsheet HTML; it only dispatches the Action.

## 4. Set non-secret configuration

1. Open this package's `wrangler.jsonc` in VS Code.
2. Set `SITE_ORIGIN` to the website **origin only**, for example
   `https://database-clarity.github.io` (no path or trailing slash).
3. Set `SITE_URL` to the actual v2 website URL including its path and trailing
   slash, for example `https://database-clarity.github.io/Description-editor/`.
   It must have the same origin as `SITE_ORIGIN`. Do not point v2 at the legacy
   production editor unless that is the intended website.
4. Keep repository `Database-Clarity/Live-Clarity-Database`, data branch
   `editor-data`, generator `Database-Clarity/Description-data-generator` branch
   `v2`, and live target **`converter-v2-test`**. Do not change to `converter`
   during this setup.
5. Add string entries inside `vars` for the non-secret identifiers:

   ```json
   "GITHUB_APP_ID": "YOUR-NUMERIC-APP-ID",
   "GITHUB_APP_SLUG": "your-app-slug",
   "GITHUB_INSTALLATION_ID": "YOUR-INSTALLATION-ID",
   "GITHUB_CLIENT_ID": "YOUR-CLIENT-ID",
   "OAUTH_CALLBACK_URL": "https://clarity-editor-api.YOUR-SUBDOMAIN.workers.dev/auth/callback"
   ```

   Add a comma between existing JSON entries. Client ID, App ID and installation
   ID are identifiers, not passwords. Never put secrets in `vars`.

## 5. Store secrets in Cloudflare

1. In the terminal, still in `apps\worker`, run
   `npx wrangler secret put GITHUB_CLIENT_SECRET`. Paste the client secret from
   step 2 when prompted, then press Enter. If asked whether to create the Worker
   first, agree. This creates a secret container; it is not a tooltip publish.
2. GitHub downloads an RSA PKCS#1 key, but Web Crypto requires **PKCS#8**.
   Make a **private temporary folder outside this repository**, copy the
   downloaded file into it, and rename that copy to `github-app.pem`.
   Substitute your actual Windows user folder in this PowerShell command:

   ```powershell
   node -e "const fs=require('node:fs'); const crypto=require('node:crypto'); const p='C:\\Users\\YOUR-WINDOWS-USER\\Downloads\\clarity-private\\'; fs.writeFileSync(p+'github-app-pkcs8.pem', crypto.createPrivateKey(fs.readFileSync(p+'github-app.pem')).export({type:'pkcs8',format:'pem'}));"
   Get-Content -Raw 'C:\Users\YOUR-WINDOWS-USER\Downloads\clarity-private\github-app-pkcs8.pem' | npx wrangler secret put GITHUB_PRIVATE_KEY
   ```

   The new file begins `-----BEGIN PRIVATE KEY-----`, **not**
   `-----BEGIN RSA PRIVATE KEY-----`. Do not paste the key into a JS/TS file.

3. Generate a session secret:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
   npx wrangler secret put SESSION_SECRET
   ```

   Copy the generated string into the prompt. Save it privately if needed.
   Rotating this secret signs everyone out. Sessions expire after 30 days;
   removing a user from permissions stops their writes immediately.

4. Run `npx wrangler secret list`. Confirm the three **names** appear:
   `GITHUB_CLIENT_SECRET`, `GITHUB_PRIVATE_KEY`, `SESSION_SECRET`. This command
   does not reveal their values. Delete only your specific temporary key files
   after storing a secure backup in your password manager.

## 6. Check and deploy (owner action)

1. From the repository root run `npm run typecheck`, `npm run lint`, and
   `npm test`. Return to `apps\worker`.
2. Run `npx wrangler deploy --dry-run`. This bundles the Worker without deploying.
   If it fails, stop and investigate; do not work around authentication errors.
3. When you are ready to create the live API, run `npx wrangler deploy`.
   This is an explicit **owner deployment step**, not something agents run.
   Copy the printed `https://...workers.dev` address.
4. If the printed address differs from your anticipated one, update both the
   GitHub App **Callback URL** and `OAUTH_CALLBACK_URL`, then deploy again.
5. In the web app build configuration, set
   `VITE_API_URL=https://clarity-editor-api.YOUR-SUBDOMAIN.workers.dev`
   (no trailing slash). Rebuild/redeploy the **v2 web app**, not legacy main.
6. Open `<your-api-url>/auth/login` in a browser. Authorize the App as StardustD2.
   You should return to the website and see maintainer access. The website must
   support `#/auth/callback?session=...`; the session is not an OAuth access token.
7. Make one harmless edit on a scratch setup and save. In GitHub's data-branch
   history, verify the author is **StardustD2**, and the committer is the App bot.
   Test publishing only to **converter-v2-test**. Do not push production live.

## 7. Local development without touching production

1. Create a private scratch repository under your own account. Copy the
   `editor-data` and test converter data into branches in it. Register/install a
   **separate test GitHub App**, limited to that scratch repository. The production
   App above remains installed on Live-Clarity-Database only.
2. For the test App, set callback `http://localhost:8787/auth/callback`.
3. Copy `.dev.vars.example` to `.dev.vars` in `apps\worker`. Fill in the test
   App credentials, scratch owner/repo, scratch data/live branches, local site
   values and a fresh session secret. Private key format is PKCS#8; the example
   shows escaped `\n` newlines. `.dev.vars` is gitignored; do not override that.
4. Run `npm run dev --workspace @clarity/worker` from the repository root.
   In another terminal run the web app at `http://localhost:5173`, with
   `VITE_API_URL=http://localhost:8787`.
5. Sign in using `http://localhost:8787/auth/login`. All normal OAuth,
   signatures and permission checks still run locally.

## Troubleshooting

- **401 / state mismatch:** start again at `/auth/login` in the same browser;
  permit its short-lived cookie and use the exact callback host (do not mix
  `127.0.0.1` with `localhost`).
- **403:** ensure the signed-in numeric id has the right role. Trial users
  cannot publish; translators can change only their assigned languages.
- **GitHub authentication failure:** check App ID vs installation ID, selected
  repository installation, client secret, and PKCS#8 key format.
- **Missing file / branch:** inspect the configured repository and branches;
  the API does not silently create missing data.
- **Partial push (`pushedRecorded: false`):** the target already changed; inspect
  `liveCommit`, then retry the selection to reconcile the marker. Never assume
  a failed publish means no file changed.
- **Logs:** in Cloudflare open Workers & Pages → clarity-editor-api →
  **Observability / Logs**, or use `npx wrangler tail`. Do not share bearer
  tokens, client secrets or private keys in debugging reports.
