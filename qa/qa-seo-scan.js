#!/usr/bin/env node
/* ===================================================
   SEO TICKER SCAN — standalone, not wired into the server.
   Variant of qa-test.js that tests every ticker in the
   SEO_TICKERS list (the pre-warm + sitemap set) against the
   LIVE API, then explains each 404 using SEC's own file.

   Run:  node qa-seo-scan.js

   Requires Node 18+.
   =================================================== */

const fs = require("fs");
const path = require("path");

const BASE_URL = "https://zelothorn.com/api/v1/company/";
const SEC_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_HEADERS = { "User-Agent": "Zelothorn (https://zelothorn.com)" };

/* Same throttle as qa-test.js: the live API allows 20 req/min per IP.
   We sleep 3.5s AFTER each request, so spacing is always >= 3.5s and
   at most 18 requests can land in any fixed 60s window. */
const THROTTLE_MS = 3500;
const REQUEST_TIMEOUT_MS = 40000;

/* Read SEO_TICKERS straight out of index.js so this can never drift
   from the real list. Parse only — index.js is not executed. */
function loadSeoTickers() {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const block = src.match(/const SEO_TICKERS = \[([\s\S]*?)\];/);
  if (!block) throw new Error("Could not find SEO_TICKERS in index.js");
  return block[1].match(/"[^"]+"/g).map((s) => s.replace(/"/g, ""));
}

/* Rebuild the ticker map exactly as loadTickerMap() does in index.js,
   so a MISS here means a MISS there. */
