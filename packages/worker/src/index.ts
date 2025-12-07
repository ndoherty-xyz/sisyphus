import { Worker, Job } from "bullmq";
import {
  db,
  events,
  webhookRegistrations,
  deliveryAttempts,
  redisConnection,
  WEBHOOK_QUEUE,
  type WebhookJobData,
} from "@sisyphus/shared";
import { eq } from "drizzle-orm";

async function processWebhook(job: Job<WebhookJobData>) {
  const { eventId, shopId, registrationId } = job.data;

  console.log(`processing job ${job.id} for event ${eventId}`);

  const [event] = await db.select().from(events).where(eq(events.id, eventId));

  if (!event) {
    console.error(`event ${eventId} not found, skipping`);
    return;
  }

  const [registration] = await db
    .select()
    .from(webhookRegistrations)
    .where(eq(webhookRegistrations.id, registrationId));

  // registration not found, skip
  if (!registration) {
    console.warn(
      `received job for event ${event.id} but registration ${registrationId} doesn't exist - skipping`
    );
    return;
  }

  if (!registration.events.includes(event.eventType)) {
    // should not happen, producer should not add to the queue. warn
    console.warn(
      `received job for event type ${event.eventType} but registration ${registration.id} doesn't subscribe to it - skipping`
    );
    return;
  }

  await deliverWebhook(event, registration);
}

async function deliverWebhook(
  event: typeof events.$inferSelect,
  registration: typeof webhookRegistrations.$inferSelect
) {
  console.log(`delivering to ${registration.targetUrl}`);

  // create delivery attempt record first (pending state)
  const [attempt] = await db
    .insert(deliveryAttempts)
    .values({
      eventId: event.id,
      webhookRegistrationId: registration.id,
      status: "pending",
      attempts: 1,
    })
    .returning();

  try {
    const payload = {
      id: event.id,
      type: event.eventType,
      shopId: event.shopId,
      createdAt: event.createdAt,
      data: event.payload,
    };

    const response = await fetch(registration.targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-ID": event.id,
        "X-Webhook-Type": event.eventType,
      },
      body: JSON.stringify(payload),
    });

    await db
      .update(deliveryAttempts)
      .set({
        status: response.ok ? "success" : "failed",
        responseCode: response.status,
        responseBody: await response.text(),
        lastAttemptAt: new Date(),
      })
      .where(eq(deliveryAttempts.id, attempt.id));

    if (response.ok) {
      console.log(`delivered successfully to ${registration.targetUrl}`);
    } else {
      console.log(`delivery failed with status ${response.status}`);
    }
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "unknown error";

    await db
      .update(deliveryAttempts)
      .set({
        status: "failed",
        responseBody: errMessage,
        lastAttemptAt: new Date(),
      })
      .where(eq(deliveryAttempts.id, attempt.id));

    console.error(`delivery error: ${errMessage}`);
  }
}

const worker = new Worker<WebhookJobData>(WEBHOOK_QUEUE, processWebhook, {
  connection: redisConnection,
});

worker.on("completed", (job) => {
  console.log(`job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`job ${job?.id} failed:`, err.message);
});

console.log("worker started, waiting for jobs...");
