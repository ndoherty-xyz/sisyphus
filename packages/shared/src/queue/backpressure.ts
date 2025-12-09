import { redis } from "./connection";
import { getGlobalQueueDepth, getShopQueueDepth } from "./shopQueues";

const GLOBAL_BACKPRESSURE_ACTIVE_REDIS_KEY = "backpressure:global:active";
const GLOBAL_BACKPRESSURE_CHECKED_AT_REDIS_KEY =
  "backpressure:global:checkedAt";
const GLOBAL_BACKPRESSURE_STALENESS_MS = 30_000;

const GLOBAL_BACKPRESSURE_DEPTH_TRIGGER = 50;
const GLOBAL_BACKPRESSURE_DEPTH_RESOLUTION =
  GLOBAL_BACKPRESSURE_DEPTH_TRIGGER * 0.5;

const tenantBackpressureRedisKey = (shopId: string) =>
  `backpressure:tenant:${shopId}:active`;
const TENANT_BACKPRESSURE_DEPTH_TRIGGER = 20;
const TENANT_BACKPRESSURE_DEPTH_RESOLUTION =
  TENANT_BACKPRESSURE_DEPTH_TRIGGER * 0.5;

/**
 * function for checking the redis status of global backpressure
 * @returns boolean indicating whether or not backpressure is active
 */
async function isGlobalBackpressureActive(): Promise<boolean> {
  return !!(await redis.exists(GLOBAL_BACKPRESSURE_ACTIVE_REDIS_KEY));
}

/**
 * function for updating the redis status of global backpressure
 * @returns boolean indicating whether or not backpressure is active after this update
 */
export async function updateGlobalBackpressureState(): Promise<boolean> {
  const globalBackPressureActive = await isGlobalBackpressureActive();
  const globalJobDepth = await getGlobalQueueDepth();

  let returnBackpressureStatus = globalBackPressureActive;
  if (
    !globalBackPressureActive &&
    globalJobDepth >= GLOBAL_BACKPRESSURE_DEPTH_TRIGGER
  ) {
    // activate global backpressure mode
    await redis.set(GLOBAL_BACKPRESSURE_ACTIVE_REDIS_KEY, "1");
    returnBackpressureStatus = true;
    console.log("global backpressure activated, depth:", globalJobDepth);
  } else if (
    globalBackPressureActive &&
    globalJobDepth < GLOBAL_BACKPRESSURE_DEPTH_RESOLUTION
  ) {
    // deactivate
    await redis.del(GLOBAL_BACKPRESSURE_ACTIVE_REDIS_KEY);
    returnBackpressureStatus = false;
    console.log("global backpressure deactivated, depth:", globalJobDepth);
  }

  await redis.set(GLOBAL_BACKPRESSURE_CHECKED_AT_REDIS_KEY, Date.now());
  return returnBackpressureStatus;
}

/**
 * function for checking global backpressure status and updating if it's stale
 * @returns boolean indicating whether or not backpressure is active
 */
export async function checkGlobalBackpressureAndUpdateIfStale(): Promise<boolean> {
  const lastCalculated = await redis.get(
    GLOBAL_BACKPRESSURE_CHECKED_AT_REDIS_KEY
  );

  const globalBackPressureActive = await isGlobalBackpressureActive();

  if (
    !lastCalculated ||
    Date.now() - parseInt(lastCalculated) >= GLOBAL_BACKPRESSURE_STALENESS_MS
  ) {
    // stale, update global backpressure state
    return updateGlobalBackpressureState();
  } else {
    // not stale, return cached val
    return globalBackPressureActive;
  }
}

/**
 * function for checking tenant-specific backpressure status
 * @param shopId the id for the tenant shop
 * @returns boolean representing whether or not tenant queue backpressure mode is active
 */
export async function checkTenantQueueBackpressure(
  shopId: string
): Promise<boolean> {
  const tenantBackpressureKey = tenantBackpressureRedisKey(shopId);
  const tenantBackPressureActive = !!(await redis.exists(
    tenantBackpressureKey
  ));
  const tenantJobDepth = await getShopQueueDepth(shopId);

  if (
    !tenantBackPressureActive &&
    tenantJobDepth >= TENANT_BACKPRESSURE_DEPTH_TRIGGER
  ) {
    // activate
    await redis.set(tenantBackpressureKey, "1");
    return true;
  } else if (
    tenantBackPressureActive &&
    tenantJobDepth < TENANT_BACKPRESSURE_DEPTH_RESOLUTION
  ) {
    await redis.del(tenantBackpressureKey);
    return false;
  } else {
    return tenantBackPressureActive;
  }
}
