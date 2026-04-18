// Backend-agnostic Postgres client. Exposes the subset of the
// node-postgres `Pool` API the rest of the plugin uses (`query`,
// `connect`, `on`, `end`) so call sites don't need to know whether
// they're talking to PGlite or a real Postgres server.
//
// PGlite is the default — pure-JS embedded Postgres with pgvector,
// pg_trgm, and btree_gin extensions. Single in-process database under
// $HOME/.chronicledb/pgdata. No install required.
//
// External pg.Pool kicks in when the user has either set
// settings.dbBackend === 'external' or has legacy pgHost settings from
// a pre-migration install. Keeps cloud-DB users (Neon, Supabase) and
// power users with their own Postgres on the same code path.

const { Pool: PgPool } = require("pg");
const path = require("node:path");
const os = require("node:os");

// PGlite ESM imports are loaded lazily on first init so the require
// graph stays CJS-clean and external-Postgres users never pay the
// PGlite import cost.
let _pgliteModules = null;
async function loadPgliteModules() {
  if (_pgliteModules) return _pgliteModules;
  const [pglite, vec, trgm, gin] = await Promise.all([
    import("@electric-sql/pglite"),
    import("@electric-sql/pglite/vector"),
    import("@electric-sql/pglite/contrib/pg_trgm"),
    import("@electric-sql/pglite/contrib/btree_gin"),
  ]);
  _pgliteModules = {
    PGlite: pglite.PGlite,
    vector: vec.vector,
    pg_trgm: trgm.pg_trgm,
    btree_gin: gin.btree_gin,
  };
  return _pgliteModules;
}

class PGliteAdapter {
  constructor(dataDir) {
    this._dataDir = dataDir;
    this._db = null;
    this._initPromise = null;
    this._listeners = { error: [] };
  }

  // First query through any path triggers PGlite init. Subsequent
  // queries hit the warm instance. Init itself takes ~2s on a fresh
  // dataDir (cold pg_init dance), <100ms when reopening an existing
  // one.
  async _ensureInit() {
    if (this._db) return;
    if (!this._initPromise) {
      this._initPromise = (async () => {
        const { PGlite, vector, pg_trgm, btree_gin } = await loadPgliteModules();
        this._db = await PGlite.create({
          dataDir: this._dataDir,
          extensions: { vector, pg_trgm, btree_gin },
        });
      })();
    }
    try {
      await this._initPromise;
    } catch (err) {
      this._initPromise = null;
      for (const h of this._listeners.error) h(err);
      throw err;
    }
  }

  async query(sql, params) {
    await this._ensureInit();
    return this._db.query(sql, params || []);
  }

  // Multi-statement simple-query path. PGlite distinguishes `query`
  // (prepared, single statement) from `exec` (simple-query protocol,
  // multi-statement). Callers loading schema.sql need this.
  async exec(sql) {
    await this._ensureInit();
    return this._db.exec(sql);
  }

  // Mirror pg.Pool.connect(): hand back something with .query() and
  // .release(). PGlite has only one underlying connection so all queries
  // are inherently serialized — BEGIN/COMMIT/ROLLBACK as plain SQL on
  // the same db instance work as a transaction.
  async connect() {
    await this._ensureInit();
    const db = this._db;
    return {
      query: (sql, params) => db.query(sql, params || []),
      release: () => {},
    };
  }

  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
  }

  async end() {
    if (this._db) {
      try { await this._db.close(); } catch (_) { /* ignore */ }
      this._db = null;
    }
    this._initPromise = null;
  }
}

class PgPoolAdapter {
  constructor(config) { this._pool = new PgPool(config); }
  query(sql, params) { return this._pool.query(sql, params); }
  // pg.Pool.query handles multi-statement SQL via the simple query
  // protocol when called with no params — mirror PGlite's exec().
  exec(sql) { return this._pool.query(sql); }
  connect() { return this._pool.connect(); }
  on(event, handler) { return this._pool.on(event, handler); }
  end() { return this._pool.end(); }
}

// Decide which backend a given settings object wants. Three rules,
// checked in order:
//   1. Explicit settings.dbBackend always wins.
//   2. Legacy users with pgHost in their cached settings keep their
//      external Postgres — silent upgrades shouldn't reset their data.
//   3. Everyone else gets embedded by default.
function isEmbeddedBackend(settings) {
  const explicit = settings && settings.dbBackend;
  if (explicit === "embedded") return true;
  if (explicit === "external") return false;
  if (settings && typeof settings.pgHost === "string" && settings.pgHost.length > 0) {
    return false;
  }
  return true;
}

function defaultEmbeddedDataDir() {
  return path.join(os.homedir(), ".chronicledb", "pgdata");
}

function buildClient(settings) {
  if (isEmbeddedBackend(settings)) {
    const dataDir = (settings && settings.embeddedDataDir) || defaultEmbeddedDataDir();
    return new PGliteAdapter(dataDir);
  }
  return new PgPoolAdapter({
    host: settings.pgHost || "localhost",
    port: settings.pgPort || 5432,
    database: settings.pgDatabase || "chronicledb",
    user: settings.pgUser || process.env.USER,
    password: settings.pgPassword || "",
    max: parseInt(settings.dbPoolMax, 10) || 20,
  });
}

function describeBackend(settings) {
  if (isEmbeddedBackend(settings)) {
    const dir = (settings && settings.embeddedDataDir) || defaultEmbeddedDataDir();
    return `embedded (PGlite @ ${dir})`;
  }
  return `external (${settings.pgHost || "localhost"}:${settings.pgPort || 5432}/${settings.pgDatabase || "chronicledb"} as ${settings.pgUser || process.env.USER})`;
}

module.exports = {
  buildClient,
  isEmbeddedBackend,
  defaultEmbeddedDataDir,
  describeBackend,
};
