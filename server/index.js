const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { spawn, exec, execFile } = require("child_process");
const readline = require("readline");

const VERSION = "1.1.1";

function cfg(name) {
  const v = process.env[name];
  return v && !v.includes("${") ? v.trim() : "";
}

const CONFIG_DIR = cfg("ADT_CONFIG_DIR") || path.join(os.homedir(), ".arc1");
const SYSTEMS_DIR = path.join(CONFIG_DIR, "systems");
const SECRETS_DIR = path.join(CONFIG_DIR, "secrets");
const DEFAULT_SYSTEM = cfg("ADT_DEFAULT_SYSTEM").toUpperCase();
const AUTO_UPDATE = !/^(false|0|no)$/i.test(cfg("ADT_AUTO_UPDATE") || "true");
const HUB_HOME = path.join(process.env.LOCALAPPDATA || os.homedir(), "sap-adt-hub");
const ARC1_DIR = path.join(HUB_HOME, "arc1");
const TOOLS_CACHE = path.join(HUB_HOME, "tools-cache.json");
const UPDATE_THROTTLE_MS = 10 * 60 * 1000;
const FLAG_KEYS = ["SAP_ALLOW_WRITES", "SAP_ALLOWED_PACKAGES", "SAP_ALLOWED_TRANSPORTS", "SAP_ALLOW_TRANSPORT_WRITES", "SAP_ALLOW_GIT_WRITES", "SAP_ALLOW_FREE_SQL", "SAP_ALLOW_DATA_PREVIEW"];
const ALL_FLAGS_ON = { SAP_ALLOW_WRITES: "true", SAP_ALLOW_TRANSPORT_WRITES: "true", SAP_ALLOW_GIT_WRITES: "true", SAP_ALLOW_FREE_SQL: "true", SAP_ALLOW_DATA_PREVIEW: "true" };

function log(...a) { process.stderr.write(`[sap-adt-hub] ${a.join(" ")}\n`); }

function settingsConnection() {
  const id = cfg("ADT_CONN_ID").toUpperCase();
  if (!id || !cfg("ADT_CONN_URL")) return null;
  const env = { SAP_URL: cfg("ADT_CONN_URL"), SAP_CLIENT: cfg("ADT_CONN_CLIENT"), SAP_USER: cfg("ADT_CONN_USER") };
  if (/^(true|1|yes)$/i.test(cfg("ADT_CONN_INSECURE"))) env.SAP_INSECURE = "true";
  return { id, env, source: "settings", password: cfg("ADT_CONN_PASSWORD") };
}

function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function loadConnections() {
  const out = new Map();
  if (fs.existsSync(SYSTEMS_DIR)) {
    for (const f of fs.readdirSync(SYSTEMS_DIR)) {
      if (!f.endsWith(".env") || f.startsWith("_")) continue;
      const id = f.slice(0, -4).toUpperCase();
      out.set(id, { id, env: parseEnv(fs.readFileSync(path.join(SYSTEMS_DIR, f), "utf8")), source: "file", file: path.join(SYSTEMS_DIR, f) });
    }
  }
  const s = settingsConnection();
  if (s) out.set(s.id, s);
  return out;
}

function envFile(id) { return path.join(SYSTEMS_DIR, `${id}.env`); }
function secretFile(id) { return path.join(SECRETS_DIR, `${id}.sec`); }

function writeEnv(id, updates) {
  fs.mkdirSync(SYSTEMS_DIR, { recursive: true });
  const file = envFile(id);
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const done = new Set();
  const result = [];
  for (const line of lines) {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && m[1] in updates) {
      done.add(m[1]);
      if (updates[m[1]] !== null && updates[m[1]] !== undefined && updates[m[1]] !== "") result.push(`${m[1]}=${updates[m[1]]}`);
    } else result.push(line);
  }
  for (const [k, v] of Object.entries(updates)) if (!done.has(k) && v !== null && v !== undefined && v !== "") result.push(`${k}=${v}`);
  while (result.length && result[result.length - 1] === "") result.pop();
  fs.writeFileSync(file, result.join("\r\n") + "\r\n", "utf8");
}

function validId(id) {
  const v = String(id || "").toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(v)) throw new Error("Connection id must be 1-20 letters/digits (e.g. D58, S4D, Q58-300).");
  return v;
}

