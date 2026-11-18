// Own-property lookup for maps keyed by outside strings. `world.creatures["constructor"]` or `["__proto__"]` would
// otherwise find Object.prototype members and be treated as a creature.
export function own<T>(map: Record<string, T> | undefined, key: unknown): T | undefined {
  return map && typeof key === "string" && Object.hasOwn(map, key) ? map[key] : undefined;
}
