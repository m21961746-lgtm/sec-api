#!/usr/bin/env node
/* ===================================================
   QA TEST SCRIPT — standalone, not wired into the server.
   Hits the LIVE public API for a list of tickers, one at a
   time, and reports status / latency / payload completeness.

   Run:  node qa-test.js

   Requires Node 18+ (uses global fetch).
   =================================================== */

const BASE_URL = "https://zelothorn.com/api/v1/company/";

/* ---------- Throttling ----------
   The live API allows 20 requests per minute per IP and returns
   429 past that. We wait THROTTLE_MS *after* each request completes,
   so real spacing is (request duration + 3.5s) — always >= 3.5s.

   Worst case (instant responses): 60000 / 3500 = 17.1 requests per
   60s window, so at most 18 can land in any fixed window. That
   leaves headroom under the limit of 20.

   If any 429 shows up in the results, the throttle was too loose
   and the report calls it out explicitly.                        */
const THROTTLE_MS = 3500;

/* A cold cache means the server may call OpenAI (25s timeout there),
   so allow generous headroom before we give up on a request. */
const REQUEST_TIMEOUT_MS = 40000;

/* Anything over this is reported as slow. */
const SLOW_MS = 5000;

/* ---------- Tickers ----------
   ~105 valid names across sectors, plus deliberately bad ones
   at the end to exercise the error path. BRK.B is included on
   purpose: the dot is the classic thing to break URL handling. */
const TICKERS = [
  // Mega-cap tech
  "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "NVDA", "META", "TSLA", "AVGO", "ORCL",
  // Semiconductors & hardware
  "AMD", "INTC", "QCOM", "TXN", "MU", "AMAT", "LRCX", "ADI", "NXPI", "ON",
  // Software & internet
  "CRM", "ADBE", "NOW", "INTU", "PANW", "SNOW", "NFLX", "UBER", "ABNB", "SHOP",
  // Financials
  "BRK.B", "JPM", "BAC", "WFC", "GS", "MS", "C", "SCHW", "BLK", "AXP",
  "SPGI", "CB", "PGR", "MMC", "USB",
  // Payments
  "V", "MA", "PYPL", "FI",
  // Healthcare & pharma
  "UNH", "JNJ", "LLY", "ABBV", "MRK", "PFE", "TMO", "ABT", "DHR", "AMGN",
  "GILD", "VRTX", "REGN", "BMY", "CVS", "CI", "ELV", "MDT", "SYK", "BSX",
  // Consumer staples
  "PG", "KO", "PEP", "WMT", "COST", "MDLZ", "CL", "KMB", "GIS", "MO",
  "PM", "STZ", "KHC",
  // Consumer discretionary & retail
  "HD", "LOW", "MCD", "SBUX", "NKE", "TJX", "TGT", "BKNG", "DIS", "CMG",
  // Energy
  "XOM", "CVX", "COP", "SLB", "EOG", "PSX", "MPC", "OXY",
  // Industrials & transport
  "CAT", "DE", "BA", "HON", "GE", "LMT", "RTX", "UNP", "UPS", "FDX",
  // Utilities, materials, real estate, telecom
  "NEE", "DUK", "SO", "LIN", "SHW", "PLD", "AMT", "T", "VZ", "CMCSA",
];

/* Expected to fail — the report separates these from real problems.
   ZZZZ / QQQQ / XXXX are nonsense; WISH and FTCH are delisted. */
const EXPECTED_INVALID = ["WISH", "ZZZZ", "QQQQ", "XXXX", "FTCH"];

const ALL_TICKERS = [...TICKERS, ...EXPECTED_INVALID];

