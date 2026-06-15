const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());


// helper: fetch latest SEC filing
async function getFilings(cik) {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  const data = await res.json();

  const recent = data.filings.recent;

  let filings = [];

  for (let i = 0; i < 10; i++) {
    filings.push({
      form: recent.form[i],
      filingDate: recent.filingDate[i],
      accessionNumber: recent.accessionNumber[i]
    });
  }

  return filings;
}

// main endpoint
app.get("/resolve", async (req, res) => {
  const ticker = req.query.ticker;

  if (!ticker) {
    return res.status(400).json({ error: "Missing ticker" });
  }

  const cikMap = {
    AAPL: "0000320193",
    MSFT: "0000789019",
    TSLA: "0001318605",
    NVDA: "0001045810"
  };

  const cik = cikMap[ticker.toUpperCase()];

  if (!cik) {
    return res.status(404).json({ error: "CIK not found" });
  }

  const padded = cik.padStart(10, "0");

  try {
    const filings = await getFilings(padded);

    res.json({
      ticker: ticker.toUpperCase(),
      cik: padded,
      sec_url: `https://data.sec.gov/submissions/CIK${padded}.json`,
      filings: filings
    });

  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch SEC data",
      details: err.message
    });
  }
});
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});