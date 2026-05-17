const { ImapFlow } = require("imapflow");
const { load } = require("cheerio");
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require("fs");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const env = loadEnv();
const cfg = JSON.parse(readFileSync(`${__dirname}/config.json`, "utf-8"));
const CACHE_DIR = `${__dirname}/cache`;
const CACHE_FILE = `${CACHE_DIR}/links.json`;

async function main() {
  const emails = await downloadEmails();

  if (!emails.length) {
    console.log("\nNo matching emails found.");
    return;
  }

  console.log(`\n${emails.length} emails matched\n`);

  const cache = loadCache();
  const allLinks = [...new Set(emails.flatMap((e) => e.links))];
  const toResolve = allLinks.filter((link) => !cache[link]);

  console.log(
    `${allLinks.length} unique links, ` +
      `${allLinks.length - toResolve.length} cached, ` +
      `${toResolve.length} to resolve`
  );

  if (toResolve.length) {
    await resolveAll(toResolve, cache);
  }

  const params = cfg.links?.extractParams || [];
  const results = [];

  for (const email of emails) {
    for (const link of email.links) {
      const url = cache[link] || link;
      const extracted = pickParams(url, params);
      if (Object.keys(extracted).length === 0) continue;

      results.push({
        subject: email.subject,
        product: email.product,
        subgroup: matchSubgroup(email.subject),
        params: extracted,
      });
    }
  }

  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  const html = buildHtml(results, params, now);

  const latest = `${__dirname}/${cfg.output?.htmlFile || "report.html"}`;
  const archived = `${CACHE_DIR}/report_${stamp}.html`;
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(latest, html);
  writeFileSync(archived, html);

  console.log(`\nDone — ${emails.length} emails, ${results.length} entries.`);
  console.log(`Report: ${cfg.output?.htmlFile || "report.html"}`);
  console.log(`Saved:  cache/report_${stamp}.html`);
}

async function downloadEmails() {
  const s = cfg.search || {};
  const domains = cfg.links?.onlyFromDomains || [];

  const client = new ImapFlow({
    host: cfg.imap?.host || "imap.gmail.com",
    port: cfg.imap?.port || 993,
    secure: true,
    auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
    logger: false,
  });

  await client.connect();
  console.log(`Connected as ${env.GMAIL_USER}`);

  const lock = await client.getMailboxLock(s.mailbox || "INBOX");
  const since = s.daysBack
    ? new Date(Date.now() - s.daysBack * 86400000)
    : undefined;

  const emails = [];
  let total = 0;
  let skipped = 0;

  try {
    const search = {};
    if (s.from) search.from = s.from;
    if (s.subject) search.subject = s.subject;
    if (since) search.since = since;

    console.log("Search:", JSON.stringify(search));

    // Pass 1: scan subjects only (fast)
    console.log("  Scanning subjects...");
    const matchedUids = [];

    for await (const msg of client.fetch(search, { envelope: true, uid: true })) {
      total++;
      const subj = msg.envelope.subject || "";
      const product = matchProduct(subj);

      if (cfg.products && !product) {
        skipped++;
        if (skipped % 100 === 0)
          process.stdout.write(
            `\r  ${total} scanned, ${skipped} skipped, ${matchedUids.length} matched`
          );
        continue;
      }

      matchedUids.push({ uid: msg.uid, product });
      if (s.limit && matchedUids.length >= s.limit) break;
    }

    process.stdout.write(
      `\r  ${total} scanned, ${skipped} skipped, ${matchedUids.length} matched\n`
    );

    // Pass 2: download bodies for matched emails
    if (matchedUids.length) {
      console.log(`  Downloading ${matchedUids.length} email bodies...`);
      const uidMap = Object.fromEntries(matchedUids.map((m) => [m.uid, m.product]));
      const uidList = matchedUids.map((m) => m.uid);

      const fetched = client.fetch(
        uidList,
        { source: true, envelope: true, uid: true },
        { uid: true }
      );

      for await (const msg of fetched) {
        const subj = msg.envelope.subject || "";
        const product = uidMap[msg.uid];

        const $ = load(msg.source.toString());
        let links = [
          ...new Set(
            $("a[href^=http]")
              .map((_, el) => $(el).attr("href"))
              .get()
          ),
        ];

        if (domains.length) {
          links = links.filter((link) => {
            try {
              return domains.includes(new URL(link).hostname);
            } catch {
              return false;
            }
          });
        }

        emails.push({ subject: subj, product, links });
        process.stdout.write(`\r  Downloaded ${emails.length}/${matchedUids.length} emails`);
      }
      process.stdout.write("\n");
    }
  } finally {
    lock.release();
    await client.logout();
  }

  return emails;
}