function powershell(script, env) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function promptPassword(id, user) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$c = Get-Credential -UserName $env:HUB_USER -Message $env:HUB_MSG",
    "if (-not $c) { exit 2 }",
    "$c.Password | ConvertFrom-SecureString | Set-Content -Path $env:HUB_FILE -Encoding ascii",
    "[Console]::Out.Write($c.UserName)",
  ].join("\n");
  const r = await powershell(script, { HUB_USER: user || "", HUB_MSG: `SAP password for connection ${id}. It is stored encrypted for your Windows user only and never shown to Claude.`, HUB_FILE: secretFile(id) });
  if (r.code === 2 || (r.code && /cancel/i.test(r.stderr))) return { ok: false, cancelled: true };
  if (r.code) return { ok: false, error: r.stderr.trim().split(/\r?\n/)[0] };
  return { ok: true, user: r.stdout.trim().replace(/^\\/, "") };
}

async function readPassword(conn) {
  if (conn.source === "settings" && conn.password) return conn.password;
  if (!fs.existsSync(secretFile(conn.id))) return "";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "$s = Get-Content -Path $env:HUB_FILE | ConvertTo-SecureString",
    "$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)",
    "[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))",
    "[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)",
  ].join("\n");
  const r = await powershell(script, { HUB_FILE: secretFile(conn.id) });
  if (r.code) throw new Error(`Could not decrypt the stored password of ${conn.id} (it only works for the Windows user who stored it). Run adt_set_password.`);
  return r.stdout;
}

function semverCmp(a, b) {
  const x = String(a).split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const y = String(b).split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

function pkgVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version; } catch { return null; }
}

let nodeCache = null;

function nodeRuntime() {
  if (nodeCache) return nodeCache;
  if (!process.versions.electron) return (nodeCache = { exe: process.execPath, env: {} });
  const override = cfg("ADT_NODE_PATH");
  const candidates = [override];
  for (const dir of String(process.env.PATH || process.env.Path || "").split(path.delimiter)) if (dir) candidates.push(path.join(dir.replace(/"/g, ""), "node.exe"));
  candidates.push(
    path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs", "node.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe"),
    process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, "node.exe") : "",
  );
  for (const c of candidates) {
    try { if (c && fs.statSync(c).isFile()) return (nodeCache = { exe: c, env: {} }); } catch {}
  }
  return (nodeCache = { exe: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } });
}

function arc1Install() {
  const managed = path.join(ARC1_DIR, "node_modules", "arc-1");
  const mv = pkgVersion(managed);
  if (mv) return { dir: managed, version: mv, kind: "managed" };
  const global = path.join(process.env.APPDATA || "", "npm", "node_modules", "arc-1");
  const gv = pkgVersion(global);
  if (gv) return { dir: global, version: gv, kind: "global" };
  return null;
}

function getJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { "User-Agent": `sap-adt-hub/${VERSION}`, Accept: "application/json" }, timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => { try { resolve(res.statusCode < 300 ? JSON.parse(body) : null); } catch { resolve(null); } });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

function npmInstall(version) {
  return new Promise((resolve) => {
    fs.mkdirSync(ARC1_DIR, { recursive: true });
    exec(`npm install --prefix "${ARC1_DIR}" arc-1@${version} --no-audit --no-fund --omit=dev --loglevel=error`, { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 1 << 22 }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, error: (stderr || err.message).toString().trim().split(/\r?\n/).slice(-3).join(" ") } : { ok: true });
    });
  });
}

let lastUpdateCheck = 0;
let updating = null;

async function releaseNotes(from, to) {
  const rel = await getJson("https://api.github.com/repos/arc-mcp/arc-1/releases?per_page=30");
  if (!Array.isArray(rel)) return `Release notes: https://github.com/arc-mcp/arc-1/releases`;
  const picked = rel
    .map((r) => ({ v: String(r.tag_name || "").replace(/^v/, ""), name: r.name, body: r.body || "" }))
    .filter((r) => r.v && semverCmp(r.v, from || "0.0.0") > 0 && semverCmp(r.v, to) <= 0)
    .sort((a, b) => semverCmp(b.v, a.v));
  if (!picked.length) return `Release notes: https://github.com/arc-mcp/arc-1/releases/tag/v${to}`;
  return picked.map((r) => `### ${r.v}${r.name && r.name !== `v${r.v}` ? ` - ${r.name}` : ""}\n${r.body.replace(/\r/g, "").trim().slice(0, 1500)}`).join("\n\n");
}

