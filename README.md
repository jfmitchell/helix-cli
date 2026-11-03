# AEM Command Line Interface (`aem`)

## Status

[![codecov](https://img.shields.io/codecov/c/github/adobe/helix-cli.svg)](https://codecov.io/gh/adobe/helix-cli)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/adobe/helix-cli/main.yaml)
[![GitHub license](https://img.shields.io/github/license/adobe/helix-cli.svg)](https://github.com/adobe/helix-cli/blob/master/LICENSE.txt)
[![GitHub issues](https://img.shields.io/github/issues/adobe/helix-cli.svg)](https://github.com/adobe/helix-cli/issues)

The AEM Command Line Interface allows web developers to create, develop, and deploy digital experiences using the Adobe Experience Manager Sites feature Edge Delivery Services. Some of this functionality was known as Franklin or Project Helix before.

## Installation

Install `aem` as a global command. You need Node 12.11 or newer.

```bash
npm install -g @adobe/aem-cli
```

If this fails with `File exists: /opt/homebrew/bin/hlx`, please [see here](#npm-install-fails-with-file-exists-opthomebrewbinhlx).

## Quick Start

```
$ aem --help
Usage: aem <command> [options]

Commands:
  aem up       Run a AEM development server
  aem import   Run the AEM import server
  aem content  Manage local da.live content
  aem config   Manage repository-owned AEM configuration

Options:
  --version                Show version number                         [boolean]
  --log-file, --logFile    Log file (use "-" for stdout)  [array] [default: "-"]
  --log-level, --logLevel  Log level
        [string] [choices: "silly", "debug", "verbose", "info", "warn", "error"]
                                                               [default: "info"]
  --tls-key, --tlsKey      Path to .key file (for enabling TLS)        [string]
  --tls-cert, --tlsCert    Path to .pem file (for enabling TLS)        [string]
  --help                   Show help                                   [boolean]

use <command> --help to get command specific details.

for more information, find our manual at https://github.com/adobe/helix-cli
```

## Managing AEM configuration

`aem config deploy` reconciles repository-defined organisation users, shared profiles
and sites with the AEM Admin API. Configuration stays in your site's repository;
the CLI does not copy it elsewhere or depend on a repository-local admin script.

Run from the repository containing `site-config/`. The command reads configuration
from the current working directory and derives the AEM organisation from the
**owner of the Git `origin` remote**, lowercased. For example,
`https://github.com/Example/website.git` and `git@github.com:Example/website.git`
both select `example`. HTTPS and SSH origins are supported; a missing, invalid or
local-filesystem origin fails before contacting the Admin API.

The Git owner must match the AEM organisation; a fork's `origin` targets the fork
owner, not `upstream`.

```sh
aem config deploy --dry-run                # preview changes; no writes
aem config deploy                          # create/update configured resources
aem config deploy --prune --dry-run         # preview removals too
aem config deploy --prune                   # apply changes and remove extra resources
```

**Nothing is deleted by default. `--prune` deletes live users, sites and profiles
absent from the repository across the entire configured organisation**, including
resources created manually. Use it only with a complete configuration inventory,
and review `--prune --dry-run` first. Pruning runs after successful reconciliation;
failed validation, incomplete live inventories or failed updates stop the run.
Operations are not transactional: an API failure can leave earlier changes applied.

Supply `AEM_ADMIN_TOKEN` in the environment or the current repository's ignored
`.dev.vars`. It must have permission to manage the organisation's users, profiles
and sites. The default endpoint is `https://admin.hlx.page`; `AEM_ADMIN_BASE` can
select another Admin API origin. Environment variables override `.dev.vars`.
Use `${ENV_VAR}` placeholders for config secrets, not literal credentials.
Missing placeholders fail before network access, including in dry-run mode.
For site access restricted by `access.admin.apiKeyId`, set `AEM_CI_KEY_ID` to the
authenticating key's ID; that ID must remain in every configured restriction.

The expected layout is:

```text
site-config/
  org/users.json                        # array of { email, roles }; retain an admin
  profiles/<name>/
    profile.json                        # shared headers, metadata, sidekick, public, etc.
    content/query.yaml                  # optional; applied to each extending site
  sites/<name>/
    site.json                           # code, content, extends.profile, etc.
    access.json                         # optional access override
    headers.json                        # optional headers override
    cdn/prod.json                       # optional production CDN override
    robots.txt                          # optional robots definition
    content/query.yaml                  # optional; overrides the profile query
    content/sitemap.yaml                # optional sitemap definition
```

Users, profiles and sites directories must exist, users must retain at least one
`admin`, and at least one site must be configured. Each site requires `code.owner`, `code.repo`
and `content.source`; a non-`sourcebus` source also requires `url`. Referenced
profiles must exist. Sites still declare their own code repository in `site.json`;
it is not automatically replaced by the Git origin.

Deploy preserves unmanaged live fields (including API keys, secrets and generated
content bus IDs), while reconciling repository-managed fields. Removing a managed
field from a document removes that field from its live configuration, even without
`--prune`; omitting site access resets it to inherited organisation access. Optional
query/sitemap endpoints are not deleted when their files are removed.
The command updates query and sitemap **definitions only**: it does not re-index,
generate sitemaps, purge caches, sync code/content, or change existing CI workflows.

### Creating configuration files

Run these commands in your site's Git repository. They create minimal JSON only,
without contacting the Admin API or deploying anything:

```sh
aem config profile add shared
aem config user add admin@example.test --roles admin
aem config site add my-site --profile shared
aem config site add content-site --source-type markup \
  --source-url https://content.example.test
```

Omit the name/email or required flags to collect them interactively:
`aem config site add`, `aem config profile add`, or `aem config user add`.
When all mandatory inputs are supplied, no prompts are shown. Non-terminal runs
must supply missing inputs explicitly. User roles are required (no automatic admin
grant); `--roles` accepts space- or comma-separated roles.

Site content defaults to `sourcebus`; supported external source types are `markup`,
`google` and `onedrive`, each requiring an HTTP(S) `--source-url` without embedded
credentials. Site code owner/repo default to Git `origin`. Sites and profiles accept
`--title`, defaulting to their name; `--profile` must reference an existing profile.

Creation bootstraps missing `org/`, `profiles/`, `sites/` and `org/users.json`.
An incomplete tree is allowed while authoring, but deploy still requires a site and
an organisation admin. Existing sites/profiles and case-insensitive duplicate users
are rejected, never overwritten. Existing file contents are preserved, and malformed
config, symlinks, cancellation and detected concurrent edits abort the operation.

### Importing deployed configuration

```sh
aem config import --dry-run                # preview the whole organisation
aem config import                          # create a new local site-config/
aem config import --overwrite              # preview and confirm replacement
aem config import --overwrite --yes        # explicit replacement in scripts
```

Import uses the same Git identity, Admin API credentials and current-directory
`.dev.vars` conventions as deploy. It performs **GET requests only** and imports
the entire organisation's users, profiles and sites, including each site's query
and sitemap definitions. Site-level configuration preserves explicit profile
inheritance and overrides rather than flattening aggregated profile values.
Each imported query is stored with its site; existing profile queries remain a
deploy fallback only for sites without a site query.

Import excludes API key/token stores, audit/version metadata, user IDs and generated
content bus IDs. Recognized secret-valued fields, sensitive headers and credential-
bearing URLs become deterministic `${AEM_CONFIG_...}` placeholders. Only the
required variable names are reported; supply their values separately through the
environment or ignored `.dev.vars` before deploy. Import is not a credentials
backup: inspect the generated config and keep secrets out of Git.

The preview lists file additions, updates and removals, without displaying values.
`--dry-run` writes nothing. Replacing an existing `site-config/` requires
`--overwrite` and affirmative terminal confirmation; scripts need
`--overwrite --yes`. `--yes` alone never authorizes replacement. Files absent from
the imported snapshot are removed locally only during explicit replacement.
Nothing outside `site-config/` is replaced; import does not commit, push, deploy,
prune live resources or alter CI.

The CLI validates the full snapshot before staging it, rejects stale local previews,
serializes its writers with `.site-config.lock`, and restores the original tree if
installation fails. Non-CLI editors do not share this lock: avoid editing config
during installation. Inventories are rechecked to detect resource churn, but the
Admin API does not provide an atomic organisation snapshot; import while deployed
configuration is stable. Missing listed resources, incomplete inventories and
unsupported/malformed configuration fail rather than silently importing a partial
tree.

## Starting development

```
$ cd <my-cool-project>
$ aem up
```

### automatically open the browser

The `--open` argument takes a path, eg `--open=/products/`, will cause the browser to be openend
at the specific location. Disable with `--no-open'.`

### browser console log forwarding

The `--forward-browser-logs` flag enables forwarding of browser console messages (log, error, warn, info) to the terminal. This is particularly useful for debugging client-side issues without having to open the browser's developer tools.

```
$ aem up --forward-browser-logs
```

When enabled, browser console messages will appear in your terminal with the following format:
```
[Browser:error] 2025-07-27T10:30:45.123Z http://localhost:3000/script.js:42 Error message here
```

This feature is especially helpful when:
- Debugging JavaScript errors in a headless environment
- Monitoring client-side behavior during development
- Working with AI coding assistants that need visibility into both server and client logs

### html folder for content preview

The `--html-folder` option enables serving HTML files without extensions, useful for previewing content changes when you don't have access to the authoring system.

```
$ aem up --html-folder drafts                      # serves at /drafts/*
$ aem up --html-folder html --html-mount /       # serves at /* (root)
$ aem up --html-folder drafts --html-mount /preview # serves at /preview/*
```

Use `--html-mount` to control the URL path where files are served. Without it, files are served at `/FOLDER/*`.

This enables two features:

1. **Extension-less URLs**: Access `/drafts/page` (or `/page` with root mount) to serve the corresponding `.html` file
2. **Plain HTML with metadata**: Create `.plain.html` files that are automatically wrapped with proper HTML structure and metadata processing

#### Plain HTML files (.plain.html)

Plain HTML files contain only the main content and an optional metadata block. The CLI automatically:
- Wraps content in `<html><head><body><header><main><footer>` structure
- Merges in `head.html` content
- The metadata block is removed from the rendered content and converted to meta tags in the `<head>`.

When a request resolves to `<stem>`, the CLI looks up `<stem>.html` first and falls back to `<stem>.plain.html`. Pass `--preferPlainHtml` to reverse this order — useful when you keep both files side-by-side and want the plain version to win:

```
$ aem up --html-folder drafts --preferPlainHtml
```

### setting up a self-signed cert for using https

1. create the certificate


```
$ openssl req -new -newkey rsa:4096 -x509 -sha256 -days 365 -nodes -out server.crt -keyout server.key -subj "/CN=localhost"
```

this will create 2 files: `server.crt` and `server.key`

Alternatively, if your browser does not trust the certificate, you can use mkcert to generate a trusted certificate:
```bash
# Install mkcert via Homebrew or your preferred method, then run:
mkcert -cert-file server.crt -key-file server.key localhost 127.0.0.1
```

2. start aem with tls support

```
$ aem up --tls-cert server.crt --tls-key server.key
    ___    ________  ___                          __      __ v14.26.1
   /   |  / ____/  |/  /  _____(_)___ ___  __  __/ /___ _/ /_____  _____
  / /| | / __/ / /|_/ /  / ___/ / __ `__ \/ / / / / __ `/ __/ __ \/ ___/
 / ___ |/ /___/ /  / /  (__  ) / / / / / / /_/ / / /_/ / /_/ /_/ / /
/_/  |_/_____/_/  /_/  /____/_/_/ /_/ /_/\__,_/_/\__,_/\__/\____/_/

info: Starting AEM dev server v14.26.1
info: Local AEM dev server up and running: https://localhost:3000/
```

3. (optional) Add arguments to .env file:

```
$ echo -e "AEM_TLS_CERT=server.crt\nAEM_TLS_KEY=server.key" >> .env
```

### environment

All the command arguments can also be specified via environment variables. the `.env` file is
loaded automatically.

example:

`.env`
```dotenv
AEM_OPEN=/products
AEM_PORT=8080
AEM_PAGES_URL=https://stage.myproject.com
```

#### HTTP Proxy

In order to use a HTTP proxy (eg behind a corporate firewall), you can set the respective environment variables:

`NO_PROXY` is a list of host names (optionally with a port). If the input URL matches any of the entries in `NO_PROXY`, then the input URL should be fetched by a direct request (i.e. without a proxy).

Matching follows the following rules:

`NO_PROXY=*` disables all proxies.
Space and commas may be used to separate the entries in the `NO_PROXY` list.
If `NO_PROXY` does not contain any entries, then proxies are never disabled.
If a port is added after the host name, then the ports must match. If the URL does not have an explicit port name, the protocol's default port is used.
Generally, the proxy is only disabled if the host name is an exact match for an entry in the `NO_PROXY` list. The only exceptions are entries that start with a dot or with a wildcard; then the proxy is disabled if the host name ends with the entry.
See test.js for examples of what should match and what does not.

`*_PROXY`
The environment variable used for the proxy depends on the protocol of the URL. For example, https://example.com uses the "https" protocol, and therefore the proxy to be used is `HTTPS_PROXY` (NOT `HTTP_PROXY`, which is only used for http:-URLs).

If present, `ALL_PROXY` is used as fallback if there is no other match.

#### Global

| option | variable | default | description |
|--------|----------|---------|-------------|
| `--log-file` | `AEM_LOG_FILE` | `-` | Log file. use `-` to log to stdout |
| `--log-level` | `AEM_LOG_LEVEL` | `info` | Log level |

#### Up command

| option            | variable            | default     | description                                                 |
|-------------------|---------------------|-------------|-------------------------------------------------------------|
| `--port`          | `AEM_PORT`          | `3000`      | Development server port                                     |
| `--addr`          | `AEM_ADDR`          | `127.0.0.1` | Development server bind address                             |
| `--livereload`    | `AEM_LIVERELOAD`    | `true`      | Enable automatic reloading of modified sources in browser.  |
| `--no-livereload` | `AEM_NO_LIVERELOAD` | `false`     | Disable live-reload.                                        |
| `--forward-browser-logs` | `AEM_FORWARD_BROWSER_LOGS` | `false` | Forward browser console logs to terminal.            |
| `--html-folder`   | `AEM_HTML_FOLDER`   | undefined   | Serve HTML files from folder without extensions. |
| `--html-mount`    | `AEM_HTML_MOUNT`    | `/FOLDER`   | URL path where html-folder files are served. |
| `--prefer-plain-html` | `AEM_PREFER_PLAIN_HTML` | `false` | Prefer `<stem>.plain.html` over `<stem>.html` when both exist. |
| `--open`          | `AEM_OPEN`          | `/`         | Open a browser window at specified path after server start. |
| `--no-open`       | `AEM_NO_OPEN`       | `false`     | Disable automatic opening of browser window.                |
| `--tls-key`       | `AEM_TLS_KEY`       | undefined   | Path to .key file (for enabling TLS)                        |
| `--tls-cert`      | `AEM_TLS_CERT`      | undefined   | Path to .pem file (for enabling TLS)                        |

In Git worktrees, the default port is derived from the branch name (3000-3999) to
reduce conflicts between worktrees. An explicit `--port` or `AEM_PORT` setting
(including in `.env`) overrides this automatic selection, even when set to `3000`.
Command-line options take precedence over environment variables.

## Starting an import

The AEM Importer is an application that supports importing content to AEM.

```
$ cd <my-cool-project>
$ aem import
```

Read the full AEM Importer [documentation](https://github.com/adobe/helix-importer-ui).

## Managing content

The `aem content` commands let you check out content from da.live locally, make bulk edits, and push changes back. The local content lives in a `content/` folder in your project.

| Command | Description |
|---------|-------------|
| `aem content clone` | Clone da.live content locally into `content/` |
| `aem content status` | Show locally added, modified, and deleted content files |
| `aem content diff` | Show diff between local and remote content |
| `aem content merge` | Merge remote content into local files |
| `aem content add` | Stage changes in `content/` (like `git add`) |
| `aem content commit` | Commit staged changes in `content/` (like `git commit`) |
| `aem content push` | Push committed `content/` changes to da.live (use `content add` & `content commit` first) |

### Local content serving

When a `content/` folder is present, `aem up` automatically serves content from it first, falling back to the proxy for any files not found locally. HTML files in `content/` are wrapped with `head.html` and have their metadata blocks processed, so pages render the same way they would when served from da.live.

# Developing AEM CLI

## Testing

You can use `npm run check` to run the tests and check whether your code adheres
to the aem-cli coding style.

### Browser Injectables

Browser-injected scripts (LiveReload and console log forwarding) are maintained in a separate sub-project at `packages/browser-injectables/`. This isolation keeps browser testing dependencies separate from the main CLI.

#### Development
- Injectable scripts are in `packages/browser-injectables/src/`
- No build step required - scripts are used directly
- Browser tests run only when injectable code changes

#### Testing Browser Injectables
```bash
cd packages/browser-injectables
npm install
npm test
```

# Troubleshooting

## `aem up` fails with `unable to get local issuer certificate`

This error occurs when the server certificate is not trusted by Node.js. The typical
cause is that connections to the server `*.aem.page` and `*.hlx.page` are intercepted
by an enterprise proxy or firewall which is trying to inspect the traffic.

These proxies use a private certificate authority (CA) to sign the certificates of the
servers they intercept. To make Node.js trust the server certificate, you need to add
the CA certificate to the list of trusted CAs.

### Option 1: Using IT-provided CA certificate

The CA certificate is typically provided by your IT department. You can ask them for
the CA certificate and save it to a file, e.g. `my-ca.crt`.

Then you can use the [`NODE_EXTRA_CA_CERTS`](https://nodejs.org/docs/latest/api/cli.html) environment variable to make Node.js trust
the CA certificate:

```bash
export NODE_EXTRA_CA_CERTS=my-ca.crt
aem up
```

### Option 2: Extracting certificate from browser

If you don't have access to the CA certificate from your IT department, you can extract it directly
from your browser:

1. Access the AEM admin URL in your browser (e.g., `https://admin.hlx.page/sidekick/owner-name/repo-name/github-branch-name/config.json`)
2. Click on the padlock icon in the address bar and view the certificate details
3. Export the certificate chain as a Base64 encoded `.pem` file
4. Save it to a directory (e.g., `certs/hlx.page.pem`)
5. Set the environment variable and run aem:

```bash
export NODE_EXTRA_CA_CERTS=./certs/hlx.page.pem
aem up
```

On Windows, use `set` instead of `export`:
```cmd
set NODE_EXTRA_CA_CERTS=./certs/hlx.page.pem
aem up
```

Either approach will make Node.js trust the server certificate and `aem up` should work.

## `npm install` fails with `File exists: /opt/homebrew/bin/hlx`

If you try to install `@adobe/aem-cli`: 

```
> npm install -g @adobe/aem-cli
...
npm error EEXIST: file already exists
npm error File exists: /opt/homebrew/bin/hlx
npm error Remove the existing file and try again, or run npm
```

This can happen when you previously had installed this tool under its old package name [@adobe/helix-cli](https://www.npmjs.com/package/@adobe/helix-cli). Starting with version 15.0.0, this tool was renamed `aem` and published as `@adobe/aem-cli`. The previous `@adobe/helix-cli` has been deprecated. However, the new package still provides the command line binary under the old name `hlx` in addition to `aem`, for backwards compatibility, which can lead to the npm install error.

To solve, first uninstall the old version, then install again with the new name:

```
npm uninstall -g @adobe/helix-cli
npm install -g @adobe/aem-cli
```
