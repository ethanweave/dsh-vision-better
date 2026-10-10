# Publishing checklist

Status: **everything below is prepared but not executed.** No npm publish, no GitHub push, no pull request,
no release has been created - those need the repository owner's explicit authorization.

## 1. Package contents (verified)

`npm pack --dry-run` on this checkout (2026-10-10):

```
name: dsh-vision-better@0.1.0
tarball size: 37,170 bytes    unpacked: 113,044 bytes    files: 21
```

| Path | Purpose |
|---|---|
| `package.json` | bundle metadata: `dsh.bundle.patch`, `dsh.client.platform: "web"`, `engines.dsh` |
| `cordis.patch.yml` | the row a profile inserts (`id: vision-better`, `name: dsh-vision-better`) |
| `lib/index.js` | host plugin: routing, `agent/pre-step`, `session/image-admission`, route mounting |
| `lib/{defaults,routing,config,images,glm,cache,relay,routes,safe}.js` | host modules (no dependencies) |
| `client/client.js` | browser half: the Settings page, hand-written lazy-CJS bundle |
| `README.md`, `README.zh-CN.md` | feature, install, configuration, privacy, troubleshooting, uninstall |
| `CHANGELOG.md`, `SECURITY.md`, `LICENSE` | release notes, security policy, MIT license |
| `examples/vision-better.example.json` | example of the plugin's own config file |

Not published (development-only): `patches/`, `scripts/`, `test/`, `docs/`, `awesome/`, `.github/`.
They stay in the repository, which is what the awesome-list entry links to.

## 2. Before any release

1. Replace every `REPLACE-WITH-YOUR-ACCOUNT` placeholder - `package.json` (`repository`, `bugs`, `homepage`),
   `CHANGELOG.md` compare links, `awesome/dsh-vision-better.yml`.
2. Run the full gate: `node scripts/check.mjs --dsh-src <dsh-source-root>` - expect the syntax gate, the core
   patch verification, the 43 host-path checks, the 24 client-bundle checks, and the 129-test unit suite to
   pass.
3. Re-check the vision defaults against the provider's official docs and update the "verified on" date in
   `lib/defaults.js` and both READMEs if they moved.
4. Confirm no secret is present: `git grep -nE 'sk-|Bearer [A-Za-z0-9]{16,}'` and check `.credentials.yaml`
   is not tracked.
5. Optionally publish the source repository first and set the `dsh-plugin` GitHub topic (required by the
   awesome-list CI).

## 3. npm (optional)

The name `dsh-vision-better` was free on the public registry when checked (2026-10-10). Publishing is optional:
the awesome-list CI only requires `dsh.bundle` in `package.json`, and the market falls back to a GitHub
install. If you publish:

```bash
npm publish --access public
```

then the install command becomes exactly:

```bash
dsh plugin --profile web add dsh-vision-better
```

## 4. awesome-dsh-plugin (the listing that matters)

The market (`dshmarket`) reads `https://awesome-dsh-plugin.com/plugins.json`, which is **generated from the
awesome list**. There is no separate market submission - a listing PR is the whole flow.

1. Fork `github.com/awesome-dsh-plugin/awesome-dsh-plugin`.
2. Copy `awesome/dsh-vision-better.yml` to `data/plugins/<owner>__<repo>.yml`, matching your repository name
   exactly, and fill in the real `url` and `name`.
3. Open **one** pull request adding that single file (max 3 entries per PR).

Verified requirements (contributing.md, checked 2026-10-10): `dsh.bundle` must be declared in the package's
`package.json` (it is), the repository must be at least a day old, the description must match the code, the
category list includes `vision` (used here), and the repo should carry the `dsh-plugin` topic. A `: ` inside a
description must be quoted - this entry quotes both descriptions.

## 5. Release

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Attach the `npm pack` tarball to the GitHub release if you want a `tarball:`-based install. The catalog
requires the tarball to be hosted on the entry's own GitHub release hosting.

## 6. What still needs a human

| Item | Why it is not done here |
|---|---|
| npm publish | Requires the owner's registry credentials and explicit authorization |
| Creating the GitHub repository / pushing | Not authorized, and the owner must own the account |
| Opening the awesome-list PR | Not authorized; needs the real repository URL |
| Applying the core patch to an installed DSH | Changes the user's application; documented in `patches/README.md` for the owner to apply |
| Upstreaming `session/image-admission` to DSH | Needs a DSH repository contribution; the separate patch is the reviewable artifact |
| A real-endpoint smoke test | Requires a real API key; the automated path uses a stub only |
| Installing the bundle into the live profile | Changes the user's DSH state and needs a restart; the command is in the README |
