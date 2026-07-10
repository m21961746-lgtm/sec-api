const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

/* =========================
   SERVE THE FRONTEND
   ========================= */
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* =========================
   SEC REQUEST SETTINGS
   ========================= */
const SEC_HEADERS = {
  "User-Agent": "Zelothorn (https://zelothorn.com)"
};

/* =========================
   AI MODEL SETTINGS (Phase 1)
   ========================= */
const OPENAI_MODEL = "gpt-5.4-mini";

/* =========================
   FINNHUB SETTINGS (Phase 3)
   ========================= */
const FINNHUB_BASE = "https://finnhub.io/api/v1";

/* ===================================================
   BRAND-NAME OVERRIDES (polish)
   A few well-known companies keep an older *legal* name
   on file with the SEC while operating under a newer
   brand. To add one later: "TICKER": "Brand Name".
   =================================================== */
const NAME_OVERRIDES = {
  "GE": "GE Aerospace"
};

/* ===================================================
   DYNAMIC TICKER -> CIK LOOKUP
   =================================================== */
let tickerMap = null;
let tickerMapLoadedAt = 0;
const ONE_DAY = 24 * 60 * 60 * 1000;

async function loadTickerMap() {
  if (tickerMap && Date.now() - tickerMapLoadedAt < ONE_DAY) {
    return tickerMap;
  }

  const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: SEC_HEADERS
  });

  if (!res.ok) {
    throw new Error(`SEC ticker list request failed (status ${res.status})`);
  }

  const data = await res.json();

  const map = {};
  for (const key in data) {
    const row = data[key];
    const ticker = String(row.ticker).toUpperCase();
    const cik = String(row.cik_str).padStart(10, "0");
    map[ticker] = { cik, title: row.title };
  }

  tickerMap = map;
  tickerMapLoadedAt = Date.now();
  return tickerMap;
}

/* ===================================================
   FETCH SEC FILINGS (Phase 2)
   =================================================== */
async function getFilings(cik) {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const res = await fetch(url, { headers: SEC_HEADERS });

  if (!res.ok) {
    throw new Error(`SEC filings request failed (status ${res.status})`);
  }

  const data = await res.json();
  const recent = data.filings.recent;
  const cikInt = parseInt(cik, 10);

  const all = [];
  const n = recent.form.length;
  for (let i = 0; i < n; i++) {
    const accession = recent.accessionNumber[i];
    const primaryDoc = recent.primaryDocument ? recent.primaryDocument[i] : "";
    const accNoDashes = accession ? accession.replace(/-/g, "") : "";
    const link = primaryDoc
      ? `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDashes}/${primaryDoc}`
      : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40`;

    all.push({
      form: recent.form[i],
      filingDate: recent.filingDate[i],
      accessionNumber: accession,
      url: link
    });
  }

  // The 10 most recent filings overall
  const recentList = all.slice(0, 10);

  // The single most recent of each "important" type
  const importantTypes = ["10-K", "10-Q", "8-K"];
  const keyFilings = [];
  for (const t of importantTypes) {
    const found = all.find(f => f.form === t);
    if (found) keyFilings.push(found);
  }

  return { recent: recentList, key: keyFilings, name: data.name || null };
}

/* ===================================================
   NAME TIDY (polish)
   =================================================== */
function tidyCompanyName(name) {
  if (!name) return name;
  if (/[a-z]/.test(name)) return name; // already mixed case — trust it
  return name
    .toLowerCase()
    .split(/\s+/)
    .map(w => {
      const core = w.replace(/[^a-z]/gi, "");
      if (core.length > 0 && core.length <= 3) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/* ===================================================
   PHASE 3: EARNINGS (beat / miss)
   =================================================== */
async function getEarnings(ticker) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    throw new Error("FINNHUB_API_KEY is not set on the server");
  }

  const url = `${FINNHUB_BASE}/stock/earnings?symbol=${encodeURIComponent(ticker)}&token=${apiKey}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Finnhub request failed (status ${res.status})`);
  }

  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    return null; // no estimates for this company
  }

  const valid = data.filter(
    q => q.actual !== null && q.actual !== undefined &&
         q.estimate !== null && q.estimate !== undefined
  );
  if (valid.length === 0) return null;

  valid.sort((a, b) => (a.period < b.period ? 1 : -1));

  const quarters = valid.slice(0, 4).map(q => {
    let result = "met";
    if (q.actual > q.estimate) result = "beat";
    else if (q.actual < q.estimate) result = "miss";
    return {
      period: q.period,
      actualEPS: q.actual,
      estimateEPS: q.estimate,
      surprise: q.surprise,
      surprisePercent: q.surprisePercent,
      result: result
    };
  });

  return { latest: quarters[0], history: quarters };
}

/* ===================================================
   PHASE 1: AI SUMMARY
   =================================================== */
async function generateSummary(company, ticker, filings) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set on the server");
  }

  const filingLines = filings
    .map(f => `- ${f.form} filed ${f.filingDate}`)
    .join("\n");

  const userPrompt =
    `Company: ${company} (ticker ${ticker}).\n` +
    `Recent SEC filings:\n${filingLines}\n\n` +
    `Write a clear, plain-language summary for a regular person who may not ` +
    `know much about finance. Explain what this company is, what it actually ` +
    `does to make money, and give a high-level overview of its operations. ` +
    `Use 2-3 short paragraphs. Do NOT give any buy, sell, or hold ` +
    `recommendation, and do not predict the stock price.`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are Zelothorn, a financial explainer. You describe public " +
            "companies in plain, friendly language. You never give investment " +
            "advice and never tell anyone what to buy or sell."
        },
        { role: "user", content: userPrompt }
      ],
      max_completion_tokens: 1200
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI request failed (status ${response.status}): ${errText}`);
  }

  const data = await response.json();
  const summary =
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content
      ? data.choices[0].message.content.trim()
      : "";

  if (!summary) {
    throw new Error("OpenAI returned an empty summary");
  }

  return summary;
}

