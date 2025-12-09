import {
  db,
  events,
  shops,
  createWebhookQueue,
  addEventToQueue,
  checkGlobalBackpressureAndUpdateIfStale,
  checkTenantQueueBackpressure,
} from "@sisyphus/shared";
import { randomUUID } from "crypto";

const queue = createWebhookQueue();

function generateFakeOrder() {
  return {
    orderId: randomUUID(),
    items: [
      {
        sku: "WIDGET-1",
        quantity: Math.floor(Math.random() * 5) + 1,
        price: 29.99,
      },
      {
        sku: "GADGET-2",
        quantity: Math.floor(Math.random() * 3) + 1,
        price: 49.99,
      },
    ],
    total: Math.floor(Math.random() * 500) + 50,
    currency: "USD",
    createdAt: new Date().toISOString(),
  };
}

async function queueEvent(
  event: Omit<typeof events.$inferSelect, "id" | "createdAt" | "queuedAt">
) {
  const [dbEvent] = await db
    .insert(events)
    .values({
      ...event,
      queuedAt: null,
    })
    .returning();

  if (await checkGlobalBackpressureAndUpdateIfStale()) {
    // global backpressure, skip
    console.log(
      `global backpressure active, skipping queue for event ${dbEvent.id}`
    );
    return;
  }

  if (await checkTenantQueueBackpressure(dbEvent.shopId)) {
    // tenant backpressure, skip
    console.log(
      `tenant backpressure active for shop ${dbEvent.shopId}, skipping queue for event ${dbEvent.id}`
    );
    return;
  }

  await addEventToQueue(dbEvent);
}

async function produceEvent(shopId: string) {
  await queueEvent({
    shopId,
    eventType: "order.created",
    payload: generateFakeOrder(),
  });
}

async function main() {
  const shopId = process.argv[2];
  const count = parseInt(process.argv[3] || "1");

  if (!shopId) {
    const allShops = await db.select().from(shops);

    if (allShops.length === 0) {
      console.log("no shops exist yet. run the seed script first.");
    } else {
      console.log("usage: pnpm dev <shopId> [count]\n");
      console.log("available shops:");
      allShops.forEach((s) => console.log(`  ${s.id} - ${s.name}`));
    }

    await queue.close();
    process.exit(0);
  }

  for (let i = 0; i < count; i++) {
    await produceEvent(shopId);
  }

  console.log(`\nproduced ${count} event(s)`);

  await queue.close();
  process.exit(0);
}

main().catch(console.error);
