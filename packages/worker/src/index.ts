import { Job, DelayedError } from "bullmq";
import {
  db,
  events,
  webhookRegistrations,
  deliveryAttempts,
  MAX_RETRIES,
  redis,
  type WebhookJobData,
  CIRCUIT_COOLDOWN_MS,
  CIRCUIT_TIME_LIMIT_MS,
  CIRCUIT_ERROR_LIMIT,
  ACTIVE_SHOP_QUEUES_KEY,
  getOrCreateShopWorker,
  getOrCreateShopQueue,
  updateLatestActivityForWorker,
  cleanupStaleWorkers,
} from "@sisyphus/shared";
import { and, eq, gt, or } from "drizzle-orm";

async function processWebhook(
  job: Job<WebhookJobData>,
  token: string | undefined
) {
  const { eventId, shopId, registrationId } = job.data;

  console.log(`processing job ${job.id} for event ${eventId}`);

  const circuitOpen = await redis.exists(`circuit:open:${registrationId}`);
  if (circuitOpen === 1) {
    await job.moveToDelayed(Date.now() + CIRCUIT_COOLDOWN_MS, token);
    console.log(`circuit open for ${registrationId}, delaying job`);
    throw new DelayedError(`circuit open for ${registrationId}, delaying job`);
  }

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

  let attempt: typeof deliveryAttempts.$inferSelect;

  const existingAttempt = await db.query.deliveryAttempts.findFirst({
    where: and(
      eq(deliveryAttempts.eventId, event.id),
      eq(deliveryAttempts.webhookRegistrationId, registration.id)
    ),
  });

  if (existingAttempt) {
    attempt = existingAttempt;
  } else {
    // create delivery attempt record first (pending state)
    const [newAttempt] = await db
      .insert(deliveryAttempts)
      .values({
        eventId: event.id,
        webhookRegistrationId: registration.id,
        status: "pending",
        attempts: 0,
      })
      .returning();
    attempt = newAttempt;
  }

  const payload = {
    id: event.id,
    type: event.eventType,
    shopId: event.shopId,
    createdAt: event.createdAt,
    data: event.payload,
  };

  let response: Response;
  try {
    response = await fetch(registration.targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-ID": event.id,
        "X-Webhook-Type": event.eventType,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "unknown error";
    const newAttempts = attempt.attempts + 1;

    await db
      .update(deliveryAttempts)
      .set({
        status: newAttempts === MAX_RETRIES ? "dead" : "failed",
        responseBody: errMessage,
        lastAttemptAt: new Date(),
        attempts: newAttempts,
      })
      .where(eq(deliveryAttempts.id, attempt.id));

    const recentFailCount = await incrementFailCount(registration.id);
    if (recentFailCount >= CIRCUIT_ERROR_LIMIT) {
      await openCircuitForRegistration(registration.id);
    }

    throw new Error(`delivery error: ${errMessage}`);
  }

  const newAttempts = attempt.attempts + 1;

  if (!response.ok) {
    await db
      .update(deliveryAttempts)
      .set({
        status: newAttempts === MAX_RETRIES ? "dead" : "failed",
        responseCode: response.status,
        responseBody: await response.text(),
        lastAttemptAt: new Date(),
        attempts: newAttempts,
      })
      .where(eq(deliveryAttempts.id, attempt.id));

    const recentFailCount = await incrementFailCount(registration.id);
    if (recentFailCount >= CIRCUIT_ERROR_LIMIT) {
      await openCircuitForRegistration(registration.id);
    }

    throw new Error(`delivery failed with status ${response.status}`);
  } else {
    await db
      .update(deliveryAttempts)
      .set({
        status: "success",
        responseCode: response.status,
        responseBody: await response.text(),
        lastAttemptAt: new Date(),
        attempts: newAttempts,
      })
      .where(eq(deliveryAttempts.id, attempt.id));
  }
  console.log(`delivered successfully to ${registration.targetUrl}`);
}

async function incrementFailCount(registrationId: string): Promise<number> {
  const failCount = await redis.incr(`circuit:failures:${registrationId}`);
  const ttl = await redis.ttl(`circuit:failures:${registrationId}`);
  if (ttl === -1) {
    await redis.expire(
      `circuit:failures:${registrationId}`,
      CIRCUIT_TIME_LIMIT_MS / 1000
    );
  }

  return failCount;
}

async function openCircuitForRegistration(registrationId: string) {
  console.log(`circuit breaker tripped for registration ${registrationId}`);
  await redis.set(
    `circuit:open:${registrationId}`,
    "1",
    "EX",
    CIRCUIT_COOLDOWN_MS / 1000
  );
}

async function runWorker() {
  console.log("worker started, waiting for jobs...");

  let currentIteration = 0;
  const workerToken = "worker-1"; // will need to update token for multiple workers

  while (true) {
    const activeShops = await redis.smembers(ACTIVE_SHOP_QUEUES_KEY);

    if (activeShops.length === 0) {
      // simple sleep while waiting for active jobs
      await new Promise((resolve) => setTimeout(resolve, 2500));
      continue;
    }

    const shopId = activeShops[currentIteration % activeShops.length];
    const worker = getOrCreateShopWorker(shopId);
    let job = await worker.getNextJob(workerToken, {});

    if (!job) {
      const queue = getOrCreateShopQueue(shopId);
      const counts = await queue.getJobCounts("waiting", "active", "delayed");
      if (counts.waiting === 0 && counts.active === 0 && counts.delayed === 0) {
        await redis.srem(ACTIVE_SHOP_QUEUES_KEY, shopId);
      }
      continue;
    } else {
      updateLatestActivityForWorker(shopId, Date.now());

      try {
        const result = await processWebhook(job, workerToken);
        await job.moveToCompleted(result, workerToken, false);
      } catch (e: unknown) {
        if (e instanceof DelayedError) {
          // skip, this job has been delayed
          continue;
        } else {
          const err =
            e instanceof Error
              ? e
              : new Error(`Job ${job.id} failed unexpectedly`);
          await job.moveToFailed(err, workerToken, false);
        }
      }
    }

    // run cleanup every 100 iterations
    if (currentIteration % 100 === 0) {
      cleanupStaleWorkers();
    }

    currentIteration++;
  }
}

runWorker();
