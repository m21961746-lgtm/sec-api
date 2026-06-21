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
   SEC asks that requests identify who is sending them.
   (You can drop a contact email in here later if you want.)
   ========================= */
const SEC_HEADERS = {
  "User-Agent": "Zelothorn (https://zelothorn-api.onrender.com)"
};

/* =========================
   AI MODEL SETTINGS (Phase 1)
   The model that writes the plain-language summary.
   gpt-5.4-mini is fast + cheap. You can change this name
   later if you ever want a smarter (pricier) model.
   ========================= */
const OPENAI_MODEL = "gpt-5.4-mini";

/* ===================================================
   DYNAMIC TICKER -> CIK LOOKUP
   Loads SEC's full company list once, keeps it in
   memory, and refreshes it at most once per day.
   This is what unlocks the whole US market.
   =================================================== */
let tickerMap = null;          // e.g. { AAPL: { cik: "0000320193", title: "Apple Inc." } }
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

/* =========================
   FETCH LATEST SEC FILINGS
   ========================= */
async function getFilings(cik) {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;

  const res = await fetch(url, { headers: SEC_HEADERS });

  if (!res.ok) {
    throw new Error(`SEC filings request failed (status ${res.status})`);
  }

  const data = await res.json();
  const recent = data.filings.recent;

  const filings = [];
  const count = Math.min(10, recent.form.length);
  for (let i = 0; i < count; i++) {
    filings.push({
      form: recent.form[i],
      filingDate: recent.filingDate[i],
      accessionNumber: recent.accessionNumber[i]
    });
  }
  return filings;
}

/* ===================================================
   PHASE 1: AI SUMMARY
   Sends the company + its recent filings to OpenAI and
   asks for a plain-language explanation of the business.
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

/* =========================
   MAIN ENDPOINT:  /resolve?ticker=XXXX
   Returns: AI summary (Phase 1) + SEC filings (Phase 2)
   ========================= */
app.get("/resolve", async (req, res) => {
  const ticker = req.query.ticker;

  if (!ticker) {
    return res.status(400).json({ error: "Missing ticker" });
  }

  try {
    const map = await loadTickerMap();
    const entry = map[ticker.toUpperCase()];

    if (!entry) {
      return res.status(404).json({
        error: `Ticker '${ticker.toUpperCase()}' not found in SEC's company list.`
      });
    }

    const filings = await getFilings(entry.cik);

    // Phase 1 — try to add the AI summary. If it fails, we still
    // return all the SEC data so the report is never fully broken.
    let aiSummary = null;
    let aiError = null;
    try {
      aiSummary = await generateSummary(entry.title, ticker.toUpperCase(), filings);
    } catch (e) {
      aiError = e.message;
    }

    res.json({
      ticker: ticker.toUpperCase(),
      company: entry.title,
      ai_summary: aiSummary,   // Phase 1 result (null if it failed)
      ai_error: aiError,       // null when the summary worked
      cik: entry.cik,
      sec_url: `https://data.sec.gov/submissions/CIK${entry.cik}.json`,
      filings: filings
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch SEC data",
      details: err.message
    });
  }
});

/* =========================
   START SERVER
   ========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