async function resolveAll(links, cache) {
  const BATCH = 50;

  for (let i = 0; i < links.length; i += BATCH) {
    const batch = links.slice(i, i + BATCH);
    await Promise.all(batch.map((link) => resolveLink(link, cache)));

    const done = Math.min(i + BATCH, links.length);
    const pct = Math.round((done / links.length) * 100);
    const filled = Math.round(pct / 2);
    const bar = "#".repeat(filled) + "-".repeat(50 - filled);
    process.stdout.write(`\r  [${bar}] ${pct}% (${done}/${links.length})`);
    saveCache(cache);
  }

  process.stdout.write("\n\n");
}

async function resolveLink(link, cache) {
  if (cache[link]) return;
  let url = link;
  for (let hop = 0; hop < 10; hop++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(url, { redirect: "manual", signal: ctrl.signal });
      clearTimeout(timer);
      const location = res.headers.get("location");
      if (!location) break;
      url = location;
    } catch {
      break;
    }
  }
  cache[link] = url;
}

function pickParams(url, paramNames) {
  const result = {};
  try {
    const u = new URL(url);
    for (const name of paramNames) {
      const val = u.searchParams.get(name);
      if (val) result[name] = val;
    }
  } catch {}
  return result;
}

function matchSubgroup(subject) {
  const subs = cfg.subgroups || [];
  if (!subs.length) return null;
  const lower = subject.toLowerCase();
  for (const kw of subs) {
    if (lower.includes(kw.toLowerCase())) return kw;
  }
  return "Other";
}

function matchProduct(subject) {
  if (!cfg.products) return null;
  const lower = subject.toLowerCase();

  for (const [name, rule] of Object.entries(cfg.products)) {
    const keywords = Array.isArray(rule) ? rule : rule.required || [];
    if (keywords.length && keywords.every((kw) => lower.includes(kw.toLowerCase()))) {
      return name;
    }
  }

  return null;
}

