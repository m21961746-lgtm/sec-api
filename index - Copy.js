const express = require("express");
const app = express();

app.use(express.json());

// test route
app.get("/", (req, res) => {
  res.send("SEC API is running");
});

// ticker endpoint (we will build this into your AI system next)
app.get("/resolve", (req, res) => {
  const ticker = req.query.ticker;

  if (!ticker) {
    return res.status(400).json({
      error: "Missing ticker parameter"
    });
  }

  res.json({
    message: "Ticker received",
    ticker: ticker
  });
});

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});