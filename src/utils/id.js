import { randomBytes, randomUUID } from "node:crypto";

export function createId() {
  return randomUUID();
}

export function createSecret(length = 16) {
  return randomBytes(length).toString("hex");
}
