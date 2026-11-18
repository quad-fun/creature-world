// Persistence. Upstash Redis when configured (needed on Vercel, where each request may
// run on a different instance); otherwise an in-memory store for local development.
import { Redis } from "@upstash/redis";
import { migrate } from "./migrate";
import type { InboxItem, World } from "./types";

export interface Store {
  kind: "redis" | "memory";
  load(): Promise<World | null>;
  save(w: World): Promise<void>;
  lock(ttlSeconds: number): Promise<boolean>;
  unlock(): Promise<void>;
  /** Visitors drop things here; the tick engine drains it under the lock. */
  pushInbox(item: InboxItem): Promise<void>;
  drainInbox(): Promise<InboxItem[]>;
  /** Fixed-window rate limit. True when the call is within the limit. */
  hit(key: string, limit: number, windowS: number): Promise<boolean>;
}

const WORLD_KEY = "cw:world:v1";
const LOCK_KEY = "cw:lock";
const INBOX_KEY = "cw:inbox";
const INBOX_MAX = 200;

function redisFromEnv(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

type MemoryGlobal = { world: World | null; lockUntil: number; inbox: InboxItem[]; hits: Map<string, { n: number; until: number }> };
const g = globalThis as unknown as { __cw?: MemoryGlobal };

export function getStore(): Store {
  const redis = redisFromEnv();
  if (redis) {
    return {
      kind: "redis",
      load: async () => {
        const w = await redis.get<World>(WORLD_KEY);
        return w ? migrate(w) : null;
      },
      save: async (w) => {
        await redis.set(WORLD_KEY, w);
      },
      lock: async (ttl) => (await redis.set(LOCK_KEY, "1", { nx: true, ex: ttl })) === "OK",
      unlock: async () => {
        await redis.del(LOCK_KEY);
      },
      pushInbox: async (item) => {
        const n = await redis.rpush(INBOX_KEY, JSON.stringify(item));
        if (n > INBOX_MAX) await redis.ltrim(INBOX_KEY, -INBOX_MAX, -1);
      },
      drainInbox: async () => {
        const raw = await redis.lrange(INBOX_KEY, 0, 49);
        if (!raw.length) return [];
        await redis.ltrim(INBOX_KEY, raw.length, -1);
        return raw.map((x) => (typeof x === "string" ? JSON.parse(x) : x) as InboxItem);
      },
      hit: async (key, limit, windowS) => {
        const k = `cw:rl:${key}`;
        const n = await redis.incr(k);
        if (n === 1) await redis.expire(k, windowS);
        return n <= limit;
      },
    };
  }
  const mem: MemoryGlobal = (g.__cw ??= { world: null, lockUntil: 0, inbox: [] as InboxItem[], hits: new Map() } as MemoryGlobal);
  return {
    kind: "memory",
    load: async () => (mem.world ? migrate(structuredClone(mem.world)) : null),
    save: async (w) => {
      mem.world = structuredClone(w);
    },
    lock: async (ttl) => {
      if (Date.now() < mem.lockUntil) return false;
      mem.lockUntil = Date.now() + ttl * 1000;
      return true;
    },
    unlock: async () => {
      mem.lockUntil = 0;
    },
    pushInbox: async (item) => {
      mem.inbox.push(item);
      if (mem.inbox.length > INBOX_MAX) mem.inbox.shift();
    },
    drainInbox: async () => mem.inbox.splice(0, 50),
    hit: async (key, limit, windowS) => {
      const now = Date.now();
      const e = mem.hits.get(key);
      if (!e || e.until < now) {
        mem.hits.set(key, { n: 1, until: now + windowS * 1000 });
        return 1 <= limit;
      }
      e.n++;
      return e.n <= limit;
    },
  };
}
