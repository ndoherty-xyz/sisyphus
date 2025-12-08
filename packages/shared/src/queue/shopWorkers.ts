import { Worker } from "bullmq";
import { redisConnection } from "./connection";
import { WebhookJobData } from "../types";
import { shopQueueId } from "./shopQueues";

export const STALE_WORKER_TIME_LIMIT_MS = 1000 * 60 * 60; // 1hr stale worker

export const shopWorkerId = (shopId: string) => `shopWorker-${shopId}`;

const workerCache = new Map<
  string,
  { worker: Worker<WebhookJobData>; lastActivityAt: number }
>();

export function getOrCreateShopWorker(shopId: string): Worker<WebhookJobData> {
  const workerId = shopWorkerId(shopId);
  const cachedWorker = workerCache.get(workerId);

  if (!cachedWorker) {
    const createdWorker = new Worker(shopQueueId(shopId), null, {
      connection: redisConnection,
      lockDuration: 60_000, // 60s, jobs should max take 10-15s,
      drainDelay: 0.5,
    });

    workerCache.set(workerId, {
      worker: createdWorker,
      lastActivityAt: Date.now(),
    });
    return createdWorker;
  } else {
    return cachedWorker.worker;
  }
}

export function updateLatestActivityForWorker(
  shopId: string,
  lastActivityAt: number
): void {
  const workerId = shopWorkerId(shopId);
  const worker = workerCache.get(workerId);

  if (!worker) {
    // no-op, no worker to update, warn (shouldn't happen)
    console.warn(
      `tried to update latestActivityAt for a worker that doesn't exist for shop ${shopId}`
    );
    return;
  }

  workerCache.set(workerId, { worker: worker.worker, lastActivityAt });
}

export function cleanupStaleWorkers(): void {
  const entries = [...workerCache.entries()];

  entries.forEach((entry) => {
    const id = entry[0];
    const val = entry[1];
    const lastActivityAt = val.lastActivityAt;

    // clear any with no last activity, or that are stale
    if (
      !lastActivityAt ||
      lastActivityAt < Date.now() - STALE_WORKER_TIME_LIMIT_MS
    ) {
      val.worker.close();
      workerCache.delete(id);
    }
  });
}