async function checkForUpdates(force) {
  if (updating) return updating;
  if (!force && Date.now() - lastUpdateCheck < UPDATE_THROTTLE_MS) return null;
  updating = (async () => {
    lastUpdateCheck = Date.now();
    const current = arc1Install();
    const latest = await getJson("https://registry.npmjs.org/arc-1/latest");
    if (!latest || !latest.version) return current ? `ARC-1 ${current.version} (${current.kind}); the npm registry could not be reached, update check skipped.` : null;
    if (current && semverCmp(latest.version, current.version) <= 0) return `ARC-1 is up to date (${current.version}).`;
    if (!AUTO_UPDATE && current) return `A new ARC-1 version is available: ${current.version} -> ${latest.version}. Automatic updates are off; enable them in the extension settings or run adt_check_updates with install=true.\n\n${await releaseNotes(current.version, latest.version)}`;
    const r = await npmInstall(latest.version);
    if (!r.ok) return `ARC-1 ${latest.version} is available but could not be installed (${r.error}). Is Node.js with npm installed? Still using ${current ? current.version : "nothing"}.`;
    restartIdleChildren();
    schemaPromise = null;
    loadSchema().then(toolsChanged);
    return `ARC-1 updated ${current ? current.version : "(none)"} -> ${latest.version}. New features and fixes:\n\n${await releaseNotes(current ? current.version : null, latest.version)}`;
  })();
  try { return await updating; } finally { updating = null; }
}

class Arc1Process {
  constructor(label, env) {
    this.label = label;
    this.env = env;
    this.pending = new Map();
    this.seq = 0;
    this.tools = [];
    this.instructions = "";
    this.version = null;
  }

  async start() {
    const inst = arc1Install();
    if (!inst) throw new Error("ARC-1 is not installed and could not be installed automatically. Install Node.js LTS (https://nodejs.org) and try again.");
    this.version = inst.version;
    const node = nodeRuntime();
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(SAP_|ADT_|ELECTRON_)/.test(k)) env[k] = v;
    Object.assign(env, node.env, this.env);
    const entry = path.join(inst.dir, "bin", "arc1.js");
    log(`starting ARC-1 ${inst.version} (${inst.kind}) for ${this.label} with ${node.exe}${node.env.ELECTRON_RUN_AS_NODE ? " (Electron as Node)" : ""}`);
    this.stderrTail = [];
    this.proc = spawn(node.exe, [entry, "--system-label", this.label], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc.on("exit", (code) => {
      this.dead = true;
      log(`ARC-1 for ${this.label} exited (${code})`);
      const tail = this.stderrTail.slice(-5).join(" | ");
      for (const [, p] of this.pending) p.reject(new Error(`ARC-1 for ${this.label} stopped (exit ${code}).${tail ? ` Last output: ${tail}` : ""}`));
      this.pending.clear();
    });
    this.proc.on("error", (e) => {
      log(this.label, "spawn error", e.message);
      this.dead = true;
      for (const [, p] of this.pending) p.reject(new Error(`ARC-1 for ${this.label} could not start with ${node.exe}: ${e.message}`));
      this.pending.clear();
    });
    readline.createInterface({ input: this.proc.stderr }).on("line", (l) => {
      this.stderrTail.push(l.slice(0, 300));
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      if (/ERROR|WARN/.test(l)) log(this.label, l.slice(0, 300));
    });
    readline.createInterface({ input: this.proc.stdout }).on("line", (l) => {
      let m;
      try { m = JSON.parse(l); } catch { return; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || JSON.stringify(m.error)));
        else p.resolve(m.result);
      }
    });
    let timer;
    const init = await Promise.race([
      this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sap-adt-hub", version: VERSION } }),
      new Promise((_, reject) => { timer = setTimeout(() => {
        const tail = this.stderrTail.slice(-5).join(" | ");
        this.stop();
        reject(new Error(`ARC-1 for ${this.label} did not start within 60 s (runtime ${node.exe}).${tail ? ` Last output: ${tail}` : ""}`));
      }, 60000); }),
    ]).finally(() => clearTimeout(timer));
    log(`ARC-1 for ${this.label} ready`);
    this.instructions = init.instructions || "";
    this.notify("notifications/initialized");
    const list = await this.rpc("tools/list", {});
    this.tools = list.tools || [];
    return this;
  }

  rpc(method, params) {
    if (this.dead) return Promise.reject(new Error(`ARC-1 for ${this.label} is not running.`));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params) { if (!this.dead) this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }

  get busy() { return this.pending.size > 0; }

  stop() { if (!this.dead) { this.dead = true; try { this.proc.kill(); } catch {} } }
}

