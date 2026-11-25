# Easy MCP (Clean Fork)

A clean, hardened fork of `mrkaylabs/easy-mcp` to expose a local project folder to web AI clients over MCP with a plain local web dashboard. Zero npm dependencies.

## What changed in this fork

- **No ads, popups, or promo copy**: Removed the floating `Share AI Slot` ad banner, first-visit intro modal, promotional hero tagline, and README ad banners.
- **No external requests from the dashboard or launcher**: Removed Google Fonts CDN `<link>` tags (uses system fonts) and removed the startup GitHub release check (`checkForUpdate`).
- **OAuth authorization gated by token**: `/oauth/authorize` now requires submitting the local Easy MCP access token instead of auto-approving arbitrary OAuth clients on the public tunnel URL. Also adds an OAuth session counter and one-click revoke button on the dashboard.
- **Security & reliability fixes**:
  - Case-insensitive `.git` / `.gitmodules` write blocking while shell is disabled (closes macOS/Windows `.GIT/` bypass).
  - Fail-closed DNS validation and pinned IP resolution in `fetch_url` (also blocks `100.64.0.0/10` CGNAT/Tailscale range).
  - Process-group termination for background jobs on macOS/Linux, macOS-compatible old-instance cleanup (`lsof`), combined SSE + Streamable HTTP session counting, and a live Recent Tool Calls log in the dashboard.

## Tunnel modes

Easy MCP publishes your local server through a tunnel (switchable from the dashboard):

- **Cloudflare (default)** — free quick tunnel (`trycloudflare.com`), no account needed; URL changes each run.
- **Tailscale Funnel (persistent link)** — stable `https://<machine>.<tailnet>.ts.net` address that persists across restarts. Requires [Tailscale](https://tailscale.com/download) installed and signed in.

Your tunnel choice is stored in `~/.easy-mcp/config.json`, and your access token is stored in `~/.easy-mcp/token` (`0600`). Run with `--rotate-token` to mint a new token.

## Quickstart

Needs Node.js 18+:

```bash
npx -y https://codeload.github.com/BalkrishanSingh/easy-mcp/tar.gz/refs/heads/main /path/to/your/project
```

Or clone and run locally:

```bash
git clone https://github.com/BalkrishanSingh/easy-mcp.git
cd easy-mcp
node easy-mcp.js /path/to/your/project
```

## Options

```text
node easy-mcp.js [folder] [--port 9494] [--funnel | --cloudflare | --no-tunnel]
                          [--no-open] [--read-only] [--enable-shell]
                          [--token <token>] [--rotate-token]
                          [--dangerously-skip-jail]
```

- `--read-only` — block file writes.
- `--enable-shell` — start with shell enabled (off by default).
- `--dangerously-skip-jail` — disable the folder jail (whole machine access; use only in isolated VMs).
- `--no-tunnel` — local only, no public link.
- `--no-open` — don't open the browser automatically.
- `--rotate-token` — generate a new persistent token in `~/.easy-mcp/token`.

## Tools exposed

`read_file`, `read_files`, `write_file`, `write_files`, `edit_file`, `list_directory`, `search_files`, `get_file_info`, `execute_command`, `start_job`, `job_status`, `stop_job`, `list_jobs`, `git_status`, `git_diff`, `fetch_url`, `get_current_project`, `set_project`.

## Security model

- Every MCP/API request requires authentication (`Authorization: Bearer <token>`, `x-easy-mcp-token`, `/mcp/<token>`, `?token=<token>`, or an authorized OAuth access token).
- Dashboard control plane (`/`, `/api/*`) is strictly restricted to loopback requests without proxy/tunnel headers and protected by a per-process `ADMIN_SECRET`.
- OAuth Dynamic Client Registration + PKCE flow requires entering the Easy MCP access token on `/oauth/authorize`.
- File operations are jailed to the project folder with symlink resolution (`realpath`).
- Shell execution is off by default; while off, writes inside `.git/` or `.gitmodules` are blocked.
- `fetch_url` only allows public `https://` hosts and fails closed on private/loopback/CGNAT IPs or DNS lookup failures.

## License

MIT — see [LICENSE](LICENSE).
