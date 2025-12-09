import {
  db,
  events,
  shops,
  addEventToQueue,
  createLogger,
} from "@sisyphus/shared";
import { randomUUID } from "crypto";

const logger = createLogger("producer");

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

async function produceEvent(shopId: string) {
  const [dbEvent] = await db
    .insert(events)
    .values({
      shopId,
      eventType: "order.created",
      payload: generateFakeOrder(),
    })
    .returning();

  await addEventToQueue(dbEvent, logger);
}

async function main() {
  const shopId = process.argv[2];
  const count = parseInt(process.argv[3] || "1");

  if (!shopId) {
    const allShops = await db.select().from(shops);

    if (allShops.length === 0) {
      logger.warn("No shops exist yet. run the seed script first.");
    } else {
      logger.info(
        {
          availableShops: allShops.forEach((s) =>
            console.log(`  ${s.id} - ${s.name}`)
          ),
        },
        "usage: pnpm dev <shopId> [count]"
      );
    }

    process.exit(0);
  }

  for (let i = 0; i < count; i++) {
    await produceEvent(shopId);
  }

  logger.info({ count }, `Produced event(s)`);

  process.exit(0);
}

main().catch(console.error);
