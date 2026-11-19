const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const SRC_REPO = "rafafreitas87/sap_abap_toc_automation";
const SRC_COMMIT = "090777bb9e404794a71b2eb4d3f2857e4dc1e3d7";
const SRC_FILES = {
  main: "src/zcl_release_toc.clas.abap",
  testclasses: "src/zcl_release_toc.clas.testclasses.abap",
  classrun: "classrun/zcl_release_toc_run.clas.abap",
};
const LOGIC = "ZCL_RELEASE_TOC";
const RUNNER = "ZCL_RELEASE_TOC_RUN";
const CLASSRUN_MIN_RELEASE = 752;

module.exports = function createTocTool(ctx) {
  const tocChildren = new Map();

  async function tocChild(conn) {
    const existing = tocChildren.get(conn.id);
    if (existing && !existing.dead) return existing;
    const password = await ctx.readPassword(conn);
    if (!password) throw new Error(`No password stored for ${conn.id}. Call adt_set_password first.`);
    const env = { ...conn.env, SAP_PASSWORD: password, SAP_ALLOW_WRITES: "true", SAP_ALLOWED_PACKAGES: "$TMP", SAP_ALLOW_FREE_SQL: "true" };
    delete env.SAP_ALLOWED_TRANSPORTS;
    delete env.SAP_ALLOW_TRANSPORT_WRITES;
    const child = await new ctx.Arc1Process(`${conn.id}-toc`, env).start();
    tocChildren.set(conn.id, child);
    return child;
  }

  async function call(child, name, args) {
    const r = await child.rpc("tools/call", { name, arguments: args });
    const out = (r.content || []).map((c) => c.text || "").join("\n");
    if (r.isError) throw new Error(`${name} failed: ${out.slice(0, 1200)}`);
    return out;
  }

  function parseJson(txt) {
    try { return JSON.parse(txt); } catch {}
    const m = /\{[\s\S]*\}/.exec(txt);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return null;
  }

  async function sql(child, query, maxRows = 200) {
    const out = await call(child, "SAPQuery", { action: "sql", sql: query, maxRows });
    const j = parseJson(out);
    if (!j || !Array.isArray(j.rows)) throw new Error(`Unexpected SAPQuery result: ${out.slice(0, 300)}`);
    return j.rows;
  }

  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

  function getText(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { "User-Agent": `sap-adt-hub/${ctx.version}` }, timeout: 15000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`)); }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve(body));
      }).on("timeout", function () { this.destroy(new Error(`GET ${url} timed out`)); }).on("error", reject);
    });
  }

  async function sources() {
    const dir = path.join(ctx.hubHome, "toc-src", SRC_COMMIT);
    fs.mkdirSync(dir, { recursive: true });
    const out = {};
    for (const [key, file] of Object.entries(SRC_FILES)) {
      const cached = path.join(dir, path.basename(file));
      if (!fs.existsSync(cached)) fs.writeFileSync(cached, await getText(`https://raw.githubusercontent.com/${SRC_REPO}/${SRC_COMMIT}/${file}`), "utf8");
      out[key] = fs.readFileSync(cached, "utf8");
    }
    return out;
  }

  function adtClient(conn, password) {
    const base = new URL(conn.env.SAP_URL);
    const secure = base.protocol === "https:";
    const mod = secure ? https : http;
    const agent = new mod.Agent({ keepAlive: true, ...(secure && /^true$/i.test(conn.env.SAP_INSECURE || "") ? { rejectUnauthorized: false } : {}) });
    const auth = "Basic " + Buffer.from(`${conn.env.SAP_USER}:${password}`).toString("base64");
    const cookies = {};
    let csrf = null;

    function request(method, p, body, headers) {
      return new Promise((resolve, reject) => {
        const u = new URL(p, base);
        if (conn.env.SAP_CLIENT) u.searchParams.set("sap-client", conn.env.SAP_CLIENT);
        if (conn.env.SAP_LANGUAGE) u.searchParams.set("sap-language", conn.env.SAP_LANGUAGE);
        const h = { Authorization: auth, ...headers };
        const ck = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
        if (ck) h.Cookie = ck;
        if (body) h["Content-Length"] = Buffer.byteLength(body);
        const r = mod.request(u, { method, headers: h, agent, timeout: 10 * 60 * 1000 }, (res) => {
          for (const c of [].concat(res.headers["set-cookie"] || [])) {
            const kv = c.split(";")[0];
            const i = kv.indexOf("=");
            if (i > 0) cookies[kv.slice(0, i).trim()] = kv.slice(i + 1);
          }
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (data += d));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        r.on("timeout", () => r.destroy(new Error("SAP did not answer within 10 minutes")));
        r.on("error", reject);
        if (body) r.write(body);
        r.end();
      });
    }

    async function fetchToken() {
      const r = await request("GET", "/sap/bc/adt/core/discovery", null, { "x-csrf-token": "fetch", Accept: "application/atomsvc+xml" });
      if (r.status === 401) throw new Error(`SAP rejected the logon for ${conn.id} (HTTP 401).`);
      csrf = r.headers["x-csrf-token"];
      if (!csrf) throw new Error(`No CSRF token from ${conn.id} (HTTP ${r.status}).`);
    }

    return {
      async post(p, body, contentType, accept) {
        if (!csrf) await fetchToken();
        let r = await request("POST", p, body, { "x-csrf-token": csrf, "Content-Type": contentType, Accept: accept });
        if (r.status === 403 && /required/i.test(String(r.headers["x-csrf-token"] || ""))) {
          await fetchToken();
          r = await request("POST", p, body, { "x-csrf-token": csrf, "Content-Type": contentType, Accept: accept });
        }
        return r;
      },
    };
  }

  const xmlText = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

  function unitMessages(xml) {
    const msgs = [];
    for (const m of xml.matchAll(/<title>([^<]*)<\/title>/g)) msgs.push(xmlText(m[1]));
    for (const m of xml.matchAll(/\stext="([^"]*)"/g)) msgs.push(xmlText(m[1]));
    return [...new Set(msgs.map((s) => s.trim()).filter(Boolean))];
  }

  async function runUnit(conn, password) {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit">
  <external><coverage active="false"/></external>
  <options>
    <uriType value="semantic"/>
    <testDeterminationStrategy sameProgram="true" assignedTests="false" publicApi="false"/>
    <testRiskLevels harmless="true" dangerous="true" critical="false"/>
    <testDurations short="true" medium="true" long="true"/>
  </options>
  <adtcore:objectSets xmlns:adtcore="http://www.sap.com/adt/core">
    <objectSet kind="inclusive"><adtcore:objectReferences>
      <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/${LOGIC.toLowerCase()}"/>
    </adtcore:objectReferences></objectSet>
  </adtcore:objectSets>
</aunit:runConfiguration>`;
    const r = await adtClient(conn, password).post("/sap/bc/adt/abapunit/testruns", body, "application/vnd.sap.adt.abapunit.testruns.config.v4+xml", "application/vnd.sap.adt.abapunit.testruns.result.v2+xml");
    if (r.status >= 300) throw new Error(`ABAP Unit run failed (HTTP ${r.status}): ${unitMessages(r.body).join(" | ") || r.body.slice(0, 400)}`);
    return unitMessages(r.body).join("\n");
  }

  async function runClassrun(conn, password) {
    const r = await adtClient(conn, password).post(`/sap/bc/adt/oo/classrun/${RUNNER}`, "", "text/plain", "text/plain");
    if (r.status >= 300) throw new Error(`Console app run failed (HTTP ${r.status}): ${r.body.slice(0, 400)}`);
    return r.body.trim();
  }

  function setConstants(src, trkorr, target) {
    let hits = 0;
    let out = src.replace(/(CONSTANTS\s+c_trkorr\s+TYPE\s+trkorr\s+VALUE\s+)'[^']*'/i, (_, p) => { hits++; return `${p}'${trkorr}'`; });
    if (target) out = out.replace(/(CONSTANTS\s+c_target\s+TYPE\s+trexreqhd-target\s+VALUE\s+)'[^']*'/i, (_, p) => { hits++; return `${p}'${target}'`; });
    if (hits < (target ? 2 : 1)) throw new Error("Could not find the C_TRKORR/C_TARGET constants in the runner source.");
    return out;
  }

  function stripReadHeader(txt) {
    const j = parseJson(txt);
    if (j && typeof j.source === "string") return j.source;
    return txt;
  }

  async function runnerSource(child, useClassrun) {
    const args = useClassrun ? { type: "CLAS", name: RUNNER } : { type: "CLAS", name: LOGIC, include: "testclasses" };
    return { args, source: stripReadHeader(await call(child, "SAPRead", args)) };
  }

  async function writeRunner(child, useClassrun, args, source) {
    const name = useClassrun ? RUNNER : LOGIC;
    await call(child, "SAPWrite", { action: "update", ...args, source, lintBeforeWrite: false });
    await call(child, "SAPActivate", { type: "CLAS", name });
  }

  async function installed(child) {
    const rows = await sql(child, `SELECT obj_name, devclass FROM tadir WHERE pgmid = 'R3TR' AND object = 'CLAS' AND obj_name IN (${lit(LOGIC)}, ${lit(RUNNER)})`);
    const has = Object.fromEntries(rows.map((r) => [String(r.OBJ_NAME).trim(), String(r.DEVCLASS).trim()]));
    let runnerInclude = false;
    if (has[LOGIC]) {
      try {
        const inc = stripReadHeader(await call(child, "SAPRead", { type: "CLAS", name: LOGIC, include: "testclasses" }));
        runnerInclude = /ltc_runner/i.test(inc) && /c_trkorr/i.test(inc);
      } catch { runnerInclude = false; }
    }
    return { has, runnerInclude };
  }

  async function basisRelease(child) {
    const rows = await sql(child, "SELECT release FROM cvers WHERE component = 'SAP_BASIS'");
    const rel = parseInt(String(rows[0] && rows[0].RELEASE || "").trim(), 10);
    if (!rel) throw new Error("Could not read the SAP_BASIS release (CVERS).");
    return rel;
  }

  async function suggestTargets(child, user) {
    const since = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
    const rows = await sql(child, `SELECT tarsystem FROM e070 WHERE trfunction = 'T' AND as4user = ${lit(user)} AND as4date >= ${lit(since)}`, 2000);
    const counts = {};
    for (const r of rows) { const t = String(r.TARSYSTEM || "").trim(); if (t) counts[t] = (counts[t] || 0) + 1; }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }

  async function transportInfo(child, trkorr) {
    const [h] = await sql(child, `SELECT trkorr, strkorr, trfunction, trstatus, as4user FROM e070 WHERE trkorr = ${lit(trkorr)}`);
    if (!h) throw new Error(`Transport ${trkorr} does not exist (E070).`);
    const isTask = !!String(h.STRKORR || "").trim();
    const parent = isTask ? String(h.STRKORR).trim() : trkorr;
    const texts = await sql(child, `SELECT langu, as4text FROM e07t WHERE trkorr = ${lit(parent)}`);
    const tasks = isTask ? [] : await sql(child, `SELECT trkorr, trstatus, as4user FROM e070 WHERE strkorr = ${lit(trkorr)}`);
    const list = [trkorr, ...tasks.map((t) => String(t.TRKORR).trim())];
    const objects = await sql(child, `SELECT trkorr, pgmid, object, obj_name FROM e071 WHERE trkorr IN (${list.map(lit).join(", ")})`, 2000);
    return { header: h, isTask, parent, text: texts.length ? String(texts[0].AS4TEXT).trim() : "", tasks, objects };
  }

  return {
    name: "adt_create_toc",
    description: [
      "Create a Transport of Copies (ToC) from a task or request and release it to the test system, using ZCL_RELEASE_TOC (",
      `github.com/${SRC_REPO}). Step by step, each step returns what to ask the user:`,
      "1) Call with system + transport. It asks you to CONFIRM WITH THE USER that this is the development system they are working on (systemConfirmed=true).",
      "2) It checks ZCL_RELEASE_TOC and its runner. If missing it asks whether they may be created as local $TMP objects (install=true). If present it continues.",
      "3) It returns the plan (transport text, tasks, object count, suggested target from the user's ToC history). Ask the user to confirm the target and the release.",
      "4) Call with confirm=true (and target) to create and release the ToC; the result is verified in E070/E071.",
      "Releasing cannot be undone: never set confirm=true without the user's explicit yes in the chat.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "Connection id of the DEVELOPMENT system the user is working on, e.g. D58." },
        transport: { type: "string", description: "Task or request number, e.g. D58K991234." },
        target: { type: "string", description: "ToC target system or system.client, e.g. Q58 or Q58.290. If omitted, a target is suggested." },
        systemConfirmed: { type: "boolean", description: "The user confirmed this is the right development system." },
        install: { type: "boolean", description: "The user allowed creating the missing ZCL_RELEASE_TOC objects in $TMP." },
        confirm: { type: "boolean", description: "The user confirmed creating AND releasing the ToC with the shown plan and target." },
      },
      required: ["system", "transport"],
    },
    annotations: { destructiveHint: true },
    handler: async (a) => {
      const conn = ctx.resolveConnection(a);
      const trkorr = String(a.transport || "").trim().toUpperCase();
      if (!/^[A-Z0-9]{3}K\d{6}$/.test(trkorr)) throw new Error("transport must look like D58K991234.");
      const target = a.target ? String(a.target).trim().toUpperCase() : "";
      if (target && !/^[A-Z0-9]{3}(\.\d{3})?$/.test(target)) throw new Error("target must look like Q58 or Q58.290.");
      const where = `${conn.id} (${conn.env.SAP_URL}, client ${conn.env.SAP_CLIENT}, user ${conn.env.SAP_USER})`;

      if (!a.systemConfirmed) {
        return ctx.text(`CONFIRM_SYSTEM: the ToC for ${trkorr} would be created on ${where}.\nAsk the user: "Is ${conn.id} / client ${conn.env.SAP_CLIENT} the development system you are working on?" If yes, call adt_create_toc again with systemConfirmed=true. If not, ask which connection to use (adt_connections).`);
      }

      const child = await tocChild(conn);
      const release = await basisRelease(child);
      const useClassrun = release >= CLASSRUN_MIN_RELEASE;
      let state = await installed(child);
      const missing = [];
      if (!state.has[LOGIC]) missing.push(`${LOGIC} (logic class)`);
      if (useClassrun && !state.has[RUNNER]) missing.push(`${RUNNER} (console-app runner)`);
      if (!useClassrun && !state.runnerInclude) missing.push(`${LOGIC} local test class ltc_runner (ABAP Unit runner)`);

      const notes = [];
      if (missing.length) {
        if (!a.install) {
          return ctx.text(`NEEDS_INSTALL on ${where} (SAP_BASIS ${release}): missing ${missing.join(", ")}.\nAsk the user: "May I create these as local objects in $TMP on ${conn.id}? They are never transported." If yes, call again with systemConfirmed=true and install=true.`);
        }
        if (state.has[LOGIC] && !useClassrun && !state.runnerInclude) {
          const inc = stripReadHeader(await call(child, "SAPRead", { type: "CLAS", name: LOGIC, include: "testclasses" }).catch(() => ""));
          if (/FOR\s+TESTING/i.test(inc)) throw new Error(`${LOGIC} already has other local test classes; not overwriting them. Add ltc_runner manually from github.com/${SRC_REPO}.`);
        }
        const src = await sources();
        if (!state.has[LOGIC]) {
          await call(child, "SAPWrite", { action: "create", type: "CLAS", name: LOGIC, package: "$TMP", description: "Create and release Transport of Copies", source: src.main, lintBeforeWrite: false });
          notes.push(`Created ${LOGIC} in $TMP.`);
        }
        if (!useClassrun && !state.runnerInclude) {
          await call(child, "SAPWrite", { action: "update", type: "CLAS", name: LOGIC, include: "testclasses", source: src.testclasses, lintBeforeWrite: false });
          notes.push("Added the ABAP Unit runner (ltc_runner).");
        }
        if (useClassrun && !state.has[RUNNER]) {
          await call(child, "SAPWrite", { action: "create", type: "CLAS", name: RUNNER, package: "$TMP", description: "Console runner for ZCL_RELEASE_TOC", source: src.classrun, lintBeforeWrite: false });
          notes.push(`Created ${RUNNER} in $TMP.`);
        }
        await call(child, "SAPActivate", { objects: [{ type: "CLAS", name: LOGIC }, ...(useClassrun ? [{ type: "CLAS", name: RUNNER }] : [])] });
        notes.push("Activated.");
        state = await installed(child);
        if (!state.has[LOGIC]) throw new Error(`Installation did not succeed: ${LOGIC} is still missing.`);
      }

      const info = await transportInfo(child, trkorr);
      let suggestion = [];
      if (!target) suggestion = await suggestTargets(child, String(conn.env.SAP_USER || "").toUpperCase());
      const chosen = target || (suggestion[0] && suggestion[0][0]) || "";
      const plan = [
        `System: ${where}, SAP_BASIS ${release}, trigger: ${useClassrun ? "console app" : "ABAP Unit (risk level DANGEROUS)"}.`,
        `Source: ${trkorr} (${info.isTask ? `task of ${info.parent}` : `request with ${info.tasks.length} task(s)`}), owner ${String(info.header.AS4USER).trim()}, status ${String(info.header.TRSTATUS).trim()}.`,
        `ToC description: "TOC: ${info.text}".`,
        `Objects to copy: ${info.objects.length}${info.objects.length ? ` (e.g. ${info.objects.slice(0, 5).map((o) => `${String(o.OBJECT).trim()} ${String(o.OBJ_NAME).trim()}`).join(", ")})` : ""}.`,
        `Target: ${chosen || "UNKNOWN"}${!target && suggestion.length ? ` (suggested from the user's ToCs of the last 180 days: ${suggestion.map(([t, n]) => `${t} x${n}`).join(", ")})` : ""}.`,
      ];

      if (!a.confirm || !target) {
        return ctx.text(`${notes.length ? notes.join(" ") + "\n\n" : ""}PLAN (nothing created yet):\n- ${plan.join("\n- ")}\n\nAsk the user to confirm the target and that the ToC may be created AND released (cannot be undone). Then call again with systemConfirmed=true, target="${chosen || "<target>"}", confirm=true.`);
      }
      if (!info.objects.length) throw new Error(`${trkorr} contains no objects; nothing to copy.`);

      const password = await ctx.readPassword(conn);
      const { args, source } = await runnerSource(child, useClassrun);
      const armed = setConstants(source, trkorr, target);
      const reset = setConstants(source, "", target);
      let output = "";
      let failure = null;
      ctx.log(`toc: arming runner on ${conn.id} for ${trkorr} -> ${target}`);
      await writeRunner(child, useClassrun, args, armed);
      try {
        output = useClassrun ? await runClassrun(conn, password) : await runUnit(conn, password);
      } catch (e) { failure = e; }
      try { await writeRunner(child, useClassrun, args, reset); } catch (e) { notes.push(`WARNING: could not reset C_TRKORR in the runner (${e.message}). Reset it before the next activation.`); }
      if (failure) throw failure;

      const m = /TOC\s+([A-Z0-9]{3}K\d{6})\s+created from/i.exec(output);
      if (!m) {
        const hint = /risk level|upper limit|Risikostufe/i.test(output) ? "\nThe client does not allow DANGEROUS unit tests: in transaction SAUNIT_CLIENT_SETUP set the maximum risk level of this client to Dangerous, then retry." : "";
        return ctx.text(`ToC run on ${conn.id} did not report a created ToC.${hint}\nOutput:\n${output.slice(0, 2000)}`, true);
      }
      const toc = m[1];
      const [h] = await sql(child, `SELECT trkorr, trfunction, trstatus, tarsystem FROM e070 WHERE trkorr = ${lit(toc)}`);
      const [t] = await sql(child, `SELECT as4text FROM e07t WHERE trkorr = ${lit(toc)}`);
      const objs = await sql(child, `SELECT obj_name FROM e071 WHERE trkorr = ${lit(toc)}`, 2000);
      const released = h && String(h.TRSTATUS).trim() === "R";
      return ctx.text([
        ...notes,
        `${released ? "OK" : "CHECK"}: ToC ${toc} created from ${trkorr} on ${conn.id}${released ? " and released" : ""} to ${h ? String(h.TARSYSTEM).trim() : target}.`,
        `Verified: type ${h ? String(h.TRFUNCTION).trim() : "?"}, status ${h ? String(h.TRSTATUS).trim() : "?"}, text "${t ? String(t.AS4TEXT).trim() : ""}", ${objs.length} object(s).`,
        `Runner output: ${output.split("\n").filter((l) => /TOC|ERROR|OK/i.test(l)).slice(0, 3).join(" | ")}`,
      ].join("\n"), !released);
    },
  };
};
