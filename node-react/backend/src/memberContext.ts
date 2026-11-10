// Which app user an STX call is being made for, so an activity row written deep
// inside it (the token endpoint, which the SDK reaches on its own to redeem,
// refresh or revoke) can be tagged with its member and shown only to them.
//
// `asMember` runs a call, and everything it starts (a retry, a token refresh, a
// live feed's later reconnects), as that member; `currentMember` reads it back.

import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<string>();

// A member row whose member is not known. Nobody's session matches it, so it is
// listed and shown to no one: better hidden than public.
export const UNKNOWN_MEMBER = "unknown-member";

export function asMember<T>(userId: string, fn: () => T): T {
  return scope.run(userId, fn);
}

export function currentMember(): string | null {
  return scope.getStore() ?? null;
}

// `client` with every method call made as `userId`.
export function actingAs<T extends object>(userId: string, client: T): T {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => asMember(userId, () => value.apply(target, args));
    },
  });
}
