function normalizeChatMessage(msg) {
  const activeSwipe = msg.swipe_id !== undefined && msg.swipes?.[msg.swipe_id]
    ? msg.swipes[msg.swipe_id]
    : msg.mes;
  return {
    name: msg.name,
    is_user: msg.is_user,
    is_system: msg.is_system || false,
    mes: activeSwipe,
    send_date: msg.send_date,
  };
}

function parseChatJsonl(raw, { characterNameFallback = "Unknown" } = {}) {
  const lines = String(raw || "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) throw new Error("Empty chat file");

  const metadata = JSON.parse(lines[0]);
  const characterName = metadata.character_name || characterNameFallback || "Unknown";
  const userName = metadata.user_name || "User";
  const messages = [];
  let malformed = 0;

  for (let i = 1; i < lines.length; i++) {
    try {
      const msg = JSON.parse(lines[i]);
      if (msg.mes !== undefined && !msg.is_system) messages.push(normalizeChatMessage(msg));
    } catch {
      malformed++;
    }
  }

  return { metadata, characterName, userName, messages, malformed };
}

function buildChatBatches(messages, batchSize) {
  const safeBatchSize = Math.max(1, parseInt(batchSize, 10) || 10);
  const batches = [];
  for (let i = 0; i < messages.length; i += safeBatchSize) {
    batches.push({ batchIdx: i, batch: messages.slice(i, i + safeBatchSize) });
  }
  return batches;
}

module.exports = { parseChatJsonl, buildChatBatches, normalizeChatMessage };
