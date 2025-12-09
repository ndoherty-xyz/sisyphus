![Kapture 2025-12-09 at 14 16 40](https://github.com/user-attachments/assets/45db59fa-5f89-4d3d-be7e-67110f6860ca)

# Sisyphus

A multi-tenant webhook delivery system demonstrating distributed systems concepts: job queues, failure handling, fairness, and backpressure.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  ┌──────────┐      ┌──────────┐      ┌─────────────┐      ┌──────────┐  │
│  │ Producer │─────▶│  Redis   │─────▶│  Worker(s)  │─────▶│ Receiver │  │
│  └────┬─────┘      │ (queues) │      └────┬────────┘      └──────────┘  │
│       │            └────▲─────┘           │                             │
│       │                 │                 │                             │
│       │            ┌────┴─────┐           │                             │
│       │            │  Drain   │           │                             │
│       │            └────┬─────┘           │                             │
│       │                 │                 │                             │
│       ▼                 ▼                 ▼                             │
│  ┌─────────────────────────────────────────────┐                        │
│  │                  Postgres                   │                        │
│  │  (events, registrations, delivery_attempts) │                        │
│  └─────────────────────────────────────────────┘                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Components:**

- **Postgres** - persistent storage for shops, webhook registrations, events, and delivery attempts
- **Redis** - queue backend (BullMQ) + operational state (circuit breakers, backpressure flags)
- **Producer** - CLI that generates events and queues delivery jobs
- **Worker** - processes jobs with round-robin fairness across tenants
- **Drain Service** - recovers unqueued events after backpressure clears
- **Mock Receivers** - Express endpoints with configurable failure/latency for testing
- **Dashboard** - terminal UI that orchestrates all services and displays real-time metrics

## Quick Start

```bash
# start postgres and redis
docker-compose up -d

# install dependencies
pnpm install

# seed test data (shops + webhook registrations)
pnpm seed

# run the dashboard (spawns receiver, workers, drain)
pnpm start
```

The dashboard provides keybindings to produce events and observe system behavior:
- `↑`/`↓` - select shop
- `p` - produce 1 event for selected shop
- `f` - flood 50 events (triggers backpressure)
- `q` - quit

## What This Demonstrates

| Concept | Implementation |
|---------|----------------|
| **Job Queues** | BullMQ with Redis, per-tenant queue isolation |
| **Retry Logic** | Exponential backoff with jitter, configurable max attempts |
| **Dead Letter Queue** | Failed deliveries marked as `dead` after exhausting retries |
| **Circuit Breaker** | Per-endpoint failure tracking, open/half-open/closed states |
| **Fairness** | Round-robin processing across tenant queues prevents starvation |
| **Backpressure** | Two-tier admission control (global + per-tenant) with hysteresis |
| **At-Least-Once Delivery** | Events persisted before queueing, drain recovers unqueued events |

## Design Decisions

### Job Granularity

The first naive approach was one job per event, which breaks when a shop has multiple registrations and we retry. If one of the first registrations succeeds, but a second fails, both are retried leading to duplicate deliveries.
The fix to this is that each job is an event/registration pair. The producer only queues events for matching registrations. The tradeoff is more jobs in the queue, but the retries are scoped to specific endpoints.

### Per-Tenant Queues with Round-Robin

This implementation does round-robin fairness on the tenant queues. Each shop has it's own queue with a set of active queues in Redis. The worker queries this active queue set and pulls a job from the next queue in rotation.
There are other models to implement tenant fairness, but per-tenant queues won due to the extremely simple mental model, each queue gets it's turn. The cost is more Redis keys and having to manage the job lifecycle ourself instead of relying on BullMQ's built in logic.

### Circuit Breaker State

There is a circuit breaker implementation to delay jobs if an endpoint hiccups, fast failing jobs and delaying them for a cooldown. This is stored in Redis, using the TTL as the cooldown period & handling of state transitions. We track a failure counter that incremements on each failed delivery for a registration, and if it hits the limit, it triggers the circuit breaker.

This could be stored in Postgres, but it's an operational state that does not need to be persisted.

### Handling Backpressure

The system has two tiers of backpressure handling: global & per-tenant. Global backpressure handling protects the system as a whole, while per-tenant backpressure ensures that we don't have one tenant trigger system wide backpresure.

This check happens on the producer side, if we are in backpressure globally or for that tenant, the event is saved to the database with `queued_at=null` for it to be picked up later by the backpressure drain system.

### Drain service

The drain system is to queue back the pending events (skipped due to backpressure) while maintaining the fairness of the system. It implements the same round-robin fairness as the workers for pending events and owns checking  & updating global backpressure state.

This is it's own system for separation of concerns, the producer accepts the events, the worker deliver, and the drain's job is recovery.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20+ |
| Language | TypeScript |
| Queue | BullMQ (Redis-backed) |
| Database | Postgres 15 (Drizzle ORM) |
| Mock Server | Express |
| Dashboard | Ink (React for CLI) |
| Logging | Pino |
| Package Manager | pnpm workspaces |

## Project Structure

```
sisyphus/
├── docker-compose.yml
├── packages/
│   ├── shared/          # db schema, queue helpers, backpressure logic, metrics
│   ├── producer/        # CLI to generate events
│   ├── worker/          # job processor with round-robin fairness
│   ├── drain/           # backpressure recovery service
│   ├── receiver/        # mock webhook endpoints
│   └── dashboard/       # terminal UI (Ink)
```

## Known Improvements

**Smarter drain rate limiting:** Currently the drain queues events until backpressure triggers again, creating a sawtooth pattern. A rate-limited drip (e.g., N events per second) would be smoother and more predictable.

**Proper metrics export:** Redis counters work for the demo, but production would use Prometheus/Grafana for time-series data, alerting, and dashboards.

**Webhook signatures:** HMAC signing of payloads with timestamps to prevent replay attacks. Standard practice for production webhook systems.

**Separate DLQ processing:** Dead letters currently just get marked in the database. A real system would have alerting, manual retry UI, and possibly automatic re-processing after endpoint issues are resolved.

**Rate limiting per endpoint:** Beyond circuit breakers, some endpoints might have rate limits. Respecting those requires tracking request rates and throttling per-registration.
