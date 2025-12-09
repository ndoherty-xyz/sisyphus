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
  createLogger,
  recordAttempt,
  recordAttemptSuccess,
  recordDeliveryMarkedDead,
  recordDeliverySuccess,
  recordE2ELatency,
} from "@sisyphus/shared";
import { and, eq } from "drizzle-orm";

const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
const logger = createLogger(`worker-${workerId}`);

async function processWebhook(
  job: Job<WebhookJobData>,
  token: string | undefined
) {
  const { eventId, registrationId } = job.data;

  logger.info({ eventId, registrationId }, "Processing job");

  const circuitOpen = await redis.exists(`circuit:open:${registrationId}`);
  if (circuitOpen === 1) {
    await job.moveToDelayed(Date.now() + CIRCUIT_COOLDOWN_MS, token);
    logger.info({ eventId, registrationId }, "Circuit open, delaying job");
    throw new DelayedError(`circuit open for ${registrationId}, delaying job`);
  }

  const [event] = await db.select().from(events).where(eq(events.id, eventId));

  if (!event) {
    logger.error(
      { eventId, registrationId },
      `Event ${eventId} not found, skipping`
    );
    return;
  }

  const [registration] = await db
    .select()
    .from(webhookRegistrations)
    .where(eq(webhookRegistrations.id, registrationId));

  // registration not found, skip
  if (!registration) {
    logger.warn(
      { eventId, registrationId },
      `Registration ${registrationId} doesn't exist - skipping`
    );
    return;
  }

  if (!registration.events.includes(event.eventType)) {
    // should not happen, producer should not add to the queue. warn
    logger.warn(
      { eventId, registrationId },
      `Received event type ${event.eventType} but registration doesn't subscribe to it - skipping`
    );
    return;
  }

  await deliverWebhook(event, registration);
}

async function deliverWebhook(
  event: typeof events.$inferSelect,
  registration: typeof webhookRegistrations.$inferSelect
) {
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
  const timeBeforeFetch = Date.now();
  try {
    recordAttempt();
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

    logger.warn(
      {
        eventId: event.id,
        registrationId: registration.id,
        shopId: event.shopId,
        targetUrl: registration.targetUrl,
        attempt: newAttempts,
        maxAttempts: MAX_RETRIES,
        latencyMs: Date.now() - timeBeforeFetch,
        error: {
          name: error instanceof Error ? error.name : "Unexpected error",
          message: error instanceof Error ? error.message : "Unexpected error",
        },
      },
      newAttempts === MAX_RETRIES
        ? "Delivery error, max retries used. Moved to dead"
        : `Delivery error`
    );

    throw new Error(`delivery error: ${errMessage}`);
  }

  const newAttempts = attempt.attempts + 1;
  const latencyMS = Date.now() - timeBeforeFetch;

  if (!response.ok) {
    const moveToDead = newAttempts === MAX_RETRIES;
    await db
      .update(deliveryAttempts)
      .set({
        status: moveToDead ? "dead" : "failed",
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

    logger.warn(
      {
        eventId: event.id,
        registrationId: registration.id,
        shopId: event.shopId,
        responseCode: response.status,
        targetUrl: registration.targetUrl,
        attempt: newAttempts,
        maxAttempts: MAX_RETRIES,
        latencyMs: latencyMS,
      },
      moveToDead
        ? "Delivery failed, max retries used. Moved to dead"
        : `Delivery failed`
    );

    if (moveToDead) {
      recordDeliveryMarkedDead();
      recordE2ELatency(Date.now() - event.createdAt.getTime());
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

    recordAttemptSuccess();
    recordDeliverySuccess();
    recordE2ELatency(Date.now() - event.createdAt.getTime());
  }

  logger.info(
    {
      eventId: event.id,
      registrationId: registration.id,
      shopId: event.shopId,
      responseCode: response.status,
      targetUrl: registration.targetUrl,
      attempt: newAttempts,
      maxAttempts: MAX_RETRIES,
      latencyMs: latencyMS,
    },
    `Delivered successfully`
  );
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
  await redis.set(
    `circuit:open:${registrationId}`,
    "1",
    "EX",
    CIRCUIT_COOLDOWN_MS / 1000
  );
  logger.warn({ registrationId }, `Circuit breaker tripped`);
}

async function runWorker() {
  logger.info("Started, waiting for jobs");

  let currentIteration = 0;
  const workerToken = workerId;

  while (true) {
    const activeShops = await redis.smembers(ACTIVE_SHOP_QUEUES_KEY);
    if (activeShops.length === 0) {
      // simple sleep while waiting for active jobs
      await new Promise((resolve) => setTimeout(resolve, 1000));
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
      currentIteration++;
      continue;
    } else {
      updateLatestActivityForWorker(shopId, Date.now());

      try {
        const result = await processWebhook(job, workerToken);
        await job.moveToCompleted(result, workerToken, false);
      } catch (e: unknown) {
        if (e instanceof DelayedError) {
          // skip, this job has been delayed
          currentIteration++;
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
