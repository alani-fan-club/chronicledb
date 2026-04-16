// Shared helper for fixed-size Map state. Evicts the oldest key when full.
function setWithBoundedEviction(map, key, value, maxEntries, options) {
  if (!(map instanceof Map)) {
    throw new TypeError("map must be a Map");
  }

  const max = Number.isFinite(maxEntries)
    ? Math.max(1, Math.floor(maxEntries))
    : 1;
  const opts = options && typeof options === "object" ? options : {};
  const evictOnUpdateAtCapacity = opts.evictOnUpdateAtCapacity === true;
  const onEvict = typeof opts.onEvict === "function" ? opts.onEvict : null;

  const hasKey = map.has(key);
  const shouldEvict = map.size >= max && (!hasKey || evictOnUpdateAtCapacity);
  if (shouldEvict) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
      if (onEvict) onEvict(oldestKey);
    }
  }

  map.set(key, value);
}

module.exports = {
  setWithBoundedEviction,
};