const children = new Map();
const starting = new Map();

function restartIdleChildren() {
  for (const [id, c] of children) if (!c.busy) { c.stop(); children.delete(id); }
}

async function childFor(conn) {
  const existing = children.get(conn.id);
  if (existing && !existing.dead) return { child: existing, notice: null };
  if (starting.has(conn.id)) return { child: await starting.get(conn.id), notice: null };
  const p = (async () => {
    const notice = await checkForUpdates(false);
    const password = await readPassword(conn);
    if (!password) throw new Error(`No password stored for ${conn.id}. Call adt_set_password so the user can enter it in a Windows dialog.`);
    const env = { ...conn.env, SAP_PASSWORD: password };
    const c = await new Arc1Process(conn.id, env).start();
    c.notice = notice;
    children.set(conn.id, c);
    return c;
  })();
  starting.set(conn.id, p);
  try {
    const c = await p;
    const notice = c.notice;
    c.notice = null;
    return { child: c, notice };
  } finally { starting.delete(conn.id); }
}

let schemaPromise = null;

function loadSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    let inst = arc1Install();
    try {
      const cache = JSON.parse(fs.readFileSync(TOOLS_CACHE, "utf8"));
      if (inst && cache.version === inst.version && cache.tools && cache.tools.length) return cache;
    } catch {}
    if (!inst) {
      await checkForUpdates(true);
      inst = arc1Install();
      if (!inst) return { version: null, tools: [], instructions: "" };
    }
    const c = await new Arc1Process("schema", { ...ALL_FLAGS_ON }).start();
    c.stop();
    const schema = { version: c.version, tools: c.tools, instructions: c.instructions };
    fs.mkdirSync(HUB_HOME, { recursive: true });
    fs.writeFileSync(TOOLS_CACHE, JSON.stringify(schema));
    return schema;
  })().catch((e) => { log("schema error", e.message); schemaPromise = null; return { version: null, tools: [], instructions: "" }; });
  return schemaPromise;
}

const FLAG_HINT = {
  SAPWrite: "SAP_ALLOW_WRITES", SAPActivate: "SAP_ALLOW_WRITES", SAPQuery: "SAP_ALLOW_FREE_SQL",
};

function visibleTools(schema) {
  const conns = [...loadConnections().values()];
  return schema.tools.filter((t) => !FLAG_HINT[t.name] || conns.some((c) => /^true$/i.test(c.env[FLAG_HINT[t.name]] || "")));
}

function toolsChanged() { send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }); }

function resolveConnection(args) {
  const conns = loadConnections();
  const want = String(args.system || DEFAULT_SYSTEM || "").toUpperCase();
  if (want) {
    const c = conns.get(want);
    if (!c) throw new Error(`Unknown system "${want}". Known connections: ${[...conns.keys()].join(", ") || "none"}. Add one with adt_add_connection.`);
    return c;
  }
  if (conns.size === 1) return [...conns.values()][0];
  throw new Error(`Pass "system" to choose the SAP connection. Known: ${[...conns.keys()].join(", ") || "none - add one with adt_add_connection"}.`);
}

function proxiedTool(t) {
  const schema = JSON.parse(JSON.stringify(t.inputSchema || { type: "object", properties: {} }));
  schema.properties = { system: { type: "string", description: "SAP connection id (see adt_connections), e.g. D58. Optional only when a single connection exists or a default system is set." }, ...(schema.properties || {}) };
  return { ...t, inputSchema: schema, description: `${t.description || ""}\n\nMulti-system: add "system" with the connection id to choose the SAP system.` };
}

