import { db, shops, webhookRegistrations } from "@sisyphus/shared";
import { randomBytes } from "crypto";

async function seed() {
  console.log("seeding database...");

  // create test shops
  const [shop1] = await db
    .insert(shops)
    .values({ name: "Acme Corp" })
    .returning();
  const [shop2] = await db
    .insert(shops)
    .values({ name: "Widget World" })
    .returning();
  const [shop3] = await db
    .insert(shops)
    .values({ name: "Gadget Galaxy" })
    .returning();

  console.log("created shops:", shop1.id, shop2.id, shop3.id);

  // register webhooks - pointing at our local receiver
  await db.insert(webhookRegistrations).values([
    {
      shopId: shop1.id,
      targetUrl: "http://localhost:3001/webhook",
      events: ["order.created", "order.updated"],
      secret: randomBytes(32).toString("hex"),
    },
    {
      shopId: shop2.id,
      targetUrl: "http://localhost:3001/webhook",
      events: ["order.created"],
      secret: randomBytes(32).toString("hex"),
    },
    {
      shopId: shop3.id,
      targetUrl: "http://localhost:3001/webhook",
      events: ["order.created", "order.cancelled"],
      secret: randomBytes(32).toString("hex"),
    },
  ]);

  console.log("created webhook registrations");
  console.log("\ndone! you can now run: pnpm dev <shopId>");

  process.exit(0);
}

seed().catch(console.error);