/* ===================================================
   NAME SEARCH (plan B)
   If what the user typed isn't a ticker, try matching
   it against company NAMES from SEC's list instead.
   e.g. "DISNEY" -> finds "Walt Disney Co" -> DIS
   =================================================== */
function findByName(map, query) {
  const q = query.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return null;

  let startsWith = null;
  let contains = null;

  for (const ticker in map) {
    const title = (map[ticker].title || "").toLowerCase();
    if (!title) continue;

    if (title === q) return { ticker, entry: map[ticker] };
    if (!startsWith && title.startsWith(q)) startsWith = { ticker, entry: map[ticker] };
    if (!contains && title.includes(q))     contains   = { ticker, entry: map[ticker] };
  }

  return startsWith || contains;
}

/* ===================================================
   REPORT CACHE
   Once a company's report is built, keep it for 6 hours.
   Repeat lookups are served instantly from memory.
   =================================================== */
const reportCache = {};
const REPORT_TTL = 6 * 60 * 60 * 1000; // 6 hours

/* ===================================================
   BUILD A FULL REPORT for one ticker (used by both the
   /resolve endpoint and the pre-warmer)
   =================================================== */
async function buildReport(T, entry) {
  const filingsData = await getFilings(entry.cik);

  const companyName = NAME_OVERRIDES[T] || tidyCompanyName(filingsData.name || entry.title);

  let aiSummary = null;
  let aiError = null;
  try {
    aiSummary = await generateSummary(companyName, T, filingsData.recent);
  } catch (e) {
    aiError = e.message;
  }

  let earnings = null;
  let earningsError = null;
  try {
    earnings = await getEarnings(T);
    if (!earnings) {
      earningsError = "No analyst earnings estimates are available for this company yet.";
    }
  } catch (e) {
    earningsError = e.message;
  }

  const payload = {
    ticker: T,
    company: companyName,
    cik: entry.cik,
    ai_summary: aiSummary,
    ai_error: aiError,
    earnings: earnings,
    earnings_error: earningsError,
    keyFilings: filingsData.key,
    filings: filingsData.recent,
    sec_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${entry.cik}&type=&dateb=&owner=include&count=40`
  };

  // Only cache complete, healthy reports
  if (aiSummary) {
    reportCache[T] = { at: Date.now(), data: payload };
  }

  return payload;
}

/* =========================
   MAIN ENDPOINT:  /resolve?ticker=XXXX
   ========================= */
app.get("/resolve", async (req, res) => {
  const ticker = req.query.ticker;

  if (!ticker) {
    return res.status(400).json({ error: "Missing ticker" });
  }

  let T = ticker.toUpperCase();

  try {
    const map = await loadTickerMap();
    let entry = map[T];

    // Plan B: not a ticker? Try matching a company name ("DISNEY" -> DIS)
    if (!entry) {
      const found = findByName(map, T);
      if (found) {
        T = found.ticker;
        entry = found.entry;
      }
    }

    if (!entry) {
      return res.status(404).json({
        error: `We couldn't find a company matching '${ticker}'. Try the stock ticker or the company's official name.`
      });
    }

    // Serve from cache if we built this report recently
    const cached = reportCache[T];
    if (cached && Date.now() - cached.at < REPORT_TTL) {
      return res.json(cached.data);
    }

    const payload = await buildReport(T, entry);
    res.json(payload);
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch data",
      details: err.message
    });
  }
});


/* ===================================================
   SEO COMPANY PAGES  (Stage 1)
   =================================================== */

// simple in-memory cache: TICKER -> finished HTML string
const seoPageCache = {};

// escape user/text content so it can't break the HTML
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// turn a plain-text summary into <p> tags
function paragraphsToHtml(text) {
  if (!text) return "";
  return text
    .split(/\n\s*\n/)
    .map(p => `<p>${escapeHtml(p.trim())}</p>`)
    .join("\n");
}

app.get("/company/:ticker", async (req, res) => {
  const T = String(req.params.ticker || "").toUpperCase();

  if (seoPageCache[T]) {
    return res.send(seoPageCache[T]);
  }

  try {
    const map = await loadTickerMap();
    const entry = map[T];

    if (!entry) {
      return res.status(404).send(
        `<!DOCTYPE html><html><head><meta charset="utf-8">` +
        `<title>Company not found | Zelothorn</title></head><body>` +
        `<h1>We couldn't find that company</h1>` +
        `<p>No U.S. public company was found for the symbol "${escapeHtml(T)}".</p>` +
        `<p><a href="/">Back to Zelothorn</a></p></body></html>`
      );
    }

    const filingsData = await getFilings(entry.cik);
    const companyName = NAME_OVERRIDES[T] || tidyCompanyName(filingsData.name || entry.title);

    let aiSummary = null;
    try { aiSummary = await generateSummary(companyName, T, filingsData.recent); }
    catch (e) { aiSummary = null; }

    let earnings = null;
    try { earnings = await getEarnings(T); }
    catch (e) { earnings = null; }

    let earningsHtml = "";
    if (earnings && earnings.latest) {
      const L = earnings.latest;
      const verb = L.result === "beat" ? "beat" : (L.result === "miss" ? "missed" : "met");
      earningsHtml =
        `<h2>How did ${escapeHtml(companyName)}'s latest earnings compare?</h2>` +
        `<p>In the most recent quarter (${escapeHtml(L.period)}), ${escapeHtml(companyName)} ` +
        `reported earnings of $${escapeHtml(L.actualEPS)} per share. Analysts expected ` +
        `$${escapeHtml(L.estimateEPS)} per share, so the company <strong>${verb}</strong> ` +
        `expectations.</p>`;
    }

    const summaryHtml = aiSummary
      ? paragraphsToHtml(aiSummary)
      : `<p>A plain-language overview for ${escapeHtml(companyName)} is being prepared. ` +
        `You can look up this company directly on <a href="/">Zelothorn</a>.</p>`;

    const title = `What does ${companyName} do? | ${T} explained | Zelothorn`;
    const metaDesc = `A plain-English explanation of what ${companyName} (${T}) does, ` +
      `how it makes money, and how its latest earnings compared to expectations.`;

    const html =