const GUIDE = () => {
  const conns = loadConnections();
  const inst = arc1Install();
  return `
SAP ADT Hub runs one ARC-1 (SAP ADT MCP server) per SAP connection, so you can work with several SAP systems in one chat.
Every ARC-1 tool (SAPRead, SAPSearch, SAPContext, SAPWrite, ...) takes an extra "system" argument with the connection id.

Connections: ${[...conns.values()].map((c) => `${c.id} (${c.env.SAP_URL || "?"}, client ${c.env.SAP_CLIENT || "?"}, user ${c.env.SAP_USER || "?"})`).join("; ") || "none yet"}.
Default system: ${DEFAULT_SYSTEM || "none"}. ARC-1: ${inst ? `${inst.version} (${inst.kind})` : "not installed yet"}. Config folder: ${CONFIG_DIR}

Rules
1. Say which system you use before reading or writing. Never mix up systems.
2. New connection: adt_add_connection with id, url, client, user. The user types the password in a Windows dialog that
   opens on their PC (tell them to look for it, also in the taskbar). Never ask for passwords in the chat.
3. When connecting, the hub checks for a newer ARC-1 and installs it; if the result mentions an update, tell the user
   briefly what is new and use the new capabilities.
4. Connections are read-only by default. Writing, free SQL, data preview and transport writes are enabled per connection
   with adt_set_permissions, only after the user explicitly asked for it; prefer $TMP or a named package/transport.
5. After writing ABAP: activate, run syntax/ATC checks, and report the results honestly.
6. Transport of Copies: use adt_create_toc and follow the step it returns (confirm the development system with the
   user, ask before installing ZCL_RELEASE_TOC in $TMP, show the plan, and only release after an explicit yes).
   After finishing ABAP work on a development system, offer to create the ToC for the task.
`.trim();
};

