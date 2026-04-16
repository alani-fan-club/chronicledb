const DB_IDENTITY_QUERY = `SELECT current_user AS u, current_database() AS d`;

function verifyConfiguredDbIdentity(identity, settings, options) {
  const opts = options && typeof options === "object" ? options : {};
  const userMismatchMessage = typeof opts.userMismatchMessage === "function"
    ? opts.userMismatchMessage
    : (actualUser, expectedUser) => `Connected as "${actualUser}" but expected user "${expectedUser}".`;
  const databaseMismatchMessage = typeof opts.databaseMismatchMessage === "function"
    ? opts.databaseMismatchMessage
    : (actualDb, expectedDb) => `Connected to database "${actualDb}" but expected "${expectedDb}".`;

  const expectedUser = (settings.pgUser || "").trim();
  const expectedDb = (settings.pgDatabase || "").trim();

  if (expectedUser && identity.u !== expectedUser) {
    throw new Error(userMismatchMessage(identity.u, expectedUser));
  }
  if (expectedDb && identity.d !== expectedDb) {
    throw new Error(databaseMismatchMessage(identity.d, expectedDb));
  }

  return identity;
}

async function fetchAndVerifyConfiguredDbIdentity(pool, settings, options) {
  const { rows: [identity] } = await pool.query(DB_IDENTITY_QUERY);
  return verifyConfiguredDbIdentity(identity, settings, options);
}

module.exports = {
  DB_IDENTITY_QUERY,
  verifyConfiguredDbIdentity,
  fetchAndVerifyConfiguredDbIdentity,
};