async function loadSecMap() {
  const res = await fetch(SEC_URL, {
    headers: SEC_HEADERS,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`SEC fetch failed (${res.status})`);
  const lastModified = res.headers.get("last-modified");
  const data = await res.json();

  const map = {};
  for (const key of Object.keys(data)) {
    const row = data[key];
    map[String(row.ticker).toUpperCase()] = {
      cik: String(row.cik_str).padStart(10, "0"),
      title: row.title,
    };
  }
  return { map, lastModified, rowCount: Object.keys(data).length };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function testTicker(ticker) {
  const rec = { ticker, status: null, ms: null, error: null };
  const started = Date.now();
  try {
    const res = await fetch(BASE_URL + encodeURIComponent(ticker), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    rec.status = res.status;
    try {
      const body = await res.json();
      if (res.status !== 200 && body && body.error) rec.error = String(body.error);
    } catch (err) {
      rec.error = "JSON parse failed: " + err.message;
    }
  } catch (err) {
    rec.error =
      err.name === "TimeoutError"
        ? `Client timeout after ${REQUEST_TIMEOUT_MS}ms`
        : `${err.name}: ${err.message}`;
  }
  rec.ms = Date.now() - started;
  return rec;
}

/* Explain a 404 using SEC's file. Deliberately conservative: it only
   claims what the data proves. Distinguishing "renamed" from
   "delisted" needs a human, so both land in ABSENT. */
function categorize(ticker, map) {
  const hyphenated = ticker.replace(/\./g, "-");
  if (ticker.includes(".") && map[hyphenated]) {
    return {
      code: "DOTTED_FORMAT",
      detail: `SEC has "${hyphenated}" (${map[hyphenated].title})`,
    };
  }
  if (map[ticker]) {
    return {
      code: "IN_SEC_BUT_404",
      detail: `SEC HAS this ticker (${map[ticker].title}) — server map may be stale`,
    };
  }
  return { code: "ABSENT_FROM_SEC", detail: "no row in SEC company_tickers.json" };
}

function heading(label) {
  console.log("\n" + label);
  console.log("-".repeat(label.length));
}

async function main() {
  if (typeof fetch !== "function") {
    console.error("Needs Node 18+ (global fetch missing).");
    process.exit(1);
  }

  const tickers = loadSeoTickers();
  console.log(`Loaded ${tickers.length} tickers from SEO_TICKERS in index.js`);

  console.log("Fetching SEC company_tickers.json for categorization...");
  const { map, lastModified, rowCount } = await loadSecMap();
  console.log(`SEC file: ${rowCount} rows, Last-Modified: ${lastModified}`);

  const estMin = ((tickers.length * THROTTLE_MS) / 60000).toFixed(1);
  console.log(
    `\nThrottle: 1 request per ${THROTTLE_MS}ms (limit 20/min per IP).`
  );
  console.log(`Estimated run time: ~${estMin} min plus response time.\n`);

  const records = [];
  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    const r = await testTicker(t);
    records.push(r);

    const outcome =
      r.status === null ? "FAILED — " + r.error : String(r.status);
    console.log(
      `[${i + 1}/${tickers.length}] ${t.padEnd(7)} — ${outcome} — ${r.ms}ms`
    );

    if (i < tickers.length - 1) await sleep(THROTTLE_MS);
  }

  /* ---------- Report ---------- */
  const ok = records.filter((r) => r.status === 200);
  const notFound = records.filter((r) => r.status === 404);
  const rateLimited = records.filter((r) => r.status === 429);
  const otherErr = records.filter(
    (r) => r.status !== null && r.status !== 200 && r.status !== 404
  );
  const netFail = records.filter((r) => r.status === null);

  const times = records.filter((r) => r.status !== null).map((r) => r.ms);
  const avg = times.length
    ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    : 0;

  console.log("\n\n" + "=".repeat(64));
  console.log("SEO TICKER SCAN REPORT");
  console.log("=".repeat(64));
  console.log(`\nTotal in SEO_TICKERS: ${records.length}`);
  console.log(`200 OK:               ${ok.length}`);
  console.log(`404 (dead):           ${notFound.length}`);
  console.log(`Other HTTP errors:    ${otherErr.length}`);
  console.log(`Network failures:     ${netFail.length}`);
  console.log(`Rate limited (429):   ${rateLimited.length}`);
  console.log(
    `\nResponse times (ms): avg ${avg}  min ${times.length ? Math.min(...times) : 0}  max ${times.length ? Math.max(...times) : 0}`
  );

  if (rateLimited.length) {
    heading("!! RATE LIMITED — results unreliable, raise THROTTLE_MS");
    console.log("  " + rateLimited.map((r) => r.ticker).join(", "));
  }

  if (notFound.length) {
    const buckets = { DOTTED_FORMAT: [], IN_SEC_BUT_404: [], ABSENT_FROM_SEC: [] };
    for (const r of notFound) {
      const c = categorize(r.ticker, map);
      buckets[c.code].push({ ticker: r.ticker, detail: c.detail });
    }

    heading(`DEAD TICKERS IN SITEMAP / PREWARM (${notFound.length})`);

    for (const [code, label] of [
      ["DOTTED_FORMAT", "Dotted format — fixable by normalizing '.' to '-'"],
      ["IN_SEC_BUT_404", "Present in SEC file but still 404 — investigate"],
      ["ABSENT_FROM_SEC", "Absent from SEC file — renamed or delisted"],
    ]) {
      const rows = buckets[code];
      if (!rows.length) continue;
      console.log(`\n  ${label}  (${rows.length})`);
      for (const row of rows) {
        console.log(`    ${row.ticker.padEnd(7)} ${row.detail}`);
      }
    }

    heading("Bare list (for editing SEO_TICKERS)");
    console.log("  " + notFound.map((r) => r.ticker).join(", "));
  }

  if (otherErr.length) {
    heading("Other HTTP errors");
    for (const r of otherErr) {
      console.log(`  ${r.ticker.padEnd(7)} ${r.status}  ${r.error || ""}`);
    }
  }

  if (netFail.length) {
    heading("Network / timeout failures");
    for (const r of netFail) {
      console.log(`  ${r.ticker.padEnd(7)} ${r.error}`);
    }
  }

  console.log("");
}

main().catch((err) => {
  console.error("\nScan crashed:", err);
  process.exit(1);
});
