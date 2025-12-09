import {
  addEventToQueue,
  checkTenantQueueBackpressure,
  db,
  events,
  updateGlobalBackpressureState,
} from "@sisyphus/shared";
import { and, asc, eq, isNull } from "drizzle-orm";

async function runBackpressureDrainLoop() {
  console.log("backpressure drain system started...");

  let currentIteration = 0;

  while (true) {
    const globalBackpressure = await updateGlobalBackpressureState();

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
      continue;
    }

    await addEventToQueue(eventToQueue);
    currentIteration++;
  }
}

runBackpressureDrainLoop();
