# Easy MCP (Clean Tailscale Fork)

A clean, hardened fork of `mrkaylabs/easy-mcp` tailored for **Tailscale Funnel** with **shell execution enabled by default** and a plain local web dashboard. Zero npm dependencies.

*(Need Cloudflare quick tunnels or local-only mode? That version is preserved on the `with-cloudflare` branch.)*

## What changed in this fork

- **Tailscale Funnel only on `main`**: Removed `cloudflared` download/management and local-only tunnel switching; publishes directly via `tailscale funnel --bg <port>`.
- **Shell enabled by default**: `execute_command` and `start_job` are enabled by default (toggle **Disable Shell Execution** in the dashboard or pass `--disable-shell` to turn off).
- **No ads, popups, or outbound phone-homes**: Removed the floating `Share AI Slot` ad banner, intro modal, promo copy, Google Fonts CDN links, and startup GitHub release check.
- **OAuth authorization gated by token**: `/oauth/authorize` requires submitting the local Easy MCP access token instead of auto-approving arbitrary OAuth clients on the public tunnel URL. Includes an OAuth session counter and one-click revoke button on the dashboard.
- **Security & reliability fixes**:
  - Case-insensitive `.git` / `.gitmodules` write blocking while shell is disabled.
  - Fail-closed DNS validation and pinned IP resolution in `fetch_url` (blocks private/loopback/CGNAT IPs).
  - Process-group termination for background jobs on macOS/Linux, macOS-compatible old-instance cleanup (`lsof`), combined SSE + Streamable HTTP session counting, and a live Recent Tool Calls log in the dashboard.

## Prerequisites

- Node.js 18+
- [Tailscale](https://tailscale.com/download) installed, signed in, and Funnel enabled on your tailnet.

## Quickstart

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
node easy-mcp.js [folder] [--port 9494] [--no-open] [--read-only]
                          [--disable-shell] [--token <token>] [--rotate-token]
                          [--dangerously-skip-jail]
```

- `--read-only` — block file writes.
- `--disable-shell` — start with shell execution disabled (shell is ON by default).
- `--dangerously-skip-jail` — disable the folder jail (whole machine access; use only in isolated VMs).
- `--no-open` — don't open the browser automatically.
- `--rotate-token` — generate a new persistent token in `~/.easy-mcp/token`.

## Tools exposed

`read_file`, `read_files`, `write_file`, `write_files`, `edit_file`, `list_directory`, `search_files`, `get_file_info`, `execute_command`, `start_job`, `job_status`, `stop_job`, `list_jobs`, `git_status`, `git_diff`, `fetch_url`, `get_current_project`, `set_project`.

## License

MIT — see [LICENSE](LICENSE).
