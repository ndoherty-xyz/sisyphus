import {
  addEventToQueue,
  checkGlobalBackpressureAndUpdateIfStale,
  checkTenantQueueBackpressure,
  db,
  events,
  shops,
} from "@sisyphus/shared";
import { randomUUID } from "crypto";
import { asc, eq } from "drizzle-orm";

function generateFakeOrder() {
  return {
    orderId: randomUUID(),
    items: [{ sku: "WIDGET-1", quantity: 1, price: 29.99 }],
    total: 100,
    currency: "USD",
    createdAt: new Date().toISOString(),
  };
}

async function flood() {
  const shopId = process.argv[2];
  const count = parseInt(process.argv[3] || "100");
  const skipQueue = process.argv.includes("--db-only");

  if (!shopId) {
    const allShops = await db.select().from(shops);
    console.log("usage: pnpm flood <shopId> <count> [--db-only]");
    console.log("\navailable shops:");
    allShops.forEach((s) => console.log(`  ${s.id} - ${s.name}`));
    process.exit(0);
  }

  console.log(`flooding ${count} events for shop ${shopId}...`);
  if (skipQueue) {
    console.log("(--db-only: inserting to DB without queueing)");
  }

  const eventsToInsert = Array.from({ length: count }, () => ({
    shopId,
    eventType: "order.created",
    payload: generateFakeOrder(),
    queuedAt: null,
  }));

  await db.insert(events).values(eventsToInsert);

  console.log(`inserted ${count} events with queuedAt=null`);

  if (!skipQueue) {
    const pendingEvents = await db
      .select()
      .from(events)
      .where(eq(events.shopId, shopId))
      .orderBy(asc(events.createdAt));

    let queued = 0;
    let skipped = 0;

    for (const event of pendingEvents) {
      if (event.queuedAt) continue;

      if (await checkGlobalBackpressureAndUpdateIfStale()) {
        console.log(`global backpressure hit after ${queued} queued`);
        skipped++;
        continue;
      }

      if (await checkTenantQueueBackpressure(event.shopId)) {
        console.log(`tenant backpressure hit after ${queued} queued`);
        skipped++;
        continue;
      }

      await addEventToQueue(event);
      queued++;
    }

    console.log(
      `\nresults: ${queued} queued, ${skipped} skipped (backpressure)`
    );
  }

  process.exit(0);
}

flood().catch(console.error);
