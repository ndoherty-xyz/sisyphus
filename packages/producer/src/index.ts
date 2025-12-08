import {
  db,
  events,
  shops,
  webhookRegistrations,
  createWebhookQueue,
  WebhookJobData,
  getOrCreateShopQueue,
  redis,
  ACTIVE_SHOP_QUEUES_KEY,
} from "@sisyphus/shared";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";

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

async function addEventToShopQueue(event: WebhookJobData) {
  const queue = getOrCreateShopQueue(event.shopId);
  await queue.add("webhook-delivery", event);
  await redis.sadd(ACTIVE_SHOP_QUEUES_KEY, event.shopId);
  console.log(
    `queued job for event ${event.eventId}, shop ${event.shopId} and registration ${event.registrationId}`
  );
}

async function produceEvent(shopId: string) {
  const [event] = await db
    .insert(events)
    .values({
      shopId,
      eventType: "order.created",
      payload: generateFakeOrder(),
    })
    .returning();

  const registrations = await db
    .select()
    .from(webhookRegistrations)
    .where(eq(webhookRegistrations.shopId, shopId))
    .execute();

  for (const registration of registrations) {
    if (registration.events.includes(event.eventType)) {
      await addEventToShopQueue({
        eventId: event.id,
        shopId: registration.shopId,
        registrationId: registration.id,
      });
    }
  }
  return event;
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