`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(metaDesc)}">
<link rel="canonical" href="https://zelothorn.com/company/${escapeHtml(T)}">
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
       max-width:760px;margin:0 auto;padding:32px 20px;line-height:1.6;color:#1a1a1a;}
  h1{font-size:1.9rem;margin-bottom:.2em;}
  h2{font-size:1.3rem;margin-top:1.6em;}
  .sub{color:#666;margin-top:0;}
  .cta{display:inline-block;margin:24px 0;padding:12px 20px;background:#111;color:#fff;
       text-decoration:none;border-radius:8px;}
  .disc{color:#888;font-size:.85rem;margin-top:40px;border-top:1px solid #eee;padding-top:16px;}
  a{color:#0b5;}
</style>
</head>
<body>
  <h1>What does ${escapeHtml(companyName)} do?</h1>
  <p class="sub">${escapeHtml(T)} &middot; Plain-English company overview</p>
  ${summaryHtml}
  ${earningsHtml}
  <a class="cta" href="/">Look up any company on Zelothorn &rarr;</a>
  <p class="disc">Zelothorn provides AI-generated explanations and official public data for
  educational purposes only. It is not financial advice and does not recommend buying or
  selling any security.</p>
</body>
</html>`;

    seoPageCache[T] = html;
    res.send(html);

  } catch (err) {
    res.status(500).send(
      `<!DOCTYPE html><html><head><meta charset="utf-8">` +
      `<title>Zelothorn</title></head><body>` +
      `<h1>Something went wrong</h1>` +
      `<p>Please try again in a moment, or look up this company on <a href="/">Zelothorn</a>.</p>` +
      `</body></html>`
    );
  }
});


