// Shared helper for chat-scoped character mention cache entries.

const CHARACTER_CACHE_TTL_MS = 5 * 60 * 1000;

function getCharacterCache(characterCacheByChat, chatId) {
  if (!chatId) return null;
  let cache = characterCacheByChat.get(chatId);
  if (!cache) {
    cache = { chatId, entries: [], expiresAt: 0 };
    characterCacheByChat.set(chatId, cache);
  }
  return cache;
}

module.exports = {
  CHARACTER_CACHE_TTL_MS,
  getCharacterCache,
};