const HUB_TOOLS = [
  {
    name: "adt_connections",
    description: "List the configured SAP connections (id, URL, client, user, permissions, password stored, running) and the ARC-1 version.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    handler: async () => {
      const conns = loadConnections();
      const inst = arc1Install();
      const rows = [...conns.values()].map((c) => ({
        id: c.id, url: c.env.SAP_URL, client: c.env.SAP_CLIENT, user: c.env.SAP_USER, source: c.source,
        passwordStored: c.source === "settings" ? !!c.password : fs.existsSync(secretFile(c.id)),
        permissions: Object.fromEntries(FLAG_KEYS.filter((k) => c.env[k]).map((k) => [k, c.env[k]])),
        running: !!(children.get(c.id) && !children.get(c.id).dead),
        default: c.id === DEFAULT_SYSTEM,
      }));
      const node = nodeRuntime();
      return text(JSON.stringify({ arc1: inst ? `${inst.version} (${inst.kind})` : null, nodeRuntime: node.exe + (node.env.ELECTRON_RUN_AS_NODE ? " (Electron as Node)" : ""), configDir: CONFIG_DIR, connections: rows }, null, 1));
    },
  },
  {
    name: "adt_add_connection",
    description: "Add or update an SAP connection. Opens a Windows dialog on the user's PC to type the password (never in chat), checks for a newer ARC-1, then tests the connection.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Short name, usually the SID, e.g. D58 or S4D-100." },
        url: { type: "string", description: "ADT base URL incl. port if needed, e.g. http://host:8000 or https://host:44300 (RISE: https://host without port)." },
        client: { type: "string" },
        user: { type: "string" },
        language: { type: "string", description: "Optional logon language, e.g. EN." },
        insecure: { type: "boolean", description: "Accept self-signed TLS certificates (lab systems only)." },
        overwrite: { type: "boolean", description: "Allow replacing an existing connection with the same id." },
      },
      required: ["id", "url", "client", "user"],
    },
    handler: async (a) => {
      const id = validId(a.id);
      const conns = loadConnections();
      if (conns.has(id) && !a.overwrite) throw new Error(`Connection ${id} already exists (${conns.get(id).env.SAP_URL}). Pass overwrite=true to change it.`);
      if (!/^https?:\/\/[^\s/]+/i.test(a.url)) throw new Error("url must start with http:// or https://");
      writeEnv(id, { SAP_URL: a.url.replace(/\/+$/, ""), SAP_CLIENT: a.client, SAP_USER: a.user, SAP_LANGUAGE: a.language || null, SAP_INSECURE: a.insecure ? "true" : null });
      const stopping = children.get(id);
      if (stopping) { stopping.stop(); children.delete(id); }
      const pw = await promptPassword(id, a.user);
      const lines = [`Connection ${id} saved (${a.url}, client ${a.client}, user ${a.user}).`];
      if (!pw.ok) {
        lines.push(pw.cancelled ? "The password dialog was cancelled; nothing was stored. Run adt_set_password to try again." : `Password could not be stored: ${pw.error}`);
        return text(lines.join("\n"), true);
      }
      if (pw.user && pw.user.toUpperCase() !== String(a.user).toUpperCase()) { writeEnv(id, { SAP_USER: pw.user }); lines.push(`User changed in the dialog to ${pw.user}.`); }
      lines.push("Password stored encrypted for this Windows user.");
      lastUpdateCheck = 0;
      lines.push(await testConnection(id));
      return text(lines.join("\n\n"));
    },
  },
  {
    name: "adt_set_password",
    description: "Open a Windows dialog on the user's PC so they can enter or change the SAP password of a connection.",
    inputSchema: { type: "object", properties: { system: { type: "string" } }, required: ["system"] },
    handler: async (a) => {
      const c = resolveConnection(a);
      const pw = await promptPassword(c.id, c.env.SAP_USER);
      if (!pw.ok) return text(pw.cancelled ? "Cancelled, nothing changed." : `Failed: ${pw.error}`, true);
      const old = children.get(c.id);
      if (old) { old.stop(); children.delete(c.id); }
      return text(`Password for ${c.id} stored.\n\n${await testConnection(c.id)}`);
    },
  },
  {
    name: "adt_test_connection",
    description: "Check for a newer ARC-1 and test a connection (reads the system info).",
    inputSchema: { type: "object", properties: { system: { type: "string" } }, required: ["system"] },
    annotations: { readOnlyHint: true },
    handler: async (a) => { lastUpdateCheck = 0; return text(await testConnection(resolveConnection(a).id)); },
  },
  {
    name: "adt_set_permissions",
    description: "Change what ARC-1 may do on one connection (default: read-only). Only after the user explicitly asked. Restarts that connection.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string" },
        allowWrites: { type: "boolean", description: "Create/change/activate objects (SAPWrite, SAPActivate)." },
        allowedPackages: { type: "string", description: "Comma-separated packages writes are limited to, e.g. $TMP,ZMY_PKG." },
        allowedTransports: { type: "string", description: "Comma-separated transport requests allowed for writes." },
        allowTransportWrites: { type: "boolean" },
        allowGitWrites: { type: "boolean" },
        allowFreeSql: { type: "boolean", description: "SAPQuery free SQL (read-only on the database)." },
        allowDataPreview: { type: "boolean", description: "Table/CDS data preview." },
      },
      required: ["system"],
    },
    annotations: { destructiveHint: true },
    handler: async (a) => {
      const c = resolveConnection(a);
      if (c.source !== "file") throw new Error(`${c.id} comes from the extension settings; change its permissions by adding it with adt_add_connection instead.`);
      const b = (v) => (v === undefined ? undefined : v ? "true" : null);
      const upd = {};
      if (a.allowWrites !== undefined) upd.SAP_ALLOW_WRITES = b(a.allowWrites);
      if (a.allowedPackages !== undefined) upd.SAP_ALLOWED_PACKAGES = a.allowedPackages || null;
      if (a.allowedTransports !== undefined) upd.SAP_ALLOWED_TRANSPORTS = a.allowedTransports || null;
      if (a.allowTransportWrites !== undefined) upd.SAP_ALLOW_TRANSPORT_WRITES = b(a.allowTransportWrites);
      if (a.allowGitWrites !== undefined) upd.SAP_ALLOW_GIT_WRITES = b(a.allowGitWrites);
      if (a.allowFreeSql !== undefined) upd.SAP_ALLOW_FREE_SQL = b(a.allowFreeSql);
      if (a.allowDataPreview !== undefined) upd.SAP_ALLOW_DATA_PREVIEW = b(a.allowDataPreview);
      const before = visibleTools(await loadSchema()).length;
      writeEnv(c.id, upd);
      const old = children.get(c.id);
      if (old) { old.stop(); children.delete(c.id); }
      if (visibleTools(await loadSchema()).length !== before) toolsChanged();
      const now = loadConnections().get(c.id);
      return text(`Permissions of ${c.id}: ${JSON.stringify(Object.fromEntries(FLAG_KEYS.filter((k) => now.env[k]).map((k) => [k, now.env[k]])))} (empty = read-only). Takes effect on the next call.`);
    },
  },
  {
    name: "adt_remove_connection",
    description: "Delete a connection and its stored password.",
    inputSchema: { type: "object", properties: { system: { type: "string" } }, required: ["system"] },
    annotations: { destructiveHint: true },
    handler: async (a) => {
      const c = resolveConnection(a);
      if (c.source !== "file") throw new Error(`${c.id} comes from the extension settings; remove it there.`);
      const old = children.get(c.id);
      if (old) { old.stop(); children.delete(c.id); }
      for (const f of [envFile(c.id), secretFile(c.id)]) if (fs.existsSync(f)) fs.rmSync(f);
      return text(`Connection ${c.id} removed.`);
    },
  },
  {
    name: "adt_check_updates",
    description: "Check npm for a newer ARC-1 now and install it (also happens automatically when connecting). Returns what is new.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => text((await checkForUpdates(true)) || "No update information."),
  },
  {
    name: "adt_guide",
    description: "How to use SAP ADT Hub: connections, systems, permissions and update behaviour.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    handler: async () => text(GUIDE()),
  },
];

