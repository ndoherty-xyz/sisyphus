import { Queue, type ConnectionOptions } from "bullmq";
import Redis from "ioredis";

export const redisConnection: ConnectionOptions = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
};

export const WEBHOOK_QUEUE = "webhook-delivery";
export const MAX_RETRIES = 5;
export const CIRCUIT_COOLDOWN_MS = 30_000;
export const CIRCUIT_ERROR_LIMIT = 5;
export const CIRCUIT_TIME_LIMIT_MS = 60_000;

export function createWebhookQueue() {
  return new Queue(WEBHOOK_QUEUE, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: MAX_RETRIES,
      backoff: {
        type: "exponential",
        delay: 2000,
        jitter: 0.2,
      },
    },
  });
}

export const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  maxRetriesPerRequest: null,
});
