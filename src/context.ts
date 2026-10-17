import { AsyncLocalStorage } from "node:async_hooks";

export type Role = "owner" | "member";

/** Everything a request needs to act as one user. Canvas calls read their credentials from here. */
export type UserContext = {
  key: string;
  role: Role;
  timezone: string;
  canvasUrl: string;
  canvasToken: string;
};

const als = new AsyncLocalStorage<UserContext>();

export const runWithContext = <T>(ctx: UserContext, fn: () => T): T => als.run(ctx, fn);
export const currentContext = (): UserContext | undefined => als.getStore();

export function requireContext(): UserContext {
  const c = als.getStore();
  if (!c) throw new Error("no user context (Canvas calls must run inside runWithContext)");
  return c;
}