function loadCache() {
  try {
    if (existsSync(CACHE_FILE))
      return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {}
  return {};
}

function saveCache(cache) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function buildHtml(results, paramNames, date = new Date()) {
  const hasSubgroups = (cfg.subgroups || []).length > 0;
  const grouped = cfg.output?.groupByProduct && cfg.products;
  let body = "";

  if (grouped) {
    const products = groupBy(results, (r) => r.product || "Other");
    for (const [product, rows] of Object.entries(products)) {
      if (hasSubgroups) {
        const subs = groupBy(rows, (r) => r.subgroup || "Other");
        let subBody = "";
        for (const [sub, subRows] of Object.entries(subs)) {
          const deduped = dedup(subRows, paramNames);
          subBody += `<details open><summary class="sub">${esc(sub)} <span class="count">${subRows.length}</span></summary>`;
          subBody += renderTable(deduped, paramNames);
          subBody += `</details>`;
        }
        body += `<details open><summary class="product">${esc(product)} <span class="count">${rows.length}</span></summary>${subBody}</details>`;
      } else {
        const deduped = dedup(rows, paramNames);
        body += `<details open><summary class="product">${esc(product)} <span class="count">${rows.length}</span></summary>`;
        body += renderTable(deduped, paramNames);
        body += `</details>`;
      }
    }
  } else {
    const deduped = dedup(results, paramNames);
    body += `<h2>All (${results.length})</h2>` + renderTable(deduped, paramNames);
  }

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Campaign Report</title>
<style>
  *{margin:0;box-sizing:border-box}
  body{font-family:-apple-system,sans-serif;padding:24px;background:#f5f5f5;color:#1a1a1a}
  h1{margin-bottom:8px} .meta{color:#666;margin-bottom:24px}
  details{margin:8px 0;border-radius:8px;overflow:hidden}
  details details{margin-left:16px}
  summary{cursor:pointer;padding:10px 14px;font-weight:600;border-radius:8px;list-style:none;display:flex;align-items:center;gap:8px}
  summary::-webkit-details-marker{display:none}
  summary::before{content:"\\25BC";font-size:10px;transition:transform .2s}
  details:not([open])>summary::before{transform:rotate(-90deg)}
  .product{background:#333;color:#fff;font-size:16px;border-radius:8px}
  .sub{background:#e0e7ff;color:#3730a3;font-size:14px}
  .count{background:rgba(255,255,255,.25);padding:2px 10px;border-radius:12px;font-size:12px;font-weight:700}
  .sub .count{background:rgba(55,48,163,.15)}
  table{width:100%;border-collapse:collapse;background:#fff;margin:8px 0 16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  th{background:#f0f0f0;color:#333;text-align:left;padding:8px 14px;font-weight:600;font-size:13px}
  td{padding:8px 14px;border-top:1px solid #eee;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  tr:hover{background:#f9f9f9}
  .badge{display:inline-block;background:#e0e7ff;color:#3730a3;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:700}
  .emails-toggle{cursor:pointer;user-select:none}
  .emails-toggle:hover{text-decoration:underline}
  .emails-list{display:none;padding:6px 14px;background:#fafafa;border-top:1px solid #eee}
  .emails-list.open{display:table-row}
  .emails-list td{white-space:normal;font-size:12px;color:#555;padding:4px 14px;line-height:1.8}
  .email-tag{display:inline-block;background:#f0f0f0;padding:2px 8px;border-radius:4px;margin:2px 4px 2px 0;font-size:11px}
</style>
<script>
function toggleEmails(id){document.getElementById(id).classList.toggle('open')}
</script>
</head><body>
  <h1>Campaign Report</h1>
  <p class="meta">Generated ${date.toISOString().slice(0, 16).replace("T", " ")} &middot; ${results.length} entries</p>
  ${body}
</body></html>`;
}

function groupBy(arr, fn) {
  const groups = {};
  for (const item of arr) {
    const key = fn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

function dedup(rows, paramNames) {
  const map = {};
  for (const r of rows) {
    const key = paramNames.map((p) => r.params[p] || "").join("|");
    if (!map[key]) {
      map[key] = { ...r, _count: 0, _subjects: [] };
    }
    map[key]._count++;
    if (!map[key]._subjects.includes(r.subject)) {
      map[key]._subjects.push(r.subject);
    }
  }
  return Object.values(map);
}

let _rowId = 0;

function renderTable(rows, paramNames) {
  const headers = [...paramNames, "#"];
  return `<table>
    <tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>
    ${rows
      .map((r) => {
        const id = `e${_rowId++}`;
        const cols = paramNames.length + 1;
        const tags = r._subjects.map((s) => `<span class="email-tag">${esc(s)}</span>`).join(" ");
        return `<tr>
      ${paramNames.map((p) => `<td><strong>${esc(r.params[p] || "")}</strong></td>`).join("")}
      <td><span class="badge emails-toggle" onclick="toggleEmails('${id}')">&times;${r._count} (${r._subjects.length})</span></td>
    </tr>
    <tr class="emails-list" id="${id}"><td colspan="${cols}">${tags}</td></tr>`;
      })
      .join("")}
  </table>`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadEnv() {
  try {
    const lines = readFileSync(`${__dirname}/.env`, "utf-8").split("\n");
    return Object.fromEntries(
      lines
        .filter((l) => l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    );
  } catch {
    console.error("Create a .env file (see .env.example)");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
