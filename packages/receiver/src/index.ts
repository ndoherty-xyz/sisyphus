import { createLogger } from "@sisyphus/shared";
import express from "express";

const logger = createLogger("receiver");

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || "3001");

app.post("/webhook", async (req, res) => {
  const failRate = parseFloat((req.query.fail_rate as string) ?? "0");
  const latency = parseInt((req.query.latency as string) ?? 0, 10);
  const status = parseInt(req.query.status as string, 10);

  // apply latency
  await new Promise((resolve) => setTimeout(resolve, latency));

  if (!isNaN(status)) {
    logger.info(
      {
        status: status,
        received: true,
      },
      "Webhook received with status argument"
    );
    return res.status(status).json({ received: true });
  }

  const random = Math.random();

  if (random > failRate) {
    logger.info(
      {
        status: 200,
        received: true,
      },
      "Webhook received sucessfully"
    );
    res.status(200).json({ received: true });
  } else {
    logger.info(
      {
        status: 500,
        received: true,
      },
      "Webhook received, but had an error"
    );
    res.status(500).json({ error: "simulated endpoint failure" });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, "Receiver started");
});
