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
  /** Minimal key-value primitives for the credits ledger (src/lib/credits). Not used by the world. */
  kv: Kv;
}

export interface Kv {
  get(key: string): Promise<string | null>;
  /** Set only if absent. True when this call created the key. */
  setnx(key: string, value: string): Promise<boolean>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  incrby(key: string, n: number): Promise<number>;
  rpush(key: string, value: string): Promise<void>;
  /** Newest-last slice; negative indices count from the end like Redis. */
  lrange(key: string, start: number, stop: number): Promise<string[]>;
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

type MemoryGlobal = {
  world: World | null;
  lockUntil: number;
  inbox: InboxItem[];
  hits: Map<string, { n: number; until: number }>;
  kv?: Map<string, string>;
  lists?: Map<string, string[]>;
};
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
      kv: {
        get: async (k) => {
          const v = await redis.get<unknown>(`cw:kv:${k}`);
          return v == null ? null : typeof v === "string" ? v : JSON.stringify(v);
        },
        setnx: async (k, v) => (await redis.set(`cw:kv:${k}`, v, { nx: true })) === "OK",
        set: async (k, v) => {
          await redis.set(`cw:kv:${k}`, v);
        },
        del: async (k) => {
          await redis.del(`cw:kv:${k}`);
        },
        incrby: async (k, n) => redis.incrby(`cw:kv:${k}`, n),
        rpush: async (k, v) => {
          await redis.rpush(`cw:kv:${k}`, v);
        },
        lrange: async (k, a, b) => (await redis.lrange(`cw:kv:${k}`, a, b)).map((x) => (typeof x === "string" ? x : JSON.stringify(x))),
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
    kv: memKv(mem),
  };
}

function memKv(mem: MemoryGlobal): Kv {
  const m = (mem.kv ??= new Map<string, string>());
  const l = (mem.lists ??= new Map<string, string[]>());
  return {
    get: async (k) => m.get(k) ?? null,
    setnx: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
    set: async (k, v) => void m.set(k, v),
    del: async (k) => void m.delete(k),
    incrby: async (k, n) => {
      const v = Number(m.get(k) ?? 0) + n;
      m.set(k, String(v));
      return v;
    },
    rpush: async (k, v) => void (l.get(k) ?? l.set(k, []).get(k)!).push(v),
    lrange: async (k, a, b) => {
      const arr = l.get(k) ?? [];
      const from = a < 0 ? Math.max(0, arr.length + a) : a;
      const to = b < 0 ? arr.length + b : b;
      return arr.slice(from, to + 1);
    },
  };
}
