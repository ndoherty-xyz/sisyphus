import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  text,
  jsonb,
  integer,
  boolean,
  pgEnum,
} from "drizzle-orm/pg-core";

export const deliveryStatusEnum = pgEnum("delivery_status", [
  "pending",
  "success",
  "failed",
  "dead",
]);

export const shops = pgTable("shops", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const webhookRegistrations = pgTable("webhook_registrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id")
    .references(() => shops.id)
    .notNull(),
  targetUrl: text("target_url").notNull(),
  events: text("events").array().notNull(),
  secret: varchar("secret", { length: 64 }).notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id")
    .references(() => shops.id)
    .notNull(),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const deliveryAttempts = pgTable("delivery_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id")
    .references(() => events.id)
    .notNull(),
  webhookRegistrationId: uuid("webhook_registration_id")
    .references(() => webhookRegistrations.id)
    .notNull(),
  status: deliveryStatusEnum("status").default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  lastAttemptAt: timestamp("last_attempt_at"),
  nextRetryAt: timestamp("next_retry_at"),
  responseCode: integer("response_code"),
  responseBody: text("response_body"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
