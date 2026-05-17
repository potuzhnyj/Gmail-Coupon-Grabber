<p align="center">
  <img src="logo.svg" alt="Gmail Coupon Grabber logo" width="128">
</p>

# Gmail Coupon Grabber

Scans Gmail for promo emails, follows redirect chains, extracts URL parameters, and generates an HTML report.  
All settings live in `config.json` — no code changes needed.

## Setup

```bash
npm install
cp .env.example .env
cp config.example.json config.json
```

Edit `.env` with your Gmail credentials:

```
GMAIL_USER=your.email@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
```

App Password: [Google Account](https://myaccount.google.com/security) > 2-Step Verification > App Passwords.

Edit `config.json` with your search filters, product keywords, link domains, and URL params.

## Usage

```bash
npm start          # scan emails and generate report.html
npm run debug      # show raw links from first 3 emails (for testing)
npm run debug:10   # first 10 emails
```

## config.json

### search — which emails to scan

| Field      | Description                           | Example                 |
| ---------- | ------------------------------------- | ----------------------- |
| `from`     | Sender email address                  | `"noreply@example.com"` |
| `mailbox`  | Gmail folder                          | `"INBOX"`               |
| `daysBack` | How many days back to scan            | `7`                     |
| `limit`    | Max matched emails to process (0=all) | `5`                     |

### products — filter emails by subject keywords

Each product is a name + list of keywords. **ALL** keywords must appear in the email subject for it to match. Emails not matching any product are skipped entirely (not downloaded).

```json
"products": {
  "Product A": ["keyword1", "keyword2"],
  "Product B": ["keyword3"]
}
```

### subgroups — split products into subgroups (optional)

An array of keywords. For each matched email, the first keyword found in the subject becomes the subgroup name. In the report, results are grouped as: **Product > Subgroup > Table**.

```json
"subgroups": ["BR", "CZ", "CN"]
```

This creates a collapsible hierarchy:

```
▼ Product A (9)
  ▼ BR (6)
    campaign: SALE50 | campaignMarker: SPRING  ×6 (2)
  ▼ CZ (3)
    campaign: SALE50 | campaignMarker: SPRING  ×3 (1)
```

Identical rows within a subgroup are merged into one with a `×N` count. The count badge (e.g. `×6 (2)`) is clickable — it expands to show the source email subjects. If omitted, no subgrouping — just product > table.

### links — which links to follow and what to extract

| Field             | Description                                                       |
| ----------------- | ----------------------------------------------------------------- |
| `onlyFromDomains` | Which link domains to follow from inside the email (see below)    |
| `extractParams`   | URL parameter names to extract from the final URL after redirects |

**`onlyFromDomains` explained:**

Each email contains many links — logos, social media, unsubscribe, support, etc. You only want the tracking/redirect links that lead to your target page.

Run `npm run debug` first to see all links in your emails. Look for the domain that tracking links use — that's what goes in `onlyFromDomains`. All other links are ignored.

Example: if your email has these links:

```
https://click.tracking.example.com/?id=abc    ← tracking link (follow this)
https://www.facebook.com/yourcompany          ← social (ignore)
https://support.example.com/help              ← support (ignore)
```

Then set: `"onlyFromDomains": ["click.tracking.example.com"]`

**`extractParams` explained:**

After following redirects, the final URL will look something like:

```
https://checkout.example.com/buy?product=xyz&campaign=SALE50&campaignMarker=SPRING
```

Set `"extractParams": ["campaign", "campaignMarker"]` to extract those values into the report table. Any parameter name works — the table columns are generated automatically.

### output — report settings

| Field            | Description                   |
| ---------------- | ----------------------------- |
| `htmlFile`       | Output filename               |
| `groupByProduct` | Group results by product name |

## How it works

1. Connects to Gmail via IMAP
2. **Pass 1:** scans email subjects only (fast) — skips non-matching emails
3. **Pass 2:** downloads body only for matched emails
4. Parses HTML, extracts links from configured domains
5. Follows HTTP redirect chains (up to 10 hops) via `fetch`
6. Extracts configured URL params from final URLs
7. Keeps only links that have at least one matching param
8. Deduplicates identical entries — shows one row with a `×N` count
9. Generates collapsible HTML report grouped by product > subgroup
10. Saves a timestamped copy of the report in `cache/`

## Cache

- **Redirect cache:** `cache/links.json` — subsequent runs skip already-resolved links.
- **Report archives:** `cache/report_YYYY-MM-DD_HH-MM.html` — timestamped copy of each report, so you can compare runs.

To clear the cache:

```bash
rm -rf cache
```

## Quick start guide

1. Run `npm run debug` to see raw links in your emails
2. Find the tracking link domain (the one that redirects) → put it in `onlyFromDomains`
3. Open one tracking link in browser, look at the final URL → put the param names in `extractParams`
4. Set your product keywords in `products`
5. Run `npm start`

## Project structure

```
├── logo.svg             ← project logo
├── config.json          ← config template
├── .env                 ← credentials template
├── grab.js              ← main script
├── debug.js             ← link debugging tool
├── cache/               ← redirect cache + report archives
├── report.html          ← generated report
└── package.json
```

## Dependencies

- Node.js 18+
- **imapflow** — IMAP client
- **cheerio** — HTML parser
- Built-in `fetch` for HTTP redirects

## License

MIT
