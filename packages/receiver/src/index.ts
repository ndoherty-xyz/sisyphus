import express from "express";

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || "3001");

app.post("/webhook", async (req, res) => {
  console.log("---webhook received---");
  console.log("headers:", JSON.stringify(req.headers, null, 2));
  console.log("body:", JSON.stringify(req.body, null, 2));
  console.log("----------------------");

  const failRate = parseFloat((req.query.fail_rate as string) ?? "0");
  const latency = parseInt((req.query.latency as string) ?? 0, 10);
  const status = parseInt(req.query.status as string, 10);

  // apply latency
  await new Promise((resolve) => setTimeout(resolve, latency));

  if (!isNaN(status)) {
    return res.status(status).json({ received: true });
  }

  const random = Math.random();

  if (random > failRate) {
    res.status(200).json({ received: true });
  } else {
    res.status(500).json({ error: "simulated endpoint failure" });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`receiver listening on port ${PORT}`);
});