HUB_TOOLS.push(require("./toc")({ readPassword, Arc1Process, resolveConnection, text, log, hubHome: HUB_HOME, version: VERSION }));

async function testConnection(id) {
  const conn = loadConnections().get(id);
  const { child, notice } = await childFor(conn);
  const r = await child.rpc("tools/call", { name: "SAPRead", arguments: { type: "SYSTEM" } });
  const body = (r.content || []).map((c) => c.text).join("\n").slice(0, 1500);
  const parts = [];
  if (notice) parts.push(notice);
  parts.push(r.isError ? `Connection test FAILED for ${id}: ${body}` : `Connection test OK for ${id} (ARC-1 ${child.version}): ${body}`);
  return parts.join("\n\n");
}

function text(t, isError) { return { content: [{ type: "text", text: t }], isError: !!isError }; }

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function callTool(name, args) {
  const hub = HUB_TOOLS.find((t) => t.name === name);
  if (hub) return hub.handler(args || {});
  const schema = await loadSchema();
  if (!schema.tools.find((t) => t.name === name)) throw new Error(`Unknown tool ${name}`);
  const { system, ...rest } = args || {};
  const conn = resolveConnection({ system });
  const { child, notice } = await childFor(conn);
  if (!child.tools.find((t) => t.name === name)) {
    const flag = FLAG_HINT[name] || "a SAP_ALLOW_* permission";
    return text(`${name} is not enabled on ${conn.id} (needs ${flag}). If the user wants this, call adt_set_permissions for ${conn.id} first.`, true);
  }
  const r = await child.rpc("tools/call", { name, arguments: rest });
  const result = { content: [...(r.content || [])], isError: !!r.isError };
  if (r.structuredContent) result.structuredContent = r.structuredContent;
  result.content.unshift({ type: "text", text: `[system ${conn.id}]` });
  if (notice) result.content.push({ type: "text", text: `\n[ARC-1 update check] ${notice}` });
  return result;
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    const supported = ["2024-11-05", "2025-03-26", "2025-06-18"];
    const v = params && supported.includes(params.protocolVersion) ? params.protocolVersion : "2025-06-18";
    const schema = await loadSchema();
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: v, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "sap-adt-hub", version: VERSION }, instructions: `${GUIDE()}\n\n--- ARC-1 guidance (applies to every system) ---\n${schema.instructions || ""}` } });
  }
  if (method === "tools/list") {
    const schema = await loadSchema();
    const tools = [...HUB_TOOLS.map(({ handler, ...t }) => t), ...visibleTools(schema).map(proxiedTool)];
    return send({ jsonrpc: "2.0", id, result: { tools } });
  }
  if (method === "tools/call") {
    let result;
    const t0 = Date.now();
    log(`call ${params.name}${params.arguments && params.arguments.system ? ` system=${params.arguments.system}` : ""}`);
    try { result = await callTool(params.name, params.arguments); } catch (e) { result = text(String(e.message || e), true); }
    log(`done ${params.name} in ${Date.now() - t0} ms${result.isError ? ` ERROR: ${String(result.content[0].text).slice(0, 200)}` : ""}`);
    return send({ jsonrpc: "2.0", id, result });
  }
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

readline.createInterface({ input: process.stdin }).on("line", (l) => {
  if (!l.trim()) return;
  let msg;
  try { msg = JSON.parse(l); } catch { return; }
  handle(msg).catch((e) => log("error", e.stack || e));
});
process.stdin.on("end", () => { for (const c of children.values()) c.stop(); process.exit(0); });
loadSchema();
log(`sap-adt-hub ${VERSION} ready; config=${CONFIG_DIR}`);
