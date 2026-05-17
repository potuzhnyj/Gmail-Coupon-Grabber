const { ImapFlow } = require("imapflow");
const { load } = require("cheerio");
const { readFileSync } = require("fs");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const env = loadEnv();
const cfg = JSON.parse(readFileSync(`${__dirname}/config.json`, "utf-8"));

async function main() {
  const s = cfg.search || {};
  const limit = Number(process.argv[2]) || 3;

  const client = new ImapFlow({
    host: cfg.imap?.host || "imap.gmail.com",
    port: cfg.imap?.port || 993,
    secure: true,
    auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock(s.mailbox || "INBOX");
  const since = s.daysBack
    ? new Date(Date.now() - s.daysBack * 86400000)
    : undefined;

  try {
    const search = {};
    if (s.from) search.from = s.from;
    if (s.subject) search.subject = s.subject;
    if (since) search.since = since;

    console.log(`Debug — first ${limit} emails`);
    console.log("Search:", JSON.stringify(search));

    let count = 0;
    for await (const msg of client.fetch(search, { source: true, envelope: true })) {
      if (++count > limit) break;

      console.log(`\n=== ${msg.envelope.subject} ===\n`);

      const $ = load(msg.source.toString());
      const links = [
        ...new Set(
          $("a[href^=http]")
            .map((_, el) => $(el).attr("href"))
            .get()
        ),
      ];

      for (const link of links) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        try {
          const res = await fetch(link, { redirect: "manual", signal: ctrl.signal });
          clearTimeout(timer);
          const location = res.headers.get("location");
          console.log(`  LINK:     ${link.slice(0, 120)}`);
          if (location) console.log(`  REDIRECT: ${location.slice(0, 120)}`);
        } catch {
          clearTimeout(timer);
          console.log(`  LINK:     ${link.slice(0, 120)}`);
          console.log(`  FAILED`);
        }
        console.log();
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }
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
