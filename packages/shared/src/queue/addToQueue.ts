import { eq } from "drizzle-orm";
import { db, events, webhookRegistrations } from "../db";
import { WebhookJobData } from "../types";
import { redis } from "./connection";
import { ACTIVE_SHOP_QUEUES_KEY, getOrCreateShopQueue } from "./shopQueues";

async function addEventToShopQueue(event: WebhookJobData) {
  const queue = getOrCreateShopQueue(event.shopId);
  await queue.add("webhook-delivery", event);
  await redis.sadd(ACTIVE_SHOP_QUEUES_KEY, event.shopId);
  console.log(
    `queued job for event ${event.eventId}, shop ${event.shopId} and registration ${event.registrationId}`
  );
}

export async function addEventToQueue(
  event: Omit<typeof events.$inferSelect, "createdAt" | "queuedAt">
) {
  const registrations = await db
    .select()
    .from(webhookRegistrations)
    .where(eq(webhookRegistrations.shopId, event.shopId))
    .execute();

  await Promise.all(
    registrations
      .filter((reg) => reg.events.includes(event.eventType))
      .map((reg) =>
        addEventToShopQueue({
          eventId: event.id,
          shopId: reg.shopId,
          registrationId: reg.id,
        })
      )
  );

  // update event's queued_at
  await db
    .update(events)
    .set({ queuedAt: new Date() })
    .where(eq(events.id, event.id));
}
