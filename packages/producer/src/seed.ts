import {
  db,
  shops,
  webhookRegistrations,
  events,
  deliveryAttempts,
} from "@sisyphus/shared";
import { randomBytes } from "crypto";

async function seed() {
  console.log("clearing existing data...");

  await db.delete(deliveryAttempts);
  await db.delete(events);
  await db.delete(webhookRegistrations);
  await db.delete(shops);

  console.log("seeding database...");

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

  await db.insert(webhookRegistrations).values([
    {
      shopId: shop1.id,
      targetUrl: "http://localhost:3001/webhook?name=acme-primary",
      events: ["order.created", "order.updated"],
      secret: randomBytes(32).toString("hex"),
    },
    {
      shopId: shop1.id,
      targetUrl: "http://localhost:3001/webhook?name=acme-secondary",
      events: ["order.created", "order.updated"],
      secret: randomBytes(32).toString("hex"),
    },
    {
      shopId: shop2.id,
      targetUrl: "http://localhost:3001/webhook?name=widget",
      events: ["order.created"],
      secret: randomBytes(32).toString("hex"),
    },
    {
      shopId: shop3.id,
      targetUrl: "http://localhost:3001/webhook?name=gadget-good",
      events: ["order.created", "order.cancelled"],
      secret: randomBytes(32).toString("hex"),
    },
    {
      shopId: shop3.id,
      targetUrl:
        "http://localhost:3001/webhook?name=gadget-flaky&fail_rate=0.5",
      events: ["order.created"],
      secret: randomBytes(32).toString("hex"),
    },
  ]);

  console.log("created webhook registrations");
  console.log(
    "\nshop1 (Acme Corp):",
    shop1.id,
    "- 2 registrations, both get order.created + order.updated"
  );
  console.log(
    "shop2 (Widget World):",
    shop2.id,
    "- 1 registration, only order.created"
  );
  console.log(
    "shop3 (Gadget Galaxy):",
    shop3.id,
    "- 2 registrations, one will fail 50% of the time"
  );
  console.log("\ndone!");

  process.exit(0);
}

seed().catch(console.error);
