const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

// Render sits behind a reverse proxy; trust its X-Forwarded-For header
// so req.ip reflects the real client IP, not Render's proxy IP.
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());

/* =========================
   HEALTH CHECK
   Must be registered before the canonical-domain redirect below,
   so Render's health checker (which hits the service on its
   onrender.com hostname, not zelothorn.com) always gets a 200
   instead of being redirected.
   ========================= */
app.get("/healthz", (req, res) => {
  res.status(200).send("ok");
});

/* =========================
   CANONICAL DOMAIN REDIRECT
   Google was indexing both zelothorn.com and the Render default
   domain, splitting ranking signals. Force everything onto the
   custom domain with a permanent redirect. Skipped outside
   production so localhost doesn't get redirected during dev.
   ========================= */
const CANONICAL_HOST = "zelothorn.com";

if (process.env.NODE_ENV === "production") {
  app.use((req, res, next) => {
    if (req.hostname !== CANONICAL_HOST) {
      return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
    }
    next();
  });
}

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
   REQUEST TIMEOUT SETTINGS
   Prevents a hung upstream call (SEC, Finnhub, OpenAI) from
   hanging this server's request handling forever.
   ========================= */
const FETCH_TIMEOUT_MS = 10000;   // SEC + Finnhub: 10 seconds
const OPENAI_TIMEOUT_MS = 25000;  // OpenAI: 25 seconds (summary generation is slower)

/* =========================
   RATE LIMITING (/resolve)
   Caps requests per IP so the paid OpenAI calls behind
   /resolve can't be spammed.
   ========================= */
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 20;     // per IP, per window

const rateLimitBuckets = new Map(); // ip -> { count, windowStart }

function resolveRateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const bucket = rateLimitBuckets.get(ip);

  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(ip, { count: 1, windowStart: now });
    return next();
  }

  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({
      error: "Too many requests — please wait a minute and try again."
    });
  }

  next();
}

// Periodically clear out stale buckets so this map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitBuckets.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

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
    headers: SEC_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
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
  const res = await fetch(url, {
    headers: SEC_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });

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
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

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
    `Background context (recent SEC filings, for your reference only):\n` +
    `${filingLines}\n\n` +
    `Write a clear, plain-language summary for a regular person who may not ` +
    `know much about finance. Explain what this company is, what it actually ` +
    `does to make money, and give a high-level overview of its operations. ` +
    `Use 2-3 short paragraphs.\n\n` +
    `Important rules:\n` +
    `- Write in a standalone, article-style voice, as if published on a website.\n` +
    `- Never address the reader as "you" and never refer to this prompt, ` +
    `the list above, or any "filings you listed".\n` +
    `- Do NOT describe, explain, or summarize the SEC filings themselves ` +
    `(no explaining what a Form 4, 8-K, 10-K, or any filing type is). ` +
    `They are background context only.\n` +
    `- Keep the entire summary about the company: what it is, what it sells, ` +
    `and how it makes money.\n` +
    `- Do NOT give any buy, sell, or hold recommendation, and do not predict ` +
    `the stock price.`;

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
            "You are Zelothorn, a financial explainer. You write standalone, " +
            "article-style descriptions of public companies in plain, friendly " +
            "language, suitable for publishing directly on a website. You never " +
            "reference the prompt, the reader, or any list of filings. You never " +
            "explain SEC filing types. You never give investment advice and " +
            "never tell anyone what to buy or sell."
        },
        { role: "user", content: userPrompt }
      ],
      max_completion_tokens: 1200
    }),
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS)
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
  let filingsData;
  let filingsError = false;
  try {
    filingsData = await getFilings(entry.cik);
  } catch (e) {
    filingsData = { recent: [], key: [], name: null };
    filingsError = true;
  }

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
  let earningsUnavailable = false;
  try {
    earnings = await getEarnings(T);
    if (!earnings) {
      earningsError = "No analyst earnings estimates are available for this company yet.";
    }
  } catch (e) {
    earningsError = e.message;
    earningsUnavailable = true;
  }

  const payload = {
    ticker: T,
    company: companyName,
    cik: entry.cik,
    ai_summary: aiSummary,
    ai_error: aiError,
    earnings: earnings,
    earnings_error: earningsError,
    earnings_unavailable: earningsUnavailable,
    keyFilings: filingsData.key,
    filings: filingsData.recent,
    filings_error: filingsError,
    sec_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${entry.cik}&type=&dateb=&owner=include&count=40`
  };

  // Only cache complete, healthy reports
  if (aiSummary) {
    reportCache[T] = { at: Date.now(), data: payload };
  }

  return payload;
}

// Transform buildReport()'s internal payload into the versioned public
// API contract: explicit status per section instead of null/error-string
// ambiguity, so consumers can branch on it programmatically.
function buildApiV1Payload(payload) {
  const summaryStatus = payload.ai_summary ? "ok" : "unavailable";

  let earningsStatus = "ok";
  if (!payload.earnings) {
    earningsStatus = payload.earnings_unavailable ? "unavailable" : "not_applicable";
  }

  const filingsStatus = payload.filings_error ? "unavailable" : "ok";

  return {
    ticker: payload.ticker,
    cik: payload.cik,
    company: payload.company,
    summary: {
      status: summaryStatus,
      text: payload.ai_summary || null
    },
    earnings: {
      status: earningsStatus,
      latest: (payload.earnings && payload.earnings.latest) || null,
      history: (payload.earnings && payload.earnings.history) || []
    },
    filings: {
      status: filingsStatus,
      key: payload.keyFilings || [],
      recent: payload.filings || []
    },
    links: {
      secEdgar: payload.sec_url,
      companyPage: `https://zelothorn.com/company/${payload.ticker}`
    },
    generatedAt: new Date().toISOString()
  };
}

