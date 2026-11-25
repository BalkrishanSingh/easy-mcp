#!/usr/bin/env node
/*
 * Easy MCP — server
 *
 * A small, dependency-free MCP server that exposes one local project folder
 * to web AI clients, plus a plain web dashboard for the human running it.
 *
 * Routes (all token-gated except none):
 *   POST /mcp            JSON-RPC 2.0 (initialize, tools/list, tools/call, ping)
 *   GET  /sse            MCP SSE transport (endpoint event -> /messages)
 *   POST /messages       MCP SSE transport messages
 *   POST /call           { name, arguments } convenience tool call
 *   GET  /               dashboard page
 *   GET  /api/dashboard  dashboard JSON
 *   POST /api/set-project { path }
 *   POST /api/stop-job   { id }
 *
 * Auth: Authorization: Bearer <token>, x-easy-mcp-token header, or ?token=.
 * Binds 127.0.0.1 only; remote access goes through the tunnel.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFile } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = Number(process.env.EASY_MCP_PORT || argValue('--port', '9494'));
let VERSION = process.env.EASY_MCP_VERSION || '0.0.0';
if (VERSION === '0.0.0') {
  try { VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || VERSION; } catch {}
}
let TOKEN = process.env.EASY_MCP_TOKEN || argValue('--token', '');
// Fail closed: never run unauthenticated. If no token was passed in (direct
// `node server.js` run), load or create the persistent one the launcher uses.
if (!TOKEN) {
  const tokenFile = path.join(os.homedir(), '.easy-mcp', 'token');
  try { TOKEN = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
  if (!TOKEN) {
    TOKEN = crypto.randomBytes(24).toString('hex');
    try {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
    } catch {}
  }
}
// Per-process secret for the local dashboard control plane (/api/*). Embedded
// in the dashboard HTML, which is only served to loopback requests.
const ADMIN_SECRET = crypto.randomBytes(32).toString('hex');
function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}
// Shell is ON by default in this fork. Pass --disable-shell (or toggle it in
// the dashboard) to block execute_command and start_job.
let DISABLE_SHELL = args.includes('--disable-shell') || process.env.EASY_MCP_DISABLE_SHELL === '1';
let READ_ONLY = args.includes('--read-only') || process.env.EASY_MCP_READ_ONLY === '1';
let SKIP_JAIL = args.includes('--dangerously-skip-jail') || process.env.EASY_MCP_SKIP_JAIL === '1';
let projectRoot = path.resolve(process.env.EASY_MCP_PROJECT || args.find(a => !a.startsWith('--')) || process.cwd());
let publicUrl = (process.env.EASY_MCP_PUBLIC_URL || '').replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// Tunnel manager — Tailscale Funnel (persistent link)
// ---------------------------------------------------------------------------
const easyMcpHome = path.join(os.homedir(), '.easy-mcp');
let tunnelError = '';

function startTunnel() {
  tunnelError = '';
  const funnel = spawnSync('tailscale', ['funnel', '--bg', String(PORT)], { encoding: 'utf8', timeout: 20000 });
  if (funnel.error || funnel.status !== 0) {
    const detail = (funnel.stderr || funnel.stdout || funnel.error?.message || '').trim();
    tunnelError = detail || 'Tailscale Funnel failed to start. Check that Tailscale is running and Funnel is enabled.';
    return;
  }
  let dnsHost = '';
  try {
    const st = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 15000 });
    dnsHost = JSON.parse(st.stdout || '{}').Self?.DNSName?.replace(/\.$/, '') || '';
  } catch {}
  dnsHost = dnsHost || process.env.EASY_MCP_FUNNEL_HOST || '';
  if (!dnsHost) {
    tunnelError = 'Tailscale not found or not signed in. Install: https://tailscale.com/download';
    return;
  }
  publicUrl = 'https://' + dnsHost;
  console.log(`MCP link:  ${publicUrl}/mcp/${TOKEN}`);
}
const startedAt = Date.now();
const recentFile = path.join(require('os').homedir(), '.easy-mcp', 'recent-projects.json');
function loadRecents() {
  try {
    const list = JSON.parse(fs.readFileSync(recentFile, 'utf8'));
    return Array.isArray(list) ? list.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}
function saveRecents() {
  try {
    fs.mkdirSync(path.dirname(recentFile), { recursive: true });
    fs.writeFileSync(recentFile, JSON.stringify(recentProjects.slice(0, 10), null, 2));
  } catch {}
}
const recentProjects = [...new Set([projectRoot, ...loadRecents()])].slice(0, 10);

// ---------------------------------------------------------------------------
// Stats / activity
// ---------------------------------------------------------------------------

let totalCalls = 0;
let totalErrors = 0;
const recentCalls = []; // { ts, tool, ok, ms }
function recordCall(tool, ok, ms) {
  totalCalls++;
  if (!ok) totalErrors++;
  recentCalls.unshift({ ts: new Date().toISOString(), tool, ok, ms });
  if (recentCalls.length > 100) recentCalls.length = 100;
}

// ---------------------------------------------------------------------------
// Path jail
// ---------------------------------------------------------------------------

function realpathOrAncestor(abs) {
  let cur = abs;
  for (;;) {
    try { return fs.realpathSync(cur); } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}
function resolveInProject(p) {
  const base = path.resolve(projectRoot);
  const abs = path.resolve(base, String(p || '.'));
  if (SKIP_JAIL) return abs; // --dangerously-skip-jail: any path on the machine
  const lexRel = path.relative(base, abs);
  if (lexRel.startsWith('..') || path.isAbsolute(lexRel)) {
    throw new Error(`Path escapes project folder: ${p}`);
  }
  // Symlink escape: the real location must also stay inside the real project root.
  const root = realpathOrAncestor(base);
  const real = realpathOrAncestor(abs);
  const realRel = path.relative(root, real);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new Error(`Path escapes project folder: ${p}`);
  }
  return abs;
}
// When the shell is disabled, writes into .git internals could smuggle command
// execution back in through git itself (config keys, hooks). Block those
// case-insensitively so macOS/Windows case-insensitive filesystems can't bypass.
function assertNotGitInternal(abs) {
  if (!DISABLE_SHELL) return;
  const rel = path.relative(realpathOrAncestor(projectRoot), realpathOrAncestor(abs)).split(path.sep).join('/');
  const parts = rel.toLowerCase().split('/');
  if (parts.includes('.git') || parts.includes('.gitmodules')) {
    throw new Error('Writing git internals is blocked while the shell is disabled');
  }
}
function relOf(abs) {
  const r = path.relative(projectRoot, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) return abs.split(path.sep).join('/');
  return r === '' ? '.' : r.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

const jobs = new Map(); // id -> { id, command, pid, startedAt, status, exitCode, log }

// Kill the whole process tree: on Windows a job often runs through cmd.exe
// (npm run dev -> node), and killing only the parent leaves the dev server
// alive holding its port.
function killJob(job) {
  if (!job || !job.pid) return;
  if (process.platform === 'win32') {
    try { execFile('taskkill', ['/PID', String(job.pid), '/T', '/F'], { windowsHide: true }, () => {}); return; } catch {}
  }
  try { process.kill(-job.pid, 'SIGTERM'); return; } catch {}
  try { process.kill(job.pid); } catch {}
}
let jobSeq = 0;

function shellCommand(command) {
  return process.platform === 'win32'
    ? { file: 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { file: '/bin/sh', args: ['-c', command] };
}

function startJob(command) {
  const id = `job-${++jobSeq}`;
  const { file, args: sargs } = shellCommand(command);
  const child = spawn(file, sargs, { cwd: projectRoot, windowsHide: true, detached: process.platform !== 'win32' });
  const job = { id, command, pid: child.pid, startedAt: new Date().toISOString(), status: 'running', exitCode: null, log: '' };
  const push = d => { job.log += d.toString(); if (job.log.length > 200000) job.log = job.log.slice(-200000); };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('close', code => { job.status = 'exited'; job.exitCode = code; });
  child.on('error', err => { job.status = 'error'; job.log += `\n${err.message}`; });
  jobs.set(id, job);
  return job;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__']);

function walkFiles(dir, out = [], depth = 0) {
  if (depth > 12 || out.length > 5000) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out, depth + 1);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

const MAX_READ_BYTES = 10 * 1024 * 1024;
function readTextFile(abs) {
  const size = fs.statSync(abs).size;
  if (size > MAX_READ_BYTES) throw new Error(`File too large to read as text (${(size / 1048576).toFixed(1)} MB, limit 10 MB)`);
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) throw new Error('Binary file, cannot read as text');
  return buf.toString('utf8');
}

function runCommand(command, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const { file, args: sargs } = shellCommand(command);
    const child = spawn(file, sargs, { cwd: projectRoot, windowsHide: true });
    let out = '';
    const push = d => { out += d.toString(); if (out.length > 300000) out = out.slice(-300000); };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => { killJob({ pid: child.pid }); out += '\n[timed out]'; }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code, output: out.trim() }); });
    child.on('error', err => { clearTimeout(timer); resolve({ exitCode: -1, output: err.message }); });
  });
}

// git runs WITHOUT a shell (argv array), so tool input can never become a
// command. Anti-execution flags stop git config/attributes from spawning
// external programs (pager, fsmonitor, external diff drivers).
function runGit(gitArgs, timeoutMs = 30000) {
  const safeArgs = ['--no-pager', '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', ...gitArgs];
  const env = { ...process.env };
  if (!SKIP_JAIL) env.GIT_CEILING_DIRECTORIES = path.dirname(realpathOrAncestor(projectRoot));
  return new Promise((resolve) => {
    execFile('git', safeArgs, { cwd: projectRoot, shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return resolve({ exitCode: -1, output: 'git not found on this machine' });
      resolve({ exitCode: err ? (typeof err.code === 'number' ? err.code : -1) : 0, output: ((stdout || '') + (stderr || '')).trim() });
    });
  });
}

// fetch_url runs on this machine, so it must never reach private addresses
// (loopback, LAN, link-local, CGNAT/Tailscale) — the model only ever needs public docs.
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1' || h === '::' || h === '0.0.0.0') return true;
  if (h.includes(':')) {
    if (h.startsWith('::ffff:')) return isPrivateHost(h.slice(7));
    return h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb') || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('ff');
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || a === 0 || (a === 100 && b >= 64 && b <= 127) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function fetchUrl(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//.test(url)) return reject(new Error('Only https:// URLs are allowed'));
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    const host = parsed.hostname;
    if (isPrivateHost(host)) return reject(new Error('Blocked: private/loopback addresses are not allowed'));
    if (hops > 5) return reject(new Error('Too many redirects (limit 5)'));
    // Resolve once and pin the validated IP to prevent DNS-rebinding TOCTOU.
    dns.promises.lookup(host, { all: true }).then(addrs => {
      if (!addrs.length) return reject(new Error('DNS lookup returned no addresses'));
      if (addrs.some(a => isPrivateHost(a.address))) return reject(new Error('Blocked: host resolves to a private/loopback address'));
      const validated = addrs.map(a => ({ address: a.address, family: a.family }));
      const pinnedLookup = (_h, opts, cb) => {
        if (typeof opts === 'function') return opts(null, validated[0].address, validated[0].family);
        if (opts && opts.all) return cb(null, validated);
        return cb(null, validated[0].address, validated[0].family);
      };
      https.get(url, { headers: { 'User-Agent': 'easy-mcp' }, timeout: 20000, lookup: pinnedLookup }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return resolve(fetchUrl(new URL(res.headers.location, url).toString(), hops + 1));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', d => { body += d; if (body.length > 300000) res.destroy(); });
        res.on('end', () => resolve(body.slice(0, 300000)));
      }).on('error', reject);
    }).catch(err => reject(new Error(`DNS lookup failed: ${err.message}`)));
  });
}

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the project folder. Returns line-numbered content.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: ({ path: p }) => {
      const abs = resolveInProject(p);
      const lines = readTextFile(abs).split('\n');
      return `File: ${relOf(abs)} (${lines.length} lines)\n\n` + lines.map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join('\n');
    }
  },
  {
    name: 'read_files',
    description: 'Read several text files at once.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
    run: ({ paths }) => paths.map(p => {
      try { return `===== ${p} =====\n${readTextFile(resolveInProject(p))}`; }
      catch (e) { return `===== ${p} =====\n[error] ${e.message}`; }
    }).join('\n\n')
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file in the project folder.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    write: true,
    run: ({ path: p, content }) => {
      const abs = resolveInProject(p);
      assertNotGitInternal(abs);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      return `Wrote ${relOf(abs)} (${Buffer.byteLength(content)} bytes)`;
    }
  },
  {
    name: 'write_files',
    description: 'Create or overwrite several text files at once.',
    inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }, required: ['files'] },
    write: true,
    run: ({ files }) => files.map(f => {
      const abs = resolveInProject(f.path);
      assertNotGitInternal(abs);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content, 'utf8');
      return `Wrote ${relOf(abs)}`;
    }).join('\n')
  },
  {
    name: 'edit_file',
    description: 'Replace an exact text snippet in a file. Fails if old_text is not found or not unique.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] },
    write: true,
    run: ({ path: p, old_text, new_text }) => {
      const abs = resolveInProject(p);
      assertNotGitInternal(abs);
      const text = readTextFile(abs);
      const first = text.indexOf(old_text);
      if (first < 0) throw new Error('old_text not found');
      if (text.indexOf(old_text, first + 1) >= 0) throw new Error('old_text is not unique');
      fs.writeFileSync(abs, text.slice(0, first) + new_text + text.slice(first + old_text.length), 'utf8');
      return `Edited ${relOf(abs)}`;
    }
  },
  {
    name: 'list_directory',
    description: 'List files and folders in a project directory.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    run: ({ path: p }) => {
      const abs = resolveInProject(p || '.');
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const lines = entries.map(e => {
        const full = path.join(abs, e.name);
        if (e.isDirectory()) return `[DIR]  ${e.name}/`;
        let size = 0; try { size = fs.statSync(full).size; } catch {}
        return `[FILE] ${e.name} (${size} bytes)`;
      });
      return `Directory: ${relOf(abs)}\n\n${lines.join('\n') || '(empty)'}`;
    }
  },
  {
    name: 'search_files',
    description: 'Search file contents for a text query across the project (skips node_modules/.git and binary files).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'] },
    run: ({ query, path: p }) => {
      const base = resolveInProject(p || '.');
      const files = fs.statSync(base).isDirectory() ? walkFiles(base) : [base];
      const hits = [];
      for (const f of files) {
        try { if (fs.statSync(f).size > 2 * 1024 * 1024) continue; } catch { continue; }
        let text; try { text = readTextFile(f); } catch { continue; }
        text.split('\n').forEach((line, i) => {
          if (line.includes(query) && hits.length < 200) hits.push(`${relOf(f)}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
      }
      return hits.length ? hits.join('\n') : 'No matches.';
    }
  },
  {
    name: 'get_file_info',
    description: 'Get size, type and timestamps for a file or folder.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: ({ path: p }) => {
      const abs = resolveInProject(p);
      const st = fs.statSync(abs);
      return JSON.stringify({ path: relOf(abs), type: st.isDirectory() ? 'directory' : 'file', size: st.size, modified: st.mtime.toISOString(), created: st.birthtime.toISOString() }, null, 2);
    }
  },
  {
    name: 'execute_command',
    description: 'Run a shell command inside the project folder (cmd on Windows, sh elsewhere). Returns exit code and output.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['command'] },
    shell: true,
    run: async ({ command, timeout_ms }) => {
      const r = await runCommand(command, Math.min(Number(timeout_ms) || 120000, 600000));
      return `Exit code: ${r.exitCode}\n\n${r.output || '(no output)'}`;
    }
  },
  {
    name: 'start_job',
    description: 'Start a long-running background command (dev server, watcher). Returns a job id.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    shell: true,
    run: ({ command }) => {
      const job = startJob(command);
      return `Started ${job.id} (pid ${job.pid}): ${command}`;
    }
  },
  {
    name: 'job_status',
    description: 'Check a background job status and recent output.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: ({ id }) => {
      const job = jobs.get(id);
      if (!job) throw new Error(`Unknown job: ${id}`);
      return `${job.id}: ${job.status}${job.exitCode !== null ? ` (exit ${job.exitCode})` : ''}\nCommand: ${job.command}\nStarted: ${job.startedAt}\n\n${job.log.slice(-4000) || '(no output yet)'}`;
    }
  },
  {
    name: 'stop_job',
    description: 'Stop a background job.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: ({ id }) => {
      const job = jobs.get(id);
      if (!job) throw new Error(`Unknown job: ${id}`);
      killJob(job);
      job.status = 'stopped';
      return `Stopped ${id}`;
    }
  },
  {
    name: 'list_jobs',
    description: 'List background jobs.',
    inputSchema: { type: 'object', properties: {} },
    run: () => jobs.size
      ? [...jobs.values()].map(j => `${j.id}: ${j.status} — ${j.command}`).join('\n')
      : 'No jobs.'
  },
  {
    name: 'git_status',
    description: 'Run git status in the project folder.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => (await runGit(['status', '--short', '--branch'])).output || '(clean)'
  },
  {
    name: 'git_diff',
    description: 'Run git diff in the project folder (optionally for one path).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    run: async ({ path: p }) => {
      const args = ['diff', '--no-ext-diff', '--no-textconv'];
      if (p) {
        if (String(p).includes('\0')) throw new Error('Invalid path');
        const abs = resolveInProject(p);
        const rel = path.relative(realpathOrAncestor(projectRoot), abs).split(path.sep).join('/');
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.startsWith(':')) throw new Error(`Path escapes project folder: ${p}`);
        args.push('--', rel);
      }
      return (await runGit(args)).output || '(no diff)';
    }
  },
  {
    name: 'fetch_url',
    description: 'Fetch an https URL (documentation, API reference) and return its text.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: ({ url }) => fetchUrl(url)
  },
  {
    name: 'get_current_project',
    description: 'Return the current project folder.',
    inputSchema: { type: 'object', properties: {} },
    run: () => projectRoot
  },
  {
    name: 'set_project',
    description: 'Switch the project folder all tools operate on.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: ({ path: p }) => { setProject(p); return `Project folder: ${projectRoot}`; }
  }
];

function setProject(p) {
  const abs = path.resolve(String(p));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Not a folder: ${p}`);
  projectRoot = abs;
  const i = recentProjects.indexOf(abs);
  if (i >= 0) recentProjects.splice(i, 1);
  recentProjects.unshift(abs);
  if (recentProjects.length > 10) recentProjects.length = 10;
  saveRecents();
}

const READ_ONLY_TOOLS = new Set(['read_file', 'read_files', 'list_directory', 'search_files', 'get_file_info', 'job_status', 'list_jobs', 'git_status', 'git_diff', 'fetch_url', 'get_current_project']);
function toolList() {
  // The AI must not move its own jail: set_project is hidden while the folder
  // jail is on (the human switches projects in the dashboard instead).
  return TOOLS.filter(t => SKIP_JAIL || t.name !== 'set_project').map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: READ_ONLY_TOOLS.has(t.name)
      ? { readOnlyHint: true, destructiveHint: false, openWorldHint: t.name === 'fetch_url' }
      : { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }));
}

async function callTool(name, toolArgs) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (name === 'set_project' && !SKIP_JAIL) throw new Error('set_project is disabled while the folder jail is on; switch projects in the Easy MCP dashboard');
  if (READ_ONLY && tool.write) throw new Error('Server is read-only');
  if (DISABLE_SHELL && tool.shell) throw new Error('Shell is currently disabled; re-enable it in the Easy MCP dashboard if needed.');
  const t0 = Date.now();
  try {
    const result = await tool.run(toolArgs || {});
    recordCall(name, true, Date.now() - t0);
    return String(result);
  } catch (err) {
    recordCall(name, false, Date.now() - t0);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC
// ---------------------------------------------------------------------------

async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'Easy MCP', version: VERSION }
      });
    case 'notifications/initialized':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: toolList() });
    case 'tools/call': {
      try {
        const text = await callTool(params?.name, params?.arguments);
        return reply({ content: [{ type: 'text', text }], isError: false });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }
    default:
      return id === undefined ? null : fail(-32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// SSE sessions
// ---------------------------------------------------------------------------

const sseSessions = new Map(); // sessionId -> res (legacy SSE transport)
const sseSessionTokens = new Map(); // sessionId -> per-session token sent in SSE endpoint URLs (never the master TOKEN)
const mcpSessions = new Map(); // sessionId -> { createdAt } (Streamable HTTP)

// ---------------------------------------------------------------------------
// Native folder picker (server runs on the user's own machine)
// ---------------------------------------------------------------------------

let activePicker = null;

function pickFolderNative({ signal, timeoutMs = 90000 } = {}) {
  if (activePicker) return Promise.resolve({ status: 'busy', path: null });
  return new Promise((resolve) => {
    let file, sargs;
    if (process.platform === 'win32') {
      const sysRoot = process.env.SystemRoot || 'C:\\Windows';
      file = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // The dialog needs a shown TopMost owner form: without an owner, Windows
      // foreground-lock rules open it BEHIND the browser with no taskbar entry,
      // so the user never sees it. The 1x1 transparent owner forces it on top.
      sargs = ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-STA', '-Command',
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [System.Windows.Forms.Application]::EnableVisualStyles(); $f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $f.StartPosition = 'CenterScreen'; $f.FormBorderStyle = 'None'; $f.Width = 1; $f.Height = 1; $f.Opacity = 0; $f.ShowInTaskbar = $true; $f.Text = 'Select project folder'; $f.Show(); $f.Activate(); $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select project folder'; $d.ShowNewFolderButton = $true; try { if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) } else { exit 2 } } finally { $d.Dispose(); $f.Close(); $f.Dispose() }"];
    } else if (process.platform === 'darwin') {
      file = 'osascript';
      sargs = ['-e', 'POSIX path of (choose folder with prompt "Select project folder")'];
    } else {
      file = 'zenity';
      sargs = ['--file-selection', '--directory', '--title=Select project folder'];
    }
    const child = spawn(file, sargs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activePicker = child;
    let settled = false, timedOut = false, aborted = false, out = '', err = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (activePicker === child) activePicker = null;
      resolve(result);
    };
    const killChild = () => { try { child.kill(); } catch {} };
    const onAbort = () => { aborted = true; killChild(); finish({ status: 'cancelled', path: null }); };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { if (err.length < 8192) err += d.toString('utf8'); });
    const timer = setTimeout(() => { timedOut = true; killChild(); finish({ status: 'timeout', path: null }); }, timeoutMs);
    child.on('error', e => finish({ status: 'error', path: null, error: e.message }));
    child.on('close', (code) => {
      if (timedOut || aborted) return;
      const picked = out.trim();
      if (code === 0 && picked) return finish({ status: 'ok', path: picked });
      const isCancel =
        (process.platform === 'win32' && (code === 2 || (code === 0 && !picked && !err.trim()))) ||
        (process.platform === 'darwin' && code === 1 && err.includes('-128')) ||
        (process.platform !== 'win32' && process.platform !== 'darwin' && code === 1);
      if (isCancel) return finish({ status: 'cancelled', path: null });
      const detail = err.trim() || `Picker exited with code ${code}`;
      console.error('[pick-folder] failed:', detail);
      finish({ status: 'error', path: null, error: detail });
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req, maxBytes = 10_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    req.on('data', d => {
      if (done) return;
      total += d.length;
      if (total > maxBytes) {
        done = true;
        const err = new Error('Payload too large');
        err.statusCode = 413;
        req.destroy();
        return reject(err);
      }
      chunks.push(d);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', err => { if (!done) { done = true; reject(err); } });
  });
}
function parseJsonBody(raw) {
  try { return JSON.parse(raw || '{}'); }
  catch {
    const err = new Error('Invalid JSON');
    err.statusCode = 400;
    throw err;
  }
}
const PUBLIC_PATHS = new Set([
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
  '/.well-known/oauth-protected-resource',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/token'
]);
function isPublicPath(p) {
  return PUBLIC_PATHS.has(p) || p.startsWith('/.well-known/oauth-protected-resource/');
}
function bearerOf(req, url) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7)
    : (req.headers['x-easy-mcp-token'] || url.searchParams.get('token') || req._pathToken || '');
}
function authorized(req, url) {
  if (!TOKEN) return false; // fail closed
  const given = bearerOf(req, url);
  if (!given) return false;
  if (safeEqual(given, TOKEN)) return true;
  const sid = url.searchParams.get('sessionId');
  if (sid && sseSessionTokens.has(sid) && safeEqual(given, sseSessionTokens.get(sid))) return true;
  const rec = oauthTokens.get(sha256hex(given));
  return !!(rec && rec.type === 'access' && (!rec.exp || rec.exp > Date.now()));
}
// Dashboard control plane: loopback Host + no tunnel/proxy headers. (Tailscale
// Funnel proxies from 127.0.0.1, so the socket IP alone cannot tell local from
// remote — Host + proxy headers can.)
function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  return h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}` || h === `[::1]:${PORT}` || h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
}
function hasTunnelHeaders(req) {
  const h = req.headers;
  return !!(h['cf-connecting-ip'] || h['cf-ray'] || h['x-forwarded-for'] || h['x-forwarded-host'] || h['forwarded'] || h['tailscale-user-login']);
}
function isLocalAdminRequest(req) {
  return isLoopbackHost(req.headers.host) && !hasTunnelHeaders(req);
}
function hostAllowed(req) {
  if (isLoopbackHost(req.headers.host)) return true;
  if (publicUrl) {
    try { return String(req.headers.host || '').toLowerCase() === new URL(publicUrl).host.toLowerCase(); } catch {}
  }
  return false;
}

function pruneMcpSessions() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, info] of mcpSessions) {
    if ((info.lastSeen || info.createdAt || 0) < cutoff) mcpSessions.delete(id);
  }
}

function dashboardData() {
  pruneMcpSessions();
  return {
    status: 'online',
    version: VERSION,
    project: projectRoot,
    recentProjects,
    readOnly: READ_ONLY,
    disableShell: DISABLE_SHELL,
    skipJail: SKIP_JAIL,
    toolsCount: TOOLS.length,
    toolNames: TOOLS.map(t => t.name),
    activeSessions: sseSessions.size + mcpSessions.size,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    startedAt: new Date(startedAt).toISOString(),
    totalCalls,
    totalErrors,
    jobs: [...jobs.values()].map(j => ({ id: j.id, command: j.command, status: j.status, startedAt: j.startedAt })),
    publicUrl: publicUrl || null,
    tunnelError: tunnelError || null,
    mcpUrl: publicUrl ? `${publicUrl}/mcp${TOKEN ? '/' + TOKEN : ''}` : null,
    dashboardUrl: `http://127.0.0.1:${PORT}/`,
    recentCalls
  };
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Easy MCP</title>
<style>
  :root {
    color-scheme: dark light;
    --bg: #0d0c0a;
    --card: #151311;
    --card-elevated: #1a1715;
    --border: #29241f;
    --border-hover: #423930;
    --text: #f5f0eb;
    --muted: #96897b;
    --gold: #f59e0b;
    --flame: #ea580c;
    --ok: #22c55e;
    --err: #ef4444;
    --accent-glow: rgba(234, 88, 12, 0.14);
    --gold-glow: rgba(245, 158, 11, 0.12);
    --input-bg: #100f0d;
    --radius: 12px;
    --radius-sm: 8px;
    --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #faf7f2;
      --card: #ffffff;
      --card-elevated: #fcfbfa;
      --border: #e8e0d5;
      --border-hover: #cbbfb0;
      --text: #1d1916;
      --muted: #706356;
      --input-bg: #f5f0e8;
      --accent-glow: rgba(234, 88, 12, 0.08);
      --gold-glow: rgba(245, 158, 11, 0.08);
    }
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
    padding: 28px 20px 56px;
  }

  .container { max-width: 960px; margin: 0 auto; }

  .hero {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    padding-bottom: 20px;
    margin-bottom: 18px;
    border-bottom: 1px solid var(--border);
  }
  .hero-title {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
  }
  .hero-badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 5px 12px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--gold);
  }
  .hero-badge .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 6px var(--ok);
  }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .span-full { grid-column: 1 / -1; }
  @media (max-width: 720px) {
    .grid { grid-template-columns: 1fr; }
    .span-full { grid-column: auto; }
  }

  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 14px;
  }
  .card-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .card-title svg { color: var(--gold); width: 14px; height: 14px; }

  .input-row { display: flex; gap: 8px; }
  .input-text {
    flex: 1;
    min-width: 0;
    padding: 10px 12px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: var(--mono);
    font-size: 12px;
    outline: none;
  }
  .input-text:focus { border-color: var(--gold); box-shadow: 0 0 0 2px var(--gold-glow); }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 9px 14px;
    font-family: var(--sans);
    font-size: 12.5px;
    font-weight: 600;
    border-radius: var(--radius-sm);
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--card-elevated);
    color: var(--text);
    white-space: nowrap;
    text-decoration: none;
  }
  .btn:hover { background: var(--border-hover); }
  .btn-primary {
    background: linear-gradient(135deg, #f59e0b, #d9480f);
    border-color: #d9480f;
    color: #fff;
  }
  .btn-primary:hover { filter: brightness(1.08); }

  .tunnel-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-top: 12px;
    flex-wrap: wrap;
  }

  .recents-label {
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    margin: 16px 0 8px;
  }
  .recent-item {
    display: flex;
    align-items: center;
    width: 100%;
    text-align: left;
    padding: 9px 12px;
    margin-bottom: 5px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: var(--mono);
    font-size: 11.5px;
    cursor: pointer;
    word-break: break-all;
  }
  .recent-item:hover { background: var(--card-elevated); border-color: var(--muted); }
  .recent-item.active { border-color: var(--gold); background: rgba(245, 158, 11, 0.08); }
  .recent-item .tag {
    margin-left: auto;
    padding: 2px 7px;
    font-family: var(--sans);
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #fff;
    background: linear-gradient(135deg, #f59e0b, #ea580c);
    border-radius: 4px;
    flex-shrink: 0;
  }

  .toggle-group { display: flex; flex-direction: column; gap: 12px; }
  .toggle-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .toggle-item:last-child { border-bottom: none; padding-bottom: 0; }
  .toggle-item:first-child { padding-top: 0; }
  .toggle-meta .t-title { font-size: 13px; font-weight: 600; color: var(--text); }
  .toggle-meta .t-desc { font-size: 11.5px; color: var(--muted); margin-top: 2px; line-height: 1.4; }

  .switch { position: relative; width: 44px; height: 24px; flex-shrink: 0; margin-left: 14px; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute; cursor: pointer; inset: 0;
    background: var(--border); border-radius: 24px; transition: background 0.2s ease;
  }
  .slider::before {
    content: ''; position: absolute; width: 18px; height: 18px; left: 3px; bottom: 3px;
    background: #fff; border-radius: 50%; transition: transform 0.2s ease;
  }
  .switch input:checked + .slider { background: linear-gradient(135deg, var(--gold), var(--flame)); }
  .switch input:checked + .slider::before { transform: translateX(20px); }
  .switch.danger input:checked + .slider { background: var(--err); }

  .danger-alert {
    display: none;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--err);
    border-radius: var(--radius);
    padding: 12px 16px;
    font-size: 12.5px;
    color: #fca5a5;
    margin-bottom: 16px;
    line-height: 1.5;
  }

  .telemetry-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    text-align: center;
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }
  .telemetry-col { padding: 4px 8px; }
  .telemetry-col:not(:last-child) { border-right: 1px solid var(--border); }
  .telemetry-val { font-size: 20px; font-weight: 700; color: var(--text); }
  .telemetry-lbl {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--muted); margin-top: 2px;
  }

  .jobs-panel { display: none; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
  th {
    color: var(--muted); font-weight: 700; font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .calls-list { max-height: 220px; overflow-y: auto; font-family: var(--mono); font-size: 11.5px; }
  .call-row {
    display: flex; align-items: center; gap: 10px;
    padding: 6px 0; border-bottom: 1px solid var(--border);
  }
  .call-row:last-child { border-bottom: none; }
  .pill { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; }
  .pill.ok { background: rgba(34, 197, 94, 0.15); color: var(--ok); }
  .pill.err { background: rgba(239, 68, 68, 0.15); color: var(--err); }

  #msg { color: var(--err); font-size: 12px; margin-top: 6px; min-height: 16px; }
</style>
</head>
<body>
<div class="container">

  <header class="hero">
    <div class="hero-title">Easy MCP</div>
    <div class="hero-badge">
      <span class="status-dot"></span>
      <span id="statusLine">INITIALIZING...</span>
    </div>
  </header>

  <div class="danger-alert" id="jailWarn">
    <strong>⚠ SECURITY ALERT:</strong> Folder jail is disabled (<kbd>--dangerously-skip-jail</kbd>). Connected clients have access to the entire filesystem.
  </div>

  <div class="grid">

    <div class="card span-full">
      <div class="card-header">
        <div class="card-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          MCP Endpoint
        </div>
        <span style="font-size: 11px; color: var(--muted);" id="stUptime">Uptime: --</span>
      </div>

      <div class="input-row">
        <input type="text" class="input-text" id="mcpUrl" readonly value="(establishing tunnel...)">
        <button class="btn btn-primary" onclick="copyEl('mcpUrl', this)">Copy Link</button>
      </div>

      <div class="tunnel-bar">
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <span style="font-size:12px; color:var(--muted);">Tailscale Funnel</span>
          <span id="tunError" style="font-size:12px; color:var(--err);"></span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          Active Project Workspace
        </div>
      </div>

      <div class="input-row">
        <input type="text" class="input-text" id="projectPath" placeholder="Path to project folder" onkeydown="if(event.key==='Enter') setProject()">
        <button class="btn" id="pickBtn" onclick="pickFolder(this)">Browse</button>
      </div>

      <div class="recents-label">Recent Workspaces</div>
      <div id="recent"></div>
      <div id="msg"></div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          Security & Access Policies
        </div>
      </div>

      <div class="toggle-group">
        <div class="toggle-item">
          <div class="toggle-meta">
            <div class="t-title">Read-Only Mode</div>
            <div class="t-desc">Prohibits all file writes and deletions</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="togReadOnly" onchange="saveSetting('readOnly', this.checked)">
            <span class="slider"></span>
          </label>
        </div>

        <div class="toggle-item">
          <div class="toggle-meta">
            <div class="t-title">Disable Shell Execution</div>
            <div class="t-desc">Shell is ON by default. Toggle on to block command execution and background jobs.</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="togDisableShell" onchange="saveSetting('disableShell', this.checked)">
            <span class="slider"></span>
          </label>
        </div>

        <div class="toggle-item">
          <div class="toggle-meta">
            <div class="t-title" style="color: var(--err);">⚠ Disable Folder Jail</div>
            <div class="t-desc">Allows access to the entire filesystem instead of only the project folder.</div>
          </div>
          <label class="switch danger">
            <input type="checkbox" id="togSkipJail" onchange="toggleJail(this.checked)">
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <div class="telemetry-row">
        <div class="telemetry-col">
          <div class="telemetry-val" id="stCalls">0</div>
          <div class="telemetry-lbl">Calls</div>
        </div>
        <div class="telemetry-col">
          <div class="telemetry-val" id="stErrors">0</div>
          <div class="telemetry-lbl">Errors</div>
        </div>
        <div class="telemetry-col">
          <div class="telemetry-val" id="stSessions">0</div>
          <div class="telemetry-lbl">Sessions</div>
        </div>
        <div class="telemetry-col">
          <div class="telemetry-val" id="stTools">18</div>
          <div class="telemetry-lbl">Tools</div>
        </div>
      </div>
    </div>

    <div class="card span-full jobs-panel" id="jobsCard">
      <div class="card-header">
        <div class="card-title">Active Background Jobs</div>
      </div>
      <table><tbody id="jobsBody"></tbody></table>
    </div>

    <div class="card span-full">
      <div class="card-header">
        <div class="card-title">Recent Tool Calls</div>
        <span style="font-size: 11px; color: var(--muted);" id="callsEmpty">No calls yet</span>
      </div>
      <div class="calls-list" id="callsList"></div>
    </div>

  </div>
</div>

<script>
const ADMIN = '__EASY_MCP_ADMIN__';

function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function copyEl(id, btn){
  const el = document.getElementById(id);
  el.select();
  navigator.clipboard.writeText(el.value).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1400);
  });
}

async function setProject(pathOverride){
  const p = pathOverride || document.getElementById('projectPath').value.trim();
  if (!p) return;
  const res = await fetch('/api/set-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Easy-Mcp-Admin': ADMIN },
    body: JSON.stringify({ path: p })
  });
  const d = await res.json();
  document.getElementById('msg').textContent = d.success ? '' : (d.error || 'Failed to update folder');
  tick();
}

async function pickFolder(btn){
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Browsing...';
  document.getElementById('msg').textContent = '';
  const hintTimer = setTimeout(() => {
    document.getElementById('msg').textContent = 'Dialog open — check your taskbar if you don\\'t see it, or paste a path directly.';
  }, 5000);
  try {
    const res = await fetch('/api/pick-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Easy-Mcp-Admin': ADMIN },
      body: '{}'
    });
    const d = await res.json();
    if (d.success || d.status === 'cancelled') {
      document.getElementById('msg').textContent = '';
    } else if (d.status === 'busy') {
      document.getElementById('msg').textContent = 'Folder picker is already open.';
    } else {
      document.getElementById('msg').textContent = 'Couldn\\'t open folder picker. Please paste the folder path directly.';
    }
  } catch (e) {
    document.getElementById('msg').textContent = 'Folder picker failed';
  }
  clearTimeout(hintTimer);
  btn.disabled = false;
  btn.textContent = orig;
  tick();
}

async function saveSetting(key, value){
  try {
    const body = {};
    body[key] = value;
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Easy-Mcp-Admin': ADMIN },
      body: JSON.stringify(body)
    });
    tick();
  } catch (e) {
    console.error('Settings update failed', e);
  }
}

async function toggleJail(checked){
  if (checked) {
    const yes = confirm(
      '⚠ DANGEROUS: This will disable the folder jail.\\n\\n' +
      'Connected AI clients will be able to read, write, and execute commands ANYWHERE on this machine — not just inside the project folder.\\n\\n' +
      'Are you absolutely sure?'
    );
    if (!yes) {
      document.getElementById('togSkipJail').checked = false;
      return;
    }
  }
  await saveSetting('skipJail', checked);
}

async function stopJob(id){
  await fetch('/api/stop-job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Easy-Mcp-Admin': ADMIN },
    body: JSON.stringify({ id })
  });
  tick();
}

function fmtUptime(s){
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}

async function tick(){
  try {
    const res = await fetch('/api/dashboard', { headers: { 'X-Easy-Mcp-Admin': ADMIN } });
    const d = await res.json();

    const badgeParts = ['ONLINE', 'v' + (d.version || '?'), d.project];
    if (d.readOnly) badgeParts.push('READ-ONLY');
    if (d.disableShell) badgeParts.push('SHELL OFF');
    if (d.skipJail) badgeParts.push('JAIL BYPASSED');
    document.getElementById('statusLine').textContent = badgeParts.join(' · ');

    document.getElementById('jailWarn').style.display = d.skipJail ? 'block' : 'none';
    document.getElementById('togReadOnly').checked = d.readOnly;
    document.getElementById('togDisableShell').checked = d.disableShell;
    document.getElementById('togSkipJail').checked = d.skipJail;

    document.getElementById('mcpUrl').value = d.mcpUrl || '(waiting for Tailscale Funnel...)';

    const te = document.getElementById('tunError');
    if (te) te.textContent = d.tunnelError || '';

    const pp = document.getElementById('projectPath');
    if (document.activeElement !== pp) pp.value = d.project;

    document.getElementById('recent').innerHTML = d.recentProjects.slice(0, 5).map(p =>
      '<button class="recent-item' + (p === d.project ? ' active' : '') + '" onclick="setProject(' + JSON.stringify(p).replace(/"/g, '&quot;') + ')">' +
      esc(p) + (p === d.project ? '<span class="tag">CURRENT</span>' : '') +
      '</button>'
    ).join('');

    document.getElementById('stUptime').textContent = 'Uptime: ' + fmtUptime(d.uptimeSec);
    document.getElementById('stCalls').textContent = d.totalCalls;
    document.getElementById('stErrors').textContent = d.totalErrors;
    document.getElementById('stSessions').textContent = d.activeSessions;
    document.getElementById('stTools').textContent = d.toolsCount;

    const jobsCard = document.getElementById('jobsCard');
    jobsCard.style.display = d.jobs.length ? 'block' : 'none';
    document.getElementById('jobsBody').innerHTML = d.jobs.map(j =>
      '<tr><td>' + esc(j.id) + '</td><td><code>' + esc(j.command) + '</code></td><td>' + esc(j.status) + '</td><td>' +
      (j.status === 'running' ? '<button class="btn" style="padding:4px 10px;font-size:11px;" onclick="stopJob(\\'' + j.id + '\\')">Stop</button>' : '') +
      '</td></tr>'
    ).join('');

    const calls = d.recentCalls || [];
    document.getElementById('callsEmpty').style.display = calls.length ? 'none' : 'inline';
    document.getElementById('callsList').innerHTML = calls.slice(0, 25).map(c =>
      '<div class="call-row">' +
      '<span class="pill ' + (c.ok ? 'ok' : 'err') + '">' + (c.ok ? 'ok' : 'err') + '</span>' +
      '<strong>' + esc(c.tool) + '</strong>' +
      '<span style="color:var(--muted);">' + c.ms + 'ms</span>' +
      '<span style="margin-left:auto;color:var(--muted);">' + esc(c.ts.slice(11, 19)) + '</span>' +
      '</div>'
    ).join('');

  } catch (e) {
    document.getElementById('statusLine').textContent = 'SERVER DISCONNECTED';
  }
}

tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;

// OAuth client/token stores (persisted with hashed secrets — the master
// TOKEN is never handed out by /oauth/register or /oauth/token anymore).
const oauthClientsFile = path.join(easyMcpHome, 'oauth-clients.json');
const oauthTokensFile = path.join(easyMcpHome, 'oauth-tokens.json');
function loadOAuthStore(file) { try { return new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))); } catch { return new Map(); } }
const oauthClients = loadOAuthStore(oauthClientsFile); // client_id -> { secretHash, redirect_uris, authMethod, createdAt }
const oauthTokens = loadOAuthStore(oauthTokensFile);   // sha256(token) -> { type, clientId, exp, createdAt }
function saveOAuth() {
  const now = Date.now();
  for (const [k, v] of oauthTokens) {
    if (v.type === 'access' && v.exp && v.exp < now) oauthTokens.delete(k);
  }
  try {
    fs.mkdirSync(easyMcpHome, { recursive: true, mode: 0o700 });
    for (const [file, map] of [[oauthClientsFile, oauthClients], [oauthTokensFile, oauthTokens]]) {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
  } catch {}
}
function pruneOAuthClients() {
  if (oauthClients.size <= 100) return;
  const sorted = [...oauthClients.entries()].sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
  for (const [id] of sorted.slice(0, oauthClients.size - 100)) oauthClients.delete(id);
}
const registerHits = [];
function registerRateOk() {
  const now = Date.now();
  while (registerHits.length && registerHits[0] < now - 60000) registerHits.shift();
  if (registerHits.length >= 20) return false;
  registerHits.push(now);
  return true;
}
function validRedirectUri(u) {
  try {
    const x = new URL(String(u));
    if (x.protocol === 'https:') return true;
    return x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname);
  } catch { return false; }
}
const oauthCodes = new Map(); // code -> { exp, challenge, method, clientId, redirectUri }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  // Token-in-path form: /mcp/<token> (one-paste link, no '?' for strict URL fields)
  const pathTokenMatch = url.pathname.match(/^\/mcp\/([^/]+)$/);
  if (pathTokenMatch) {
    req._pathToken = decodeURIComponent(pathTokenMatch[1]);
    url.pathname = '/mcp';
  }

  // Browser-to-localhost hardening: block Private Network Access preflights,
  // DNS-rebinding Host headers, and cross-site form/fetch posts to loopback.
  if (req.headers['access-control-request-private-network'] === 'true') { res.writeHead(403); return res.end(); }
  if (!hostAllowed(req)) { res.writeHead(403); return res.end(); }
  if (isLoopbackHost(req.headers.host) && req.method !== 'GET' && req.method !== 'HEAD' && req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403); return res.end(); }

  // CORS only where web MCP clients need it — never on /oauth/* or /api/*,
  // and never a reflected origin (that let any website read responses).
  const corsPath = url.pathname === '/mcp' || url.pathname === '/sse' || url.pathname === '/messages' || url.pathname.startsWith('/.well-known/');
  if (corsPath) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, x-easy-mcp-token, mcp-protocol-version, mcp-method, mcp-name, *');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, *');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    const isAdminRoute = url.pathname === '/' || url.pathname === '/dashboard' || url.pathname.startsWith('/api/');
    if (isAdminRoute) {
      // Dashboard control plane: local browser only — never through the
      // tunnel, never with an MCP/OAuth token.
      if (!isLocalAdminRequest(req)) return sendJson(res, 404, { error: 'Not found' });
      if (url.pathname.startsWith('/api/') && !safeEqual(req.headers['x-easy-mcp-admin'] || '', ADMIN_SECRET)) {
        return sendJson(res, 401, { error: 'Unauthorized' });
      }
    } else if (!isPublicPath(url.pathname) && !authorized(req, url)) {
      if (url.pathname === '/mcp') {
        const base = publicUrl || `http://${req.headers.host || '127.0.0.1:' + PORT}`;
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
      }
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
      const base = publicUrl || `http://${req.headers.host || '127.0.0.1:' + PORT}`;
      return sendJson(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        scopes_supported: ['mcp', 'mcp:read', 'mcp:write'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256', 'plain'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none']
      });
    }

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      const base = publicUrl || `http://${req.headers.host || '127.0.0.1:' + PORT}`;
      return sendJson(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ['header']
      });
    }

    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      const base = publicUrl || `http://${req.headers.host || '127.0.0.1:' + PORT}`;
      const suffix = url.pathname.slice('/.well-known/oauth-protected-resource'.length) || '/mcp';
      return sendJson(res, 200, {
        resource: `${base}${suffix}`,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp']
      });
    }

    if (url.pathname === '/oauth/register' && req.method === 'POST') {
      if (!registerRateOk()) return sendJson(res, 429, { error: 'rate_limited', error_description: 'Too many registrations, try again in a minute' });
      let meta = {};
      try { meta = JSON.parse(await readBody(req, 65536) || '{}'); } catch {}
      const rawUris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
      const redirectUris = rawUris.filter(u => validRedirectUri(u));
      if (rawUris.length && !redirectUris.length) {
        return sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https (or http loopback)' });
      }
      const authMethod = ['none', 'client_secret_post', 'client_secret_basic'].includes(meta.token_endpoint_auth_method) ? meta.token_endpoint_auth_method : 'client_secret_post';
      const clientId = 'mcp_' + crypto.randomBytes(16).toString('hex');
      const clientSecret = authMethod === 'none' ? '' : crypto.randomBytes(32).toString('hex');
      oauthClients.set(clientId, { secretHash: clientSecret ? sha256hex(clientSecret) : '', redirect_uris: redirectUris, authMethod, createdAt: Date.now() });
      pruneOAuthClients();
      saveOAuth();
      const out = {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: authMethod,
        scope: 'mcp'
      };
      if (clientSecret) out.client_secret = clientSecret;
      return sendJson(res, 201, out);
    }

    if (url.pathname === '/oauth/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state') || '';
      const clientId = url.searchParams.get('client_id') || '';
      const client = oauthClients.get(clientId);
      if (redirectUri) {
        if (!client) return sendJson(res, 400, { error: 'invalid_client', error_description: 'Unknown client_id — register first' });
        if (url.searchParams.get('response_type') !== 'code') return sendJson(res, 400, { error: 'unsupported_response_type' });
        const challenge = url.searchParams.get('code_challenge') || '';
        if (!challenge && client.authMethod === 'none') return sendJson(res, 400, { error: 'invalid_request', error_description: 'code_challenge (PKCE) is required for public clients' });
        const uriOk = client.redirect_uris.length ? client.redirect_uris.includes(redirectUri) : validRedirectUri(redirectUri);
        if (!uriOk) return sendJson(res, 400, { error: 'invalid_redirect_uri' });
        const code = crypto.randomBytes(32).toString('hex');
        oauthCodes.set(code, {
          exp: Date.now() + 600000,
          challenge,
          method: url.searchParams.get('code_challenge_method') || 'S256',
          clientId,
          redirectUri
        });
        if (oauthCodes.size > 100) { for (const [k, v] of oauthCodes) { if (v.exp < Date.now()) oauthCodes.delete(k); } }
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        if (state) target.searchParams.set('state', state);
        const issBase = publicUrl || `http://${req.headers.host || '127.0.0.1:' + PORT}`;
        target.searchParams.set('iss', issBase);
        res.writeHead(302, { Location: target.toString() });
        return res.end();
      }
      return sendJson(res, 200, { status: 'authorized' });
    }

    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const raw = await readBody(req, 65536);
      const form = new URLSearchParams(raw);
      let secret = form.get('client_secret') || '';
      let clientId = form.get('client_id') || '';
      const basic = req.headers.authorization || '';
      if (basic.startsWith('Basic ')) {
        try {
          const [id, ...rest] = Buffer.from(basic.slice(6), 'base64').toString().split(':');
          if (!clientId) clientId = id;
          if (!secret) secret = rest.join(':');
        } catch {}
      }
      const grantType = form.get('grant_type') || 'authorization_code';
      const mintTokens = (cid, keepRefresh) => {
        const access = 'emcp_at_' + crypto.randomBytes(32).toString('hex');
        oauthTokens.set(sha256hex(access), { type: 'access', clientId: cid, exp: Date.now() + 86400000, createdAt: Date.now() });
        let refresh = keepRefresh;
        if (!refresh) {
          refresh = 'emcp_rt_' + crypto.randomBytes(32).toString('hex');
          oauthTokens.set(sha256hex(refresh), { type: 'refresh', clientId: cid, exp: 0, createdAt: Date.now() });
        }
        saveOAuth();
        return { access_token: access, token_type: 'Bearer', expires_in: 86400, refresh_token: refresh, scope: 'mcp' };
      };
      if (grantType === 'refresh_token') {
        const rt = form.get('refresh_token') || '';
        // Legacy: connections made before this patch hold the master token as
        // their refresh token. Accept it (it already grants /mcp access) and
        // hand back an opaque access token, keeping the same refresh token.
        if (rt && safeEqual(rt, TOKEN)) return sendJson(res, 200, mintTokens(clientId || 'legacy', TOKEN));
        const rec = oauthTokens.get(sha256hex(rt));
        if (!rec || rec.type !== 'refresh') {
          return sendJson(res, 401, { error: 'invalid_grant', error_description: 'Unknown refresh token' });
        }
        const client = oauthClients.get(rec.clientId);
        if (client && client.authMethod !== 'none' && !safeEqual(sha256hex(secret), client.secretHash)) {
          return sendJson(res, 401, { error: 'invalid_client', error_description: 'Client secret mismatch' });
        }
        return sendJson(res, 200, mintTokens(rec.clientId, rt)); // non-rotating refresh token
      }
      const code = form.get('code') || '';
      const rec = oauthCodes.get(code);
      if (code) oauthCodes.delete(code); // single-use
      if (!rec || rec.exp < Date.now()) {
        return sendJson(res, 401, { error: 'invalid_grant', error_description: 'Unknown or expired code' });
      }
      if (clientId && rec.clientId !== clientId) {
        return sendJson(res, 401, { error: 'invalid_grant', error_description: 'Code was issued to another client' });
      }
      const redirectUri = form.get('redirect_uri') || '';
      if (redirectUri && rec.redirectUri && redirectUri !== rec.redirectUri) {
        return sendJson(res, 401, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      }
      let pkceOk = !rec.challenge;
      if (rec.challenge) {
        const verifier = form.get('code_verifier') || '';
        pkceOk = !!verifier && safeEqual(rec.method === 'plain' ? verifier : crypto.createHash('sha256').update(verifier).digest('base64url'), rec.challenge);
      }
      const client = oauthClients.get(rec.clientId);
      let secretOk = !client || client.authMethod === 'none';
      if (client && client.authMethod !== 'none') secretOk = safeEqual(sha256hex(secret), client.secretHash);
      if (!pkceOk || !secretOk) {
        return sendJson(res, 401, { error: 'invalid_client', error_description: 'PKCE verifier or client secret mismatch' });
      }
      return sendJson(res, 200, mintTokens(rec.clientId, ''));
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
      // no-store: the page embeds a per-process admin secret; a cached copy
      // from a previous run would silently break every dashboard action.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(DASHBOARD_HTML.replace('__EASY_MCP_ADMIN__', ADMIN_SECRET));
    }
    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      return sendJson(res, 200, dashboardData());
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const d = dashboardData();
      return sendJson(res, 200, { status: d.status, project: d.project, toolsCount: d.toolsCount, activeSessions: d.activeSessions, uptimeSec: d.uptimeSec });
    }
    if (req.method === 'POST' && url.pathname === '/api/set-project') {
      const { path: p } = parseJsonBody(await readBody(req));
      try { setProject(p); return sendJson(res, 200, { success: true, project: projectRoot }); }
      catch (err) { return sendJson(res, 400, { success: false, error: err.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/pick-folder') {
      const ac = new AbortController();
      req.on('close', () => { if (!res.writableEnded) ac.abort(); });
      const result = await pickFolderNative({ signal: ac.signal });
      if (result.status === 'ok') {
        try { setProject(result.path); return sendJson(res, 200, { success: true, status: 'ok', project: projectRoot }); }
        catch (err) { return sendJson(res, 400, { success: false, status: 'error', error: err.message }); }
      }
      return sendJson(res, 200, { success: false, status: result.status, error: result.error || null });
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return sendJson(res, 200, { readOnly: READ_ONLY, disableShell: DISABLE_SHELL, skipJail: SKIP_JAIL });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = parseJsonBody(await readBody(req));
      if (typeof body.readOnly === 'boolean') READ_ONLY = body.readOnly;
      if (typeof body.disableShell === 'boolean') DISABLE_SHELL = body.disableShell;
      if (typeof body.skipJail === 'boolean') SKIP_JAIL = body.skipJail;
      return sendJson(res, 200, { success: true, readOnly: READ_ONLY, disableShell: DISABLE_SHELL, skipJail: SKIP_JAIL });
    }
    if (req.method === 'POST' && url.pathname === '/api/stop-job') {
      const { id } = parseJsonBody(await readBody(req));
      const job = jobs.get(id);
      if (!job) return sendJson(res, 404, { success: false, error: 'Unknown job' });
      killJob(job);
      job.status = 'stopped';
      return sendJson(res, 200, { success: true });
    }
    if (req.method === 'POST' && url.pathname === '/call') {
      const { name, arguments: toolArgs } = parseJsonBody(await readBody(req));
      try { return sendJson(res, 200, { success: true, result: await callTool(name, toolArgs) }); }
      catch (err) { return sendJson(res, 400, { success: false, error: err.message }); }
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const raw = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const isInit = messages.some(m => m && m.method === 'initialize');
      let sessionId = req.headers['mcp-session-id'];
      if (isInit) {
        sessionId = crypto.randomBytes(16).toString('hex');
        mcpSessions.set(sessionId, { createdAt: Date.now(), lastSeen: Date.now() });
        pruneMcpSessions();
      } else if (sessionId && mcpSessions.has(sessionId)) {
        mcpSessions.get(sessionId).lastSeen = Date.now();
      }
      const outs = [];
      for (const m of messages) {
        const out = await handleRpc(m);
        if (out) outs.push(out);
      }
      if (!outs.length) { res.writeHead(202); return res.end(); }
      const payload = Array.isArray(parsed) ? outs : outs[0];
      const sseId = url.searchParams.get('sessionId') || sessionId;
      const sseRes = sseId && sseSessions.get(sseId);
      if (sseRes) { try { sseRes.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`); } catch {} }
      const body = JSON.stringify(payload);
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
      if (sessionId) headers['Mcp-Session-Id'] = sessionId;
      res.writeHead(200, headers);
      return res.end(body);
    }
    if (url.pathname === '/mcp' && req.method === 'GET') {
      const accept = req.headers.accept || '';
      if (!accept.includes('text/event-stream')) {
        // Plain GET (e.g. URL validators): answer with a JSON status so connectors can probe the endpoint.
        return sendJson(res, 200, {
          status: 'online',
          service: 'Easy MCP',
          protocolVersion: '2025-03-26',
          toolsCount: TOOLS.length,
          tools: TOOLS.map(t => t.name)
        });
      }
      // Legacy SSE transport: pad to flush proxy buffers, then send the endpoint event.
      if (req.socket) { req.socket.setKeepAlive(true, 10000); req.socket.setNoDelay(true); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const sseId = crypto.randomBytes(16).toString('hex');
      const sseToken = crypto.randomBytes(16).toString('hex');
      sseSessionTokens.set(sseId, sseToken);
      const endpointUri = `${proto}://${host}/mcp?sessionId=${sseId}&token=${sseToken}`;
      res.write(`: ${' '.repeat(4096)}\n\n`);
      res.write(`event: endpoint\ndata: ${endpointUri}\n\n`);
      sseSessions.set(sseId, res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); res.write('event: ping\ndata: {}\n\n'); } catch {} }, 20000);
      const cleanup = () => { clearInterval(ping); sseSessions.delete(sseId); sseSessionTokens.delete(sseId); };
      req.on('close', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);
      return;
    }
    if (url.pathname === '/mcp' && req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'];
      if (sessionId) mcpSessions.delete(sessionId);
      res.writeHead(200);
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/sse') {
      if (req.socket) { req.socket.setKeepAlive(true, 10000); req.socket.setNoDelay(true); }
      const sessionId = crypto.randomBytes(8).toString('hex');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      sseSessions.set(sessionId, res);
      const sseToken = crypto.randomBytes(16).toString('hex');
      sseSessionTokens.set(sessionId, sseToken);
      const q = TOKEN ? `?token=${sseToken}&sessionId=${sessionId}` : `?sessionId=${sessionId}`;
      res.write(`event: endpoint\ndata: /messages${q}\n\n`);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      const cleanup = () => { clearInterval(ping); sseSessions.delete(sessionId); sseSessionTokens.delete(sessionId); };
      req.on('close', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId');
      const sse = sseSessions.get(sessionId);
      const msg = parseJsonBody(await readBody(req));
      const out = await handleRpc(msg);
      if (out && sse) { try { sse.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`); } catch {} }
      res.writeHead(202);
      return res.end();
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    return sendJson(res, err.statusCode || 500, { error: err.message });
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — Easy MCP may already be running. Stop the old instance or use --port <n>.`);
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Easy MCP server on http://127.0.0.1:${PORT} — project: ${projectRoot}`);
  try { startTunnel(); } catch (err) { tunnelError = err.message; }
  if (SKIP_JAIL) console.log('WARNING: --dangerously-skip-jail is ON. The AI can access the whole machine.');
});
