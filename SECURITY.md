# Security Policy

## Reporting a vulnerability

Open a private security advisory on the repository (GitHub → **Security** → **Report a vulnerability**), or
email the maintainer listed in `package.json`. Please do not open a public issue for a suspected
vulnerability. Include the version, the DSH version, and a minimal reproduction; never include a real API key,
a real image, or a session log.

Expected first response: within 7 days. Confirmed issues are fixed on `main` and noted in `CHANGELOG.md`.

## What this plugin may access

| Surface | Access |
|---|---|
| Network | Outbound HTTPS **only** to the endpoint you configured in Settings, `/chat/completions`, one POST per turn. `redirect: "error"` prevents a credential from following a redirect. |
| Credentials | One reference, `GLM_API_KEY`, read per request through DSH's credential service. Never logged, never returned to the browser, never written to the plugin's own config file. |
| Attachments | Read-only, through DSH's attachment service, only for references carried by the user's own message in the current turn. The plugin accepts no path, URL, or attachment id from the browser. |
| Files | One configuration file it owns: `<DSH_HOME>/vision-better.json` (endpoint, model, enabled). |
| Local HTTP | Four routes under `/vision-better/api/*` on DSH's loopback web server, same-origin checked, JSON-only, 8 KiB body cap. They never return a secret. |
| Shell / processes | None. |

## Out of scope for this policy

- Anything a hostile *vision endpoint* returns: its text is treated as untrusted data, but it still reaches the
  model as an analysis. Choose your provider as carefully as you choose your model.
- The provider's own retention and processing of the images you send it. The settings page states plainly that
  images are forwarded to the endpoint you configure.
- The core patch in `patches/` changes DSH itself; its trust boundary is DSH's, and it is reviewed as a
  separate change (see `patches/README.md`).

## Known limitations

- DSH's credential file (`~/.dsh/.credentials.yaml`) is plaintext YAML protected by file permissions only, and
  DSH skips the permission check on Windows. This plugin inherits that property; it does not add its own
  secret store.
- The in-process analysis cache holds recent analysis text in memory for up to 30 minutes. It never holds image
  bytes and is not persisted.