/* =========================
   MAIN ENDPOINT:  /resolve?ticker=XXXX
   ========================= */
const MAX_TICKER_LENGTH = 80; // generous enough for full company names

app.get("/resolve", resolveRateLimit, async (req, res) => {
  const ticker = req.query.ticker;

  if (!ticker || typeof ticker !== "string") {
    return res.status(400).json({ error: "Missing or invalid ticker parameter" });
  }

  const trimmed = ticker.trim();
  if (!trimmed) {
    return res.status(400).json({ error: "Missing ticker" });
  }
  if (trimmed.length > MAX_TICKER_LENGTH) {
    return res.status(400).json({ error: "Ticker or company name is too long" });
  }

  let T = trimmed.toUpperCase();

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

/* =========================
   PUBLIC API v1:  /api/v1/company/:ticker
   Exact ticker match only (no fuzzy name search - that's /resolve's
   job for the homepage search box). Reuses buildReport()/reportCache,
   so this shares a warm cache with /resolve for the same ticker.
   ========================= */
app.get("/api/v1/company/:ticker", resolveRateLimit, async (req, res) => {
  const T = String(req.params.ticker || "").trim().toUpperCase();

  if (!T) {
    return res.status(400).json({ error: "Missing ticker" });
  }
  if (T.length > MAX_TICKER_LENGTH) {
    return res.status(400).json({ error: "Ticker is too long" });
  }

  try {
    const map = await loadTickerMap();
    const entry = map[T];

    if (!entry) {
      return res.status(404).json({ error: `No company found for ticker '${T}'.` });
    }

    const cached = reportCache[T];
    const payload = (cached && Date.now() - cached.at < REPORT_TTL)
      ? cached.data
      : await buildReport(T, entry);

    res.json(buildApiV1Payload(payload));
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

// simple in-memory cache: TICKER -> { at: timestamp, html: finished HTML string }
// Pages expire after SEO_PAGE_TTL so summaries and earnings refresh themselves.
const seoPageCache = {};
const SEO_PAGE_TTL = 6 * 60 * 60 * 1000; // 6 hours, same as the report cache

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

// Build a search-snippet description from the AI summary: strip any HTML,
// collapse whitespace, and truncate at a word boundary (not mid-word).
function summaryToMetaDescription(text, maxLength = 150) {
  if (!text) return null;
  const plain = String(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  if (plain.length <= maxLength) return plain;

  const truncated = plain.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  const clipped = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  return clipped.trim() + "…";
}

// Plain-English names + short descriptions for common SEC filing codes.
// NOTE: this is duplicated from FORM_INFO in public/index.html (used by
// the homepage's client-side filings rendering). If you edit these
// labels, update both copies so the wording doesn't drift apart.
const FORM_INFO = {
  "10-K":    { name: "Annual report",        desc: "The company's big yearly financial report." },
  "10-Q":    { name: "Quarterly report",     desc: "A financial update covering the last 3 months." },
  "8-K":     { name: "Material event",       desc: "A heads-up about something important that just happened." },
  "4":       { name: "Insider trade",        desc: "An executive or director bought or sold company shares." },
  "3":       { name: "Insider ownership",    desc: "A new insider's first report of the shares they hold." },
  "5":       { name: "Insider annual summary",desc: "A yearly wrap-up of an insider's share activity." },
  "SD":      { name: "Specialized disclosure",desc: "A required disclosure (e.g. on sourcing of minerals)." },
  "DEF 14A": { name: "Proxy statement",      desc: "Info for shareholders ahead of a vote." },
  "S-1":     { name: "New share registration",desc: "Paperwork to offer new shares (often an IPO)." },
  "S-8":     { name: "Employee share plan",  desc: "Registering shares offered to employees." },
  "144":     { name: "Proposed share sale",  desc: "Notice that an insider plans to sell some shares." },
  "SC 13G":  { name: "Large shareholder",    desc: "A big investor reporting a sizable stake." },
  "SC 13D":  { name: "Activist shareholder", desc: "A big investor with intentions to influence the company." }
};

function formInfo(form) {
  return FORM_INFO[form] || { name: "SEC filing", desc: "An official filing with the SEC." };
}

// Render one filing as a linked row, matching the homepage's filing card markup.
function filingRowHtml(f) {
  const info = formInfo(f.form);
  return (
    `<a class="filing" href="${escapeHtml(f.url || "#")}" target="_blank" rel="noopener">` +
    `<div><span class="filing-name">${escapeHtml(info.name)}</span> ` +
    `<span class="filing-code">(${escapeHtml(f.form)})</span>` +
    `<div class="filing-desc">${escapeHtml(info.desc)}</div></div>` +
    `<div class="filing-date">${escapeHtml(f.filingDate)}</div>` +
    `</a>`
  );
}

// Render the "Key filings" + "Most recent filings" groups, matching the
// homepage's layout, from the filingsData the handler already fetched.
function renderFilingsHtml(filingsData) {
  let html = "";

  if (filingsData.key && filingsData.key.length) {
    html +=
      `<div class="filing-group">` +
      `<div class="subhead">Key filings</div>` +
      filingsData.key.map(filingRowHtml).join("") +
      `</div>`;
  }

  if (filingsData.recent && filingsData.recent.length) {
    html +=
      `<div class="filing-group">` +
      `<div class="subhead">Most recent filings</div>` +
      filingsData.recent.map(filingRowHtml).join("") +
      `</div>`;
  }

  return html;
}

// Shared page chrome for server-rendered pages (/company/:ticker and
// /learn/*): fonts, colors, layout, and the feedback-form/filing styles.
// Kept as one constant so these pages can't visually drift apart.
const PAGE_STYLE = `
  body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
       max-width:760px;margin:0 auto;padding:32px 20px;line-height:1.6;color:#1a1a1a;}
  h1{font-size:1.9rem;margin-bottom:.2em;}
  h2{font-size:1.3rem;margin-top:1.6em;}
  .sub{color:#666;margin-top:0;}
  .term-note{color:#888;font-size:.8rem;margin:8px 0 14px;}
  .cta{display:inline-block;margin:24px 0;padding:12px 20px;background:#111;color:#fff;
       text-decoration:none;border-radius:8px;}
  .disc{color:#888;font-size:.85rem;margin-top:40px;border-top:1px solid #eee;padding-top:16px;}
  .brand-line{font-weight:600;color:#5a4750;margin:20px 0 0;}
  .api-example{background:#f7f6f9;border:1px solid #eee;border-radius:10px;padding:16px 18px;margin:16px 0;}
  .api-field{margin-bottom:14px;}
  .api-field:last-child{margin-bottom:0;}
  .api-field p{margin:0;}
  .api-field ul{margin:0;padding-left:18px;}
  .api-field li{margin-bottom:4px;}
  .api-label{display:block;font-size:.7rem;font-weight:700;text-transform:uppercase;
       letter-spacing:.04em;color:#888;margin-bottom:4px;}
  code{background:#f0eef2;border-radius:4px;padding:2px 6px;font-size:.85em;}
  .filing-group{margin-bottom:22px;}
  .filing-group:last-child{margin-bottom:0;}
  .subhead{font-size:.8rem;font-weight:600;color:#1a1a1a;margin:4px 0 4px;}
  .filing{display:flex;justify-content:space-between;align-items:baseline;gap:14px;
       padding:13px 0;border-bottom:1px solid #eee;text-decoration:none;}
  .filing:last-child{border-bottom:none;}
  .filing:hover .filing-name{text-decoration:underline;}
  .filing-name{font-weight:500;color:#1a1a1a;font-size:.95rem;}
  .filing-code{color:#888;font-size:.75rem;}
  .filing-desc{color:#888;font-size:.8rem;margin-top:2px;}
  .filing-date{color:#888;font-size:.85rem;white-space:nowrap;}
  .footer-feedback{margin-top:10px;}
  .feedback-link{color:#888;font-size:.8rem;text-decoration:none;}
  .feedback-link:hover{text-decoration:underline;}
  .feedback-form{max-width:380px;margin:16px auto 6px;display:flex;flex-direction:column;gap:6px;}
  .feedback-form textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:42px;
       font-family:inherit;font-size:.8rem;color:#1a1a1a;background:#f7f6f9;
       border:1px solid #eee;border-radius:8px;padding:8px 10px;}
  .feedback-row{display:flex;gap:6px;}
  .feedback-row input[type="email"]{flex:1;box-sizing:border-box;font-family:inherit;font-size:.75rem;
       color:#1a1a1a;background:#f7f6f9;border:1px solid #eee;border-radius:8px;padding:6px 10px;}
  .feedback-row button{border:none;cursor:pointer;font-family:inherit;font-size:.8rem;font-weight:600;
       padding:6px 14px;border-radius:8px;background:#eee;color:#333;}
  .feedback-row button:hover{background:#e2e2e2;}
  .feedback-row button:disabled{opacity:.55;cursor:default;}
  .feedback-status{font-size:.75rem;min-height:14px;margin:0;color:#888;}
  .feedback-status.success{color:#2f8f5b;}
  .feedback-status.error{color:#9c4b4b;}
  a{color:#0b5;}
`;

// Shared feedback form + Formspree submit script, used on every
// server-rendered page. pageId fills the hidden "page" field (a machine
// ID, e.g. a ticker or "learn:what-is-a-10-k"); label is the human-
// readable text used in the mailto fallback's subject line, defaulting
// to pageId when it's already readable (e.g. a ticker).
function feedbackFormHtml(pageId, label = pageId, placeholder = "Was this explanation clear? Tell us what was confusing.") {
  const subject = encodeURIComponent(`Feedback: ${label}`);
  return `
  <form class="feedback-form" id="feedbackForm">
    <textarea id="feedbackMessage" name="message" rows="2" required
      placeholder="${escapeHtml(placeholder)}"></textarea>
    <div class="feedback-row">
      <input type="email" id="feedbackEmail" name="email" placeholder="Your email (optional)">
      <button type="submit" id="feedbackSubmit">Send</button>
    </div>
    <input type="hidden" name="page" value="${escapeHtml(pageId)}">
    <input type="text" name="_gotcha" style="display:none" tabindex="-1" autocomplete="off">
    <p class="feedback-status" id="feedbackStatus"></p>
  </form>
  <p class="footer-feedback"><a class="feedback-link" href="mailto:zelothornsupport@gmail.com?subject=${subject}">Or email us directly →</a></p>
  <script>
    const feedbackForm = document.getElementById("feedbackForm");
    const feedbackStatus = document.getElementById("feedbackStatus");
    const feedbackSubmit = document.getElementById("feedbackSubmit");

    feedbackForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      feedbackSubmit.disabled = true;
      feedbackStatus.textContent = "";
      feedbackStatus.className = "feedback-status";

      try {
        const res = await fetch("https://formspree.io/f/mqergkqo", {
          method: "POST",
          headers: { "Accept": "application/json" },
          body: new FormData(feedbackForm)
        });

        if (res.ok) {
          feedbackForm.reset();
          feedbackStatus.textContent = "Thanks for the feedback!";
          feedbackStatus.className = "feedback-status success";
        } else {
          feedbackStatus.textContent = "Couldn't send that — please try again or email us.";
          feedbackStatus.className = "feedback-status error";
        }
      } catch (err) {
        feedbackStatus.textContent = "Couldn't send that — please try again or email us.";
        feedbackStatus.className = "feedback-status error";
      } finally {
        feedbackSubmit.disabled = false;
      }
    });
  </script>`;
}

// Shared <head> meta tags for server-rendered pages (/company/:ticker,
// /learn/*): title, description, favicons, OG/Twitter tags, canonical.
// One place to edit so all these pages can't drift out of sync.
function headTagsHtml(title, metaDesc, canonicalUrl) {
  const escTitle = escapeHtml(title);
  const escDesc = escapeHtml(metaDesc);
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escTitle}</title>
<meta name="description" content="${escDesc}">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:title" content="${escTitle}">
<meta property="og:description" content="${escDesc}">
<meta property="og:image" content="https://zelothorn.com/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://zelothorn.com/og-image.png">
<link rel="canonical" href="${canonicalUrl}">`;
}

app.get("/company/:ticker", async (req, res) => {
  const T = String(req.params.ticker || "").toUpperCase();

  // Serve from cache only if the page is still fresh
  const cachedPage = seoPageCache[T];
  if (cachedPage && Date.now() - cachedPage.at < SEO_PAGE_TTL) {
    return res.send(cachedPage.html);
  }

  try {
    const map = await loadTickerMap();
    const entry = map[T];

    if (!entry) {
      const missingSubject = encodeURIComponent(`Missing: ${T}`);
      return res.status(404).send(
        `<!DOCTYPE html><html><head><meta charset="utf-8">` +
        `<title>Company not found | Zelothorn</title></head><body>` +
        `<h1>We couldn't find that company</h1>` +
        `<p>No U.S. public company was found for the symbol "${escapeHtml(T)}".</p>` +
        `<p><a href="/">Back to Zelothorn</a></p>` +
        `<p><a href="mailto:zelothornsupport@gmail.com?subject=${missingSubject}" style="color:#888;font-size:.85rem;text-decoration:none;">Looking for a company we don't cover? Tell us which one →</a></p>` +
        `</body></html>`
      );
    }

    let filingsData;
    let filingsError = false;
    try {
      filingsData = await getFilings(entry.cik);
    } catch (e) {
      filingsData = { recent: [], key: [], name: null };
      filingsError = true;
    }

    const companyName = NAME_OVERRIDES[T] || tidyCompanyName(filingsData.name || entry.title);

    let aiSummary = null;
    try { aiSummary = await generateSummary(companyName, T, filingsData.recent); }
    catch (e) { aiSummary = null; }

    let earnings = null;
    let earningsError = false;
    try {
      earnings = await getEarnings(T);
    } catch (e) {
      earnings = null;
      earningsError = true;
    }

    let earningsHtml = "";
    if (earnings && earnings.latest) {
      const L = earnings.latest;
      const verb = L.result === "beat" ? "beat" : (L.result === "miss" ? "missed" : "met");
      earningsHtml =
        `<h2>How did ${escapeHtml(companyName)}'s latest earnings compare?</h2>` +
        `<p class="term-note">An earnings release is a company's quarterly report of how much ` +
        `money it made. Analysts predict these numbers ahead of time, and the actual results are ` +
        `compared against those predictions.</p>` +
        `<p>In the most recent quarter (${escapeHtml(L.period)}), ${escapeHtml(companyName)} ` +
        `reported earnings of $${escapeHtml(L.actualEPS)} per share. Analysts expected ` +
        `$${escapeHtml(L.estimateEPS)} per share, so the company <strong>${verb}</strong> ` +
        `expectations.</p>`;
    } else if (earningsError) {
      earningsHtml =
        `<h2>How did ${escapeHtml(companyName)}'s latest earnings compare?</h2>` +
        `<p class="term-note">Earnings data is temporarily unavailable — please check back soon.</p>`;
    }

    const summaryHtml = aiSummary
      ? paragraphsToHtml(aiSummary)
      : `<p>A plain-language overview for ${escapeHtml(companyName)} is being prepared. ` +
        `You can look up this company directly on <a href="/">Zelothorn</a>.</p>`;

    const filingsHtml = filingsError
      ? `<p class="term-note">Filings are temporarily unavailable — please check back soon, or view them directly on SEC.gov below.</p>`
      : renderFilingsHtml(filingsData);

    const title = `What does ${companyName} do? | ${T} explained | Zelothorn`;
    const fallbackDesc = `A plain-language explanation of what ${companyName} (${T}) does, ` +
      `how it makes money, and how its latest earnings compared to expectations.`;
    const metaDesc = summaryToMetaDescription(aiSummary) || fallbackDesc;
    const canonicalUrl = `https://zelothorn.com/company/${escapeHtml(T)}`;

    const html =
`<!DOCTYPE html>
<html lang="en">
<head>
${headTagsHtml(title, metaDesc, canonicalUrl)}
<style>${PAGE_STYLE}</style>
</head>
<body>
  <h1>What does ${escapeHtml(companyName)} do?</h1>
  <p class="sub">${escapeHtml(T)} &middot; Plain-English company overview</p>
  <p class="term-note">A stock is a share of ownership in a company. Owning one means you own a small piece of that business.</p>
  ${summaryHtml}
  ${earningsHtml}
  <h2>SEC Filings</h2>
  ${filingsHtml}
  <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${entry.cik}&type=&dateb=&owner=include&count=40" target="_blank" rel="noopener">View all filings on SEC.gov &rarr;</a>
  <a class="cta" href="/">Look up any company on Zelothorn &rarr;</a>
  <p class="disc">Zelothorn provides AI-generated explanations and official public data for
  educational purposes only. It is not financial advice and does not recommend buying or
  selling any security.</p>
  ${feedbackFormHtml(T)}
</body>
</html>`;

    seoPageCache[T] = { at: Date.now(), html: html };
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
   LEARN PAGES
   Static, human-authored educational content - no SEC/Finnhub
   calls, no per-request caching needed.
   =================================================== */
app.get("/learn/what-is-a-10-k", (req, res) => {
  const title = "What is a 10-K? Plain-English Guide | Zelothorn";
  const metaDesc = "What a 10-K is, what's inside it (Business, Risk Factors, MD&A, " +
    "Financials), when it's filed, and why it matters — explained in plain language.";
  const canonicalUrl = "https://zelothorn.com/learn/what-is-a-10-k";

  const html =
`<!DOCTYPE html>
<html lang="en">
<head>
${headTagsHtml(title, metaDesc, canonicalUrl)}
<style>${PAGE_STYLE}</style>
</head>
<body>
  <h1>What is a 10-K? A plain-English guide</h1>
  <p class="sub">The short version: The 10-K is the big one — a company's official annual
  filing with the SEC. No marketing, no spin, everything on the record. If a company filed
  only one document a year, this would be it.</p>

  <h2>What it is</h2>
  <p>The 10-K is the complete annual report a public company files with the SEC each year.
  Not the glossy shareholder version with the CEO's letter and stock photos — the legally
  binding one, audited and detailed, where every claim is on the record. The difference
  matters: a press release is marketing, a 10-K is testimony. Misstating a 10-K is
  securities fraud.</p>

  <h2>When it's filed</h2>
  <p>Once a year, after the fiscal year closes. Large companies ("large accelerated
  filers") have 60 days; smaller ones get 75 or 90. A December fiscal year-end means a
  10-K landing in the first quarter.</p>

  <h2>What's inside</h2>
  <p><strong>Item 1 — Business.</strong> What the company does, its segments, products,
  and how revenue is actually generated. Often the single clearest description of a
  company that exists.</p>
  <p><strong>Item 1A — Risk Factors.</strong> Every material risk the company will admit
  to, in writing. Competition, litigation, concentration, leverage. Read alongside last
  year's, the changes are the interesting part.</p>
  <p><strong>Item 7 — MD&amp;A.</strong> Management's own narrative on the year's
  results — what moved, and their explanation of why.</p>
  <p><strong>Item 8 — Financial Statements.</strong> The audited numbers: income
  statement, balance sheet, cash flows, and the footnotes (where the real detail
  hides).</p>

  <h2>Why it matters</h2>
  <p>It's the primary source. Everything downstream — news, analysis, hot takes — is
  someone's interpretation of what's in here. The 10-K is the thing itself, free and
  public, the same document the analysts read before they have an opinion.</p>
  <p>The only problem is the format: a hundred-plus pages of legal prose nobody enjoys.
  That's Zelothorn's job — the plain-language version, with a direct link to the real
  filing.</p>

  <h2>See a real one</h2>
  <p>Each explained plainly, linked to the official document:<br>
  <a href="/company/AAPL">Apple</a> &middot; <a href="/company/MSFT">Microsoft</a> &middot;
  <a href="/company/TSLA">Tesla</a></p>

  <p class="brand-line">Zelothorn explains what's already public. No ratings, no price
  targets, no buy or sell advice — ever.</p>

  <p class="disc">Zelothorn provides plain-language educational explanations and links to
  official public data for educational purposes only. It is not financial advice and does
  not recommend buying or selling any security.</p>

  ${feedbackFormHtml("learn:what-is-a-10-k", "What is a 10-K?")}
</body>
</html>`;

  res.send(html);
});

app.get("/learn/what-is-a-10-q", (req, res) => {
  const title = "What is a 10-Q? Plain-English Guide | Zelothorn";
  const metaDesc = "What a 10-Q is, what's inside it (financials, MD&A, updated risk " +
    "factors), when it's filed, and why it matters — explained in plain language.";
  const canonicalUrl = "https://zelothorn.com/learn/what-is-a-10-q";

  const html =
`<!DOCTYPE html>
<html lang="en">
<head>
${headTagsHtml(title, metaDesc, canonicalUrl)}
<style>${PAGE_STYLE}</style>
</head>
<body>
  <h1>What is a 10-Q? A plain-English guide</h1>
  <p class="sub">The short version: The 10-Q is the 10-K's smaller, more frequent
  sibling — a quarterly check-in filed three times a year. Lighter, unaudited, but it's
  how you keep up with a company between annual reports.</p>

  <h2>What it is</h2>
  <p>The 10-Q is a quarterly financial report public companies file with the SEC. Think
  of it as a progress update between the big annual 10-K. It's shorter, and unlike the
  10-K, the numbers are unaudited — reviewed by accountants, but not put through the full
  audit the annual report gets. Companies file three 10-Qs a year; the fourth quarter gets
  rolled into the annual 10-K instead.</p>

  <h2>When it's filed</h2>
  <p>Within 40 or 45 days of each quarter's end, depending on company size. Three times a
  year — Q1, Q2, Q3. There's no Q4 10-Q, because that quarter's results live inside the
  annual 10-K.</p>

  <h2>What's inside</h2>
  <p><strong>Financial statements.</strong> The quarter's numbers — revenue, profit,
  cash — plus a comparison to the same quarter last year. Unaudited, but still on the
  record.</p>
  <p><strong>MD&amp;A.</strong> Management's shorter take on how the quarter went and
  what changed.</p>
  <p><strong>Updates to risk factors.</strong> Not the full list from the 10-K — just
  what's new or changed since then. A new risk showing up mid-year is worth noticing.</p>

  <h2>Why it matters</h2>
  <p>The 10-Q is how you track a company in something close to real time. The 10-K is
  once a year; a lot happens in twelve months. The quarterlies are where you catch a
  trend forming — growth speeding up, margins slipping, a new risk appearing — before it
  shows up in the annual report or the headlines.</p>
  <p>The tradeoff for speed is depth: less detail than a 10-K, and unaudited. Still the
  primary source, just a lighter one. Zelothorn gives you the plain-language version,
  linked to the real filing.</p>

  <h2>See a real one</h2>
  <p>Each explained plainly, linked to the official document:<br>
  <a href="/company/AAPL">Apple</a> &middot; <a href="/company/MSFT">Microsoft</a> &middot;
  <a href="/company/TSLA">Tesla</a></p>

  <p class="brand-line">Zelothorn explains what's already public. No ratings, no price
  targets, no buy or sell advice — ever.</p>

  <p class="disc">Zelothorn provides plain-language educational explanations and links to
  official public data for educational purposes only. It is not financial advice and does
  not recommend buying or selling any security.</p>

  ${feedbackFormHtml("learn:what-is-a-10-q", "What is a 10-Q?")}
</body>
</html>`;

  res.send(html);
});

app.get("/learn/what-is-an-8-k", (req, res) => {
  const title = "What is an 8-K? Plain-English Guide | Zelothorn";
  const metaDesc = "What an 8-K is, what triggers one (earnings, leadership changes, " +
    "deals, material events), when it's filed, and why it matters — explained in plain language.";
  const canonicalUrl = "https://zelothorn.com/learn/what-is-an-8-k";

  const html =
`<!DOCTYPE html>
<html lang="en">
<head>
${headTagsHtml(title, metaDesc, canonicalUrl)}
<style>${PAGE_STYLE}</style>
</head>
<body>
  <h1>What is an 8-K? A plain-English guide</h1>
  <p class="sub">The short version: The 8-K is the "something just happened" filing.
  When a major event hits between scheduled reports, companies have to tell the SEC
  fast — usually within four business days. It's the closest thing to breaking news in
  official filings.</p>

  <h2>What it is</h2>
  <p>An 8-K is a current report — filed whenever a significant event happens that
  shareholders should know about, outside the regular quarterly and annual schedule.
  Where the 10-K and 10-Q are periodic, the 8-K is triggered by events. Something
  material occurs, the clock starts, and the company has to disclose it.</p>

  <h2>When it's filed</h2>
  <p>Usually within four business days of the triggering event. There's no set
  schedule — a company might file several 8-Ks in a month or none for a while. The
  timing itself tells you something: 8-Ks cluster around the moments that matter.</p>

  <h2>What's inside</h2>
  <p>It depends entirely on what happened. Common triggers include:</p>
  <p><strong>Earnings releases —</strong> the quarterly numbers often come out via 8-K
  first.</p>
  <p><strong>Leadership changes —</strong> a CEO or CFO departing or being appointed.</p>
  <p><strong>Major deals —</strong> acquisitions, mergers, big agreements.</p>
  <p><strong>Material events —</strong> bankruptcy, a major lawsuit, delisting, or other
  significant developments.</p>
  <p>Each 8-K is labeled with an "item number" telling you which type of event it
  covers.</p>

  <h2>Why it matters</h2>
  <p>The 8-K is where you find out what's happening now, straight from the company,
  before it's been spun into a press narrative. If a 10-K is the annual story and the
  10-Q is the quarterly update, the 8-K is the alert. When something big moves at a
  company, there's usually an 8-K behind it.</p>
  <p>Zelothorn gives you the plain-language version, linked to the real filing.</p>

  <h2>See a real one</h2>
  <p>Each explained plainly, linked to the official document:<br>
  <a href="/company/AAPL">Apple</a> &middot; <a href="/company/MSFT">Microsoft</a> &middot;
  <a href="/company/TSLA">Tesla</a></p>

  <p class="brand-line">Zelothorn explains what's already public. No ratings, no price
  targets, no buy or sell advice — ever.</p>

  <p class="disc">Zelothorn provides plain-language educational explanations and links to
  official public data for educational purposes only. It is not financial advice and does
  not recommend buying or selling any security.</p>

  ${feedbackFormHtml("learn:what-is-an-8-k", "What is an 8-K?")}
</body>
</html>`;

  res.send(html);
});

/* ===================================================
   DEVELOPERS API LANDING PAGE
   Marketing/docs page for /api/v1/company/:ticker. Renders a live
   AAPL example via the same buildReport()/reportCache/buildApiV1Payload
   pipeline the API itself uses - no separate data path, so this page
   can't drift out of sync with what the API actually returns.
   =================================================== */
app.get("/developers", async (req, res) => {
  const title = "Zelothorn Developer API | Plain-Language Company Data";
  const metaDesc = "A JSON API returning plain-language company summaries, earnings " +
    "beat/miss results, and SEC filings. GET /api/v1/company/:ticker.";
  const canonicalUrl = "https://zelothorn.com/developers";

  let exampleHtml = `<p class="term-note">Live example is temporarily unavailable — try ` +
    `<a href="/api/v1/company/AAPL">GET /api/v1/company/AAPL</a> directly.</p>`;

  try {
    const map = await loadTickerMap();
    const entry = map["AAPL"];
    const cached = reportCache["AAPL"];
    const payload = (cached && Date.now() - cached.at < REPORT_TTL)
      ? cached.data
      : await buildReport("AAPL", entry);
    const api = buildApiV1Payload(payload);

    let earningsLine = "Not available for this company right now.";
    if (api.earnings.status === "ok") {
      const L = api.earnings.latest;
      const verb = L.result === "beat" ? "Beat" : (L.result === "miss" ? "Missed" : "Met");
      earningsLine = `${verb} expectations — $${L.actualEPS} actual vs $${L.estimateEPS} ` +
        `estimate (${escapeHtml(L.period)})`;
    }

    const keyFilings = (api.filings.key.length ? api.filings.key : api.filings.recent).slice(0, 2);
    const filingsListHtml = keyFilings.length
      ? `<ul>${keyFilings.map(f =>
          `<li>${escapeHtml(f.form)} filed ${escapeHtml(f.filingDate)} — ` +
          `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener">view</a></li>`
        ).join("")}</ul>`
      : `<p>No filings available right now.</p>`;

    exampleHtml = `
    <div class="api-example">
      <div class="api-field">
        <span class="api-label">Company</span>
        ${escapeHtml(api.company)} (${escapeHtml(api.ticker)})
      </div>
      <div class="api-field">
        <span class="api-label">Summary</span>
        <p>${escapeHtml(api.summary.text || "Not available right now.")}</p>
      </div>
      <div class="api-field">
        <span class="api-label">Latest earnings</span>
        <p>${earningsLine}</p>
      </div>
      <div class="api-field">
        <span class="api-label">Key filings</span>
        ${filingsListHtml}
      </div>
    </div>
    <p class="term-note">This is <code>GET /api/v1/company/AAPL</code> —
      <a href="/api/v1/company/AAPL">see the raw JSON here</a>.</p>`;
  } catch (e) {
    // exampleHtml already holds the fallback set above
  }

  const html =
`<!DOCTYPE html>
<html lang="en">
<head>
${headTagsHtml(title, metaDesc, canonicalUrl)}
<style>${PAGE_STYLE}</style>
</head>
<body>
  <h1>Plain-language company data, ready for your app.</h1>
  <p class="sub">The Zelothorn API returns what a company does, how it makes money,
  whether its latest earnings beat or missed expectations, and its official SEC
  filings — all as structured JSON.</p>

  <h2>Live example</h2>
  ${exampleHtml}

  <h2>How to use it</h2>
  <p><strong>Endpoint:</strong> <code>/api/v1/company/:ticker</code><br>
  <strong>Method:</strong> GET<br>
  <strong>Example:</strong> <code>https://zelothorn.com/api/v1/company/MSFT</code></p>
  <p>Top-level fields returned:</p>
  <ul>
    <li><strong>company</strong> — name, ticker, and CIK</li>
    <li><strong>summary</strong> — plain-language explanation of the business</li>
    <li><strong>earnings</strong> — latest quarter's beat/miss result and recent history</li>
    <li><strong>filings</strong> — key and recent SEC filings, each linked to the official document</li>
    <li><strong>links</strong> — direct links to SEC EDGAR and the company's Zelothorn page</li>
  </ul>

  <h2>Get notified</h2>
  <p>Want an API key when paid tiers launch? Tell me here.</p>
  ${feedbackFormHtml("developers-api", "API access interest", "What would you build with this? Or leave your email for an API key when paid tiers launch.")}
</body>
</html>`;

  res.send(html);
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
  "T","VZ","TMUS","CMCSA","NFLX","WBD","ARM","FOX","EA","TTWO",
  "MAR","HLT","LULU","ROST","DG","DLTR","ORLY","AZO","YUM","CMG",
  "KHC","GIS","K","HSY","STZ","KDP","MNST","CL","KMB","EL",
  "WBA","MCK","CNC","HUM","BIIB","ILMN","MRNA","DXCM","IDXX","ISRG",
  "NOW","FTNT","ADSK","WDAY","ANET","KEYS","GLW","HPQ","DELL","WDC",
  "STX","NXPI","ADI","MCHP","ON","MPWR","FSLR","ENPH","PLUG","RUN",
  "GME","AMC","BBBY","SMCI","CLOV","TLRY","CGC","DKNG","PENN","WYNN"
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
  <url><loc>${base}/learn/what-is-a-10-k</loc></url>
  <url><loc>${base}/learn/what-is-a-10-q</loc></url>
  <url><loc>${base}/learn/what-is-an-8-k</loc></url>
  <url><loc>${base}/developers</loc></url>
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
