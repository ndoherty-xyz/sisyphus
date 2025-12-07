import { Queue, Worker, type ConnectionOptions } from "bullmq";

export const redisConnection: ConnectionOptions = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
};

export const WEBHOOK_QUEUE = "webhook-delivery";

export function createWebhookQueue() {
  return new Queue(WEBHOOK_QUEUE, { connection: redisConnection });
}
