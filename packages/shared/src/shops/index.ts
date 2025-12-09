import { db, shops } from "../db";

export async function getAllShops() {
  return db.select().from(shops);
}
