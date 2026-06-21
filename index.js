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

/* ===================================================
   DYNAMIC TICKER -> CIK LOOKUP  (the big upgrade)
   Loads SEC's full company list once, keeps it in
   memory, and refreshes it at most once per day.
   This is what unlocks the whole US market.
   =================================================== */
let tickerMap = null;          // e.g. { AAPL: { cik: "0000320193", title: "Apple Inc." } }
let tickerMapLoadedAt = 0;
const ONE_DAY = 24 * 60 * 60 * 1000;

async function loadTickerMap() {
  // Reuse the cached list unless it's missing or more than a day old
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

/* =========================
   MAIN ENDPOINT:  /resolve?ticker=XXXX
   Works for ANY US-listed ticker now, not just the old 4.
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

    res.json({
      ticker: ticker.toUpperCase(),
      company: entry.title,
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
