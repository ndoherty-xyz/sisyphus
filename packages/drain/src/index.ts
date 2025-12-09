import {
  addEventToQueue,
  checkTenantQueueBackpressure,
  createLogger,
  db,
  events,
  updateGlobalBackpressureState,
} from "@sisyphus/shared";
import { and, asc, eq, isNull } from "drizzle-orm";

const logger = createLogger("drain");

async function runBackpressureDrainLoop() {
  logger.info("Backpressure drain system started...");

  let currentIteration = 0;

  while (true) {
    const globalBackpressure = await updateGlobalBackpressureState(logger);

    if (globalBackpressure) {
      // busy loop, sleep a second
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    const shopIds = await db
      .select({ shopId: events.shopId })
      .from(events)
      .where(isNull(events.queuedAt))
      .groupBy(events.shopId);

    if (shopIds.length === 0) {
      // busy loop, sleep a second
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    const selectedShopId = shopIds[currentIteration % shopIds.length].shopId;

    if (await checkTenantQueueBackpressure(selectedShopId)) {
      currentIteration++;
      continue;
    }

    const [eventToQueue] = await db
      .select()
      .from(events)
      .where(and(eq(events.shopId, selectedShopId), isNull(events.queuedAt)))
      .orderBy(asc(events.createdAt))
      .limit(1);

    if (!eventToQueue) {
      currentIteration++;
      continue;
    }

    await addEventToQueue(eventToQueue, logger);
    currentIteration++;
  }
}

runBackpressureDrainLoop();