/* ===================================================
   SEO SITEMAP + PRE-WARM LIST
   These 200 companies get indexable /company/ pages
   AND are kept pre-built in the report cache so the
   main tool is instant for them, always.
   =================================================== */
const SEO_TICKERS = [
  "AAPL","MSFT","GOOGL","AMZN","NVDA","META","TSLA","BRK.B","JPM","V",
  "UNH","XOM","JNJ","WMT","MA","PG","HD","CVX","LLY","ABBV",
  "AVGO","PEP","KO","COST","MRK","ADBE","CSCO","MCD","CRM","ACN",
  "TMO","ABT","NKE","DHR","LIN","TXN","NEE","ORCL","PM","WFC",
  "DIS","INTC","AMD","QCOM","IBM","CAT","GE","BA","HON","AMGN",
  "UPS","LOW","INTU","SBUX","GS","BLK","ELV","DE","AXP","SPGI",
  "PLD","BKNG","MDT","GILD","ADP","TJX","VRTX","C","LMT","SCHW",
  "MDLZ","CVS","MO","AMT","CI","SO","ZTS","DUK","BDX","CB",
  "MMC","REGN","PGR","AON","ITW","EOG","SLB","APD","BSX","NOC",
  "PANW","MU","LRCX","KLAC","SNPS","CDNS","MELI","ABNB","PYPL","SQ",
  "SHOP","UBER","LYFT","SNAP","PINS","SPOT","NET","DDOG","SNOW","CRWD",
  "ZM","DOCU","ROKU","TWLO","OKTA","TEAM","ZS","MDB","PLTR","COIN",
  "HOOD","SOFI","RBLX","DASH","RIVN","LCID","F","GM","NIO","XPEV",
  "T","VZ","TMUS","CMCSA","NFLX","WBD","PARA","FOX","EA","TTWO",
  "MAR","HLT","LULU","ROST","DG","DLTR","ORLY","AZO","YUM","CMG",
  "KHC","GIS","K","HSY","STZ","KDP","MNST","CL","KMB","EL",
  "WBA","MCK","CNC","HUM","BIIB","ILMN","MRNA","DXCM","IDXX","ISRG",
  "NOW","FTNT","ADSK","WDAY","ANET","KEYS","GLW","HPQ","DELL","WDC",
  "STX","NXPI","ADI","MCHP","ON","MPWR","FSLR","ENPH","PLUG","RUN",
  "GME","AMC","BBBY","WISH","CLOV","TLRY","CGC","DKNG","PENN","WYNN"
];

app.get("/sitemap.xml", async (req, res) => {
  const base = "https://zelothorn.com";
  const urls = SEO_TICKERS.map(t =>
    `  <url><loc>${base}/company/${encodeURIComponent(t)}</loc></url>`
  ).join("\n");

  const xml =
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc></url>
${urls}
</urlset>`;

  res.header("Content-Type", "application/xml");
  res.send(xml);
});

/* ===================================================
   PRE-WARMER
   Builds reports for every company in SEO_TICKERS so
   visitors get them instantly — even the first visitor.
   Runs on server start, then repeats every 6 hours.
   Spaced 3 seconds apart to be gentle on SEC/Finnhub.
   Skips any report that is still fresh in the cache.
   =================================================== */
const PREWARM_SPACING = 3000; // 3 seconds between builds
let prewarmRunning = false;

async function prewarmAll() {
  if (prewarmRunning) return; // never run two sweeps at once
  prewarmRunning = true;
  console.log(`[prewarm] starting sweep of ${SEO_TICKERS.length} companies`);

  try {
    const map = await loadTickerMap();

    for (const rawTicker of SEO_TICKERS) {
      const T = rawTicker.toUpperCase();
      const entry = map[T];
      if (!entry) continue; // ticker not in SEC list (e.g. delisted) — skip

      // still fresh? skip it
      const cached = reportCache[T];
      if (cached && Date.now() - cached.at < REPORT_TTL) continue;

      try {
        await buildReport(T, entry);
        console.log(`[prewarm] built ${T}`);
      } catch (e) {
        console.log(`[prewarm] failed ${T}: ${e.message}`);
      }

      // brief pause so we don't hammer the APIs
      await new Promise(r => setTimeout(r, PREWARM_SPACING));
    }

    console.log("[prewarm] sweep complete");
  } catch (e) {
    console.log(`[prewarm] sweep aborted: ${e.message}`);
  } finally {
    prewarmRunning = false;
  }
}

// run shortly after server start, then every 6 hours
setTimeout(prewarmAll, 10 * 1000);          // first sweep, 10s after boot
setInterval(prewarmAll, REPORT_TTL);        // repeat sweeps every 6 hours

/* =========================
   START SERVER
   ========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
