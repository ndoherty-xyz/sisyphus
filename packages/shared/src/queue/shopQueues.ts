import { Queue } from "bullmq";
import { MAX_RETRIES, redisConnection } from "./connection";
import { WebhookJobData } from "../types";

export const ACTIVE_SHOP_QUEUES_KEY = "activeShopQueues";
export const shopQueueId = (shopId: string) => `shopQueue-${shopId}`;

const queueCache = new Map<string, Queue<WebhookJobData>>();

export function getOrCreateShopQueue(shopId: string): Queue<WebhookJobData> {
  const queueId = shopQueueId(shopId);
  const cachedQueue = queueCache.get(queueId);

  if (!cachedQueue) {
    const createdQueue = new Queue<WebhookJobData>(queueId, {
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

    queueCache.set(queueId, createdQueue);
    return createdQueue;
  } else {
    return cachedQueue;
  }
}
