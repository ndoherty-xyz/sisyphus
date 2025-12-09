import { redis } from "../queue/connection";

export const METRICS_ATTEMPT_KEY = "metrics:attempts:total";
export const METRICS_ATTEMPT_SUCCESS_KEY = "metrics:attempts:success";

export const METRICS_DELIVERY_SUCCESS_KEY = "metrics:deliveries:success";
export const METRICS_DELIVERY_DEAD_KEY = "metrics:deliveries:dead";

const MAX_LATENCY_SAMPLES = 100;
export const METRICS_LATENCY_SAMPLES_KEY = "metrics:latency:e2e";

export async function recordAttempt() {
  await redis.incr(METRICS_ATTEMPT_KEY);
}

export async function recordAttemptSuccess() {
  await redis.incr(METRICS_ATTEMPT_SUCCESS_KEY);
}

export async function recordDeliverySuccess() {
  await redis.incr(METRICS_DELIVERY_SUCCESS_KEY);
}

export async function recordDeliveryMarkedDead() {
  await redis.incr(METRICS_DELIVERY_DEAD_KEY);
}

export async function recordE2ELatency(latencyMs: number) {
  await redis.lpush(METRICS_LATENCY_SAMPLES_KEY, latencyMs);
  await redis.ltrim(METRICS_LATENCY_SAMPLES_KEY, 0, MAX_LATENCY_SAMPLES - 1);
}

export async function getAttemptCounts() {
  const total = await redis.get(METRICS_ATTEMPT_KEY);
  const success = await redis.get(METRICS_ATTEMPT_SUCCESS_KEY);

  return {
    total: parseInt(total ?? "0"),
    success: parseInt(success ?? "0"),
  };
}

export async function getDeliveryCounts() {
  const success = await redis.get(METRICS_DELIVERY_SUCCESS_KEY);
  const dead = await redis.get(METRICS_DELIVERY_DEAD_KEY);

  return {
    dead: parseInt(dead ?? "0"),
    success: parseInt(success ?? "0"),
  };
}

export async function getE2ELatencyStats() {
  const values = await redis.lrange(METRICS_LATENCY_SAMPLES_KEY, 0, -1);
  const nums = values.map(Number);

  return {
    average: nums.reduce((a, b) => a + b, 0) / nums.length,
    max: nums.length === 0 ? 0 : Math.max(...nums),
  };
}

export async function clearMetrics() {
  await redis.del(
    METRICS_ATTEMPT_KEY,
    METRICS_ATTEMPT_SUCCESS_KEY,
    METRICS_DELIVERY_SUCCESS_KEY,
    METRICS_DELIVERY_DEAD_KEY,
    METRICS_LATENCY_SAMPLES_KEY
  );
}
