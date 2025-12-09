import { eq } from "drizzle-orm";
import { db, events, webhookRegistrations } from "../db";
import { WebhookJobData } from "../types";
import { redis } from "./connection";
import { ACTIVE_SHOP_QUEUES_KEY, getOrCreateShopQueue } from "./shopQueues";
import {
  checkGlobalBackpressureAndUpdateIfStale,
  checkTenantQueueBackpressure,
} from "./backpressure";
import pino from "pino";
import { sharedLogger } from "../logging";

async function addEventToShopQueue(
  event: WebhookJobData,
  logger: pino.BaseLogger = sharedLogger
) {
  const queue = getOrCreateShopQueue(event.shopId);
  await queue.add("webhook-delivery", event);
  await redis.sadd(ACTIVE_SHOP_QUEUES_KEY, event.shopId);

  logger.info(
    {
      eventId: event.eventId,
      registrationId: event.registrationId,
      shopId: event.shopId,
    },
    "Added job to shop queue"
  );
}

export async function addEventToQueue(
  event: Omit<typeof events.$inferSelect, "createdAt" | "queuedAt">,
  logger: pino.BaseLogger = sharedLogger
) {
  if (await checkGlobalBackpressureAndUpdateIfStale()) {
    logger.warn(
      {
        eventId: event.id,
        shopId: event.shopId,
      },
      "Global backpressure mode active, skipping queueing for event"
    );
    return;
  }

  if (await checkTenantQueueBackpressure(event.shopId)) {
    logger.warn(
      {
        eventId: event.id,
        shopId: event.shopId,
      },
      "Tenant backpressure mode active, skipping queueing for event"
    );
    return;
  }

  const registrations = await db
    .select()
    .from(webhookRegistrations)
    .where(eq(webhookRegistrations.shopId, event.shopId))
    .execute();

  const registrationsWithEventType = registrations.filter((reg) =>
    reg.events.includes(event.eventType)
  );

  await Promise.all(
    registrationsWithEventType.map((reg) =>
      addEventToShopQueue(
        {
          eventId: event.id,
          shopId: reg.shopId,
          registrationId: reg.id,
        },
        logger
      )
    )
  );

  logger.info(
    {
      eventId: event.id,
      eventType: event.eventType,
      shopId: event.shopId,
      registrationIds: registrationsWithEventType.map((reg) => reg.id),
    },
    "Added event to queue for all registrations with event type"
  );

  // update event's queued_at
  await db
    .update(events)
    .set({ queuedAt: new Date() })
    .where(eq(events.id, event.id));
}