const REQUIRED_FIELDS = ["company", "summary", "earnings", "filings", "links"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExpectedInvalid(ticker) {
  return EXPECTED_INVALID.includes(ticker);
}

/* One request. Never throws — every failure mode comes back as a
   record so a single bad ticker can't end the run. */
async function testTicker(ticker) {
  const record = {
    ticker,
    expectedInvalid: isExpectedInvalid(ticker),
    status: null,
    ms: null,
    jsonParsed: false,
    missingFields: [],
    summaryStatus: null,
    earningsStatus: null,
    filingsStatus: null,
    error: null,
  };

  const started = Date.now();

  try {
    const res = await fetch(BASE_URL + encodeURIComponent(ticker), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    record.status = res.status;

    let body;
    try {
      body = await res.json();
      record.jsonParsed = true;
    } catch (err) {
      record.error = "JSON parse failed: " + err.message;
      record.ms = Date.now() - started;
      return record;
    }

    /* Non-200s are allowed to carry just an error message — only
       check the full contract on a success. */
    if (res.status === 200) {
      record.missingFields = REQUIRED_FIELDS.filter(
        (f) => body[f] === undefined || body[f] === null
      );
      record.summaryStatus = body.summary ? body.summary.status : null;
      record.earningsStatus = body.earnings ? body.earnings.status : null;
      record.filingsStatus = body.filings ? body.filings.status : null;
    } else if (body && body.error) {
      record.error = String(body.error);
    }
  } catch (err) {
    /* Network failure, DNS, or our own client-side timeout. */
    record.error = err.name === "TimeoutError"
      ? `Client timeout after ${REQUEST_TIMEOUT_MS}ms`
      : `${err.name}: ${err.message}`;
  }

  record.ms = Date.now() - started;
  return record;
}

/* A run counts as fully successful when it returned 200, parsed,
   carried every top-level field, and no section reported itself
   unavailable. */
function isFullSuccess(r) {
  return (
    r.status === 200 &&
    r.jsonParsed &&
    r.missingFields.length === 0 &&
    r.summaryStatus === "ok" &&
    r.earningsStatus !== "unavailable" &&
    r.filingsStatus !== "unavailable"
  );
}

function describeIncomplete(r) {
  const notes = [];
  if (r.missingFields.length) notes.push("missing: " + r.missingFields.join(", "));
  if (r.summaryStatus !== "ok") notes.push("summary=" + r.summaryStatus);
  if (r.earningsStatus === "unavailable") notes.push("earnings=unavailable");
  if (r.filingsStatus === "unavailable") notes.push("filings=unavailable");
  return notes.join("; ");
}

function line(label) {
  console.log("\n" + label);
  console.log("-".repeat(label.length));
}

function report(records) {
  const total = records.length;
  const succeeded = records.filter(isFullSuccess);
  const parseFailures = records.filter((r) => r.status !== null && !r.jsonParsed);
  const networkFailures = records.filter((r) => r.status === null);
  const rateLimited = records.filter((r) => r.status === 429);

  const ok200 = records.filter((r) => r.status === 200 && r.jsonParsed);
  const incomplete = ok200.filter((r) => !isFullSuccess(r));

  /* Non-200 responses, split by whether we expected the failure. */
  const errored = records.filter(
    (r) => r.status !== null && r.status !== 200
  );
  const unexpectedErrors = errored.filter((r) => !r.expectedInvalid);
  const expectedErrors = errored.filter((r) => r.expectedInvalid);

  /* Invalid tickers that came back 200 — the error path didn't fire. */
  const shouldHaveFailed = records.filter(
    (r) => r.expectedInvalid && r.status === 200
  );

  const timed = records.filter((r) => typeof r.ms === "number" && r.status !== null);
  const times = timed.map((r) => r.ms);
  const avg = times.length
    ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    : 0;
  const min = times.length ? Math.min(...times) : 0;
  const max = times.length ? Math.max(...times) : 0;

  const slow = records
    .filter((r) => typeof r.ms === "number" && r.ms > SLOW_MS && r.status !== null)
    .sort((a, b) => b.ms - a.ms);

  console.log("\n\n" + "=".repeat(60));
  console.log("QA SUMMARY REPORT");
  console.log("=".repeat(60));

  console.log(`\nTotal tested:        ${total}`);
  console.log(`Fully succeeded:     ${succeeded.length}`);
  console.log(`Returned an error:   ${errored.length} (${expectedErrors.length} expected)`);
  console.log(`200 but incomplete:  ${incomplete.length}`);
  console.log(`JSON parse failures: ${parseFailures.length}`);
  console.log(`Network failures:    ${networkFailures.length}`);
  console.log(`Slow (>${SLOW_MS}ms):       ${slow.length}`);

  line("Response times (ms)");
  console.log(`avg ${avg}   min ${min}   max ${max}`);

  if (rateLimited.length) {
    line("!! RATE LIMITED — THROTTLE TOO LOOSE");
    console.log(
      `${rateLimited.length} request(s) got 429. Results below are unreliable;\n` +
      `raise THROTTLE_MS and re-run.`
    );
    console.log(rateLimited.map((r) => r.ticker).join(", "));
  }

  if (unexpectedErrors.length) {
    line("Unexpected errors");
    for (const r of unexpectedErrors) {
      console.log(`  ${r.ticker.padEnd(6)} ${r.status}  ${r.error || ""}`);
    }
  }

  if (networkFailures.length) {
    line("Network / timeout failures");
    for (const r of networkFailures) {
      console.log(`  ${r.ticker.padEnd(6)} ${r.error}`);
    }
  }

  if (parseFailures.length) {
    line("JSON parse failures");
    for (const r of parseFailures) {
      console.log(`  ${r.ticker.padEnd(6)} ${r.status}  ${r.error}`);
    }
  }

  if (incomplete.length) {
    line("200 OK but incomplete data");
    for (const r of incomplete) {
      console.log(`  ${r.ticker.padEnd(6)} ${describeIncomplete(r)}`);
    }
  }

  if (slow.length) {
    line(`Slow responses (>${SLOW_MS}ms)`);
    for (const r of slow) {
      console.log(`  ${r.ticker.padEnd(6)} ${r.ms}ms  (status ${r.status})`);
    }
  }

  if (shouldHaveFailed.length) {
    line("Invalid tickers that returned 200 (error path did not fire)");
    console.log("  " + shouldHaveFailed.map((r) => r.ticker).join(", "));
  }

  if (expectedErrors.length) {
    line("Expected invalid tickers (rejected correctly)");
    for (const r of expectedErrors) {
      console.log(`  ${r.ticker.padEnd(6)} ${r.status}  ${r.error || ""}`);
    }
  }

  console.log("");
}

async function main() {
  if (typeof fetch !== "function") {
    console.error("This script needs Node 18+ (global fetch is missing).");
    process.exit(1);
  }

  const total = ALL_TICKERS.length;
  const estMin = ((total * THROTTLE_MS) / 60000).toFixed(1);

  console.log(`Testing ${total} tickers against ${BASE_URL}`);
  console.log(
    `Throttle: 1 request per ${THROTTLE_MS}ms (limit is 20/min per IP).`
  );
  console.log(`Estimated run time: ~${estMin} min, plus response time.\n`);

  const records = [];

  for (let i = 0; i < total; i++) {
    const ticker = ALL_TICKERS[i];
    const r = await testTicker(ticker);
    records.push(r);

    const pos = `[${i + 1}/${total}]`;
    let outcome;
    if (r.status === null) {
      outcome = "FAILED — " + r.error;
    } else if (r.status === 200) {
      outcome = isFullSuccess(r) ? "200 OK" : "200 INCOMPLETE";
    } else {
      outcome = `${r.status}${r.expectedInvalid ? " (expected)" : ""}`;
    }

    console.log(`${pos} ${ticker.padEnd(6)} — ${outcome} — ${r.ms}ms`);

    if (i < total - 1) await sleep(THROTTLE_MS);
  }

  report(records);
}

main().catch((err) => {
  console.error("\nQA run crashed:", err);
  process.exit(1);
});
