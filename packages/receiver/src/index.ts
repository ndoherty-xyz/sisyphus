import express from "express";

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || "3001");

app.post("/webhook", (req, res) => {
  console.log("---webhook received---");
  console.log("headers:", JSON.stringify(req.headers, null, 2));
  console.log("body:", JSON.stringify(req.body, null, 2));
  console.log("----------------------");

  res.status(200).json({ received: true });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`receiver listening on port ${PORT}`);
});
