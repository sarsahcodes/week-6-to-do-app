'use strict';

/**
 * Week 6 To-Do API
 *
 * Reads  -> ElastiCache for Redis (cache-aside), falling back to Postgres on a miss
 * Writes -> Aurora PostgreSQL, always through RDS Proxy, then the cache is invalidated
 *
 * Every environment variable below is supplied by the CloudFormation compute stack.
 * DB_USER / DB_PASSWORD arrive as ECS "secrets" pulled from the RDS-managed
 * Secrets Manager secret, so no credential is ever baked into this image.
 */

const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const Redis = require('ioredis');

const PORT = parseInt(process.env.PORT || '3000', 10);
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS || '60', 10);
const CACHE_KEY_ALL = 'todo:tasks:all';
const CACHE_KEY_ONE = (id) => `todo:task:${id}`;

// ---------------------------------------------------------------------------
// Postgres - the host is the RDS Proxy endpoint, never the cluster endpoint.
// The proxy has RequireTLS enabled, hence ssl below.
// ---------------------------------------------------------------------------
const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'tododb',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // The proxy presents an AWS-issued certificate. rejectUnauthorized is false
  // because we do not ship the RDS CA bundle in the image; the connection is
  // still encrypted and never leaves the VPC.
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

// ---------------------------------------------------------------------------
// Redis - ElastiCache replication group primary endpoint, TLS in transit.
// The cache is an optimisation: if it is unreachable the app still serves
// correct data straight from Postgres.
// ---------------------------------------------------------------------------
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  lazyConnect: false,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 5000,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});

let redisReady = false;
redis.on('ready', () => { redisReady = true; console.log('[redis] ready'); });
redis.on('end', () => { redisReady = false; });
redis.on('error', (err) => {
  if (redisReady) console.error('[redis] error:', err.message);
  redisReady = false;
});

const stats = { cacheHits: 0, cacheMisses: 0, dbReads: 0, dbWrites: 0 };

async function cacheGet(key) {
  if (!redisReady) return null;
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('[redis] get failed:', err.message);
    return null;
  }
}

async function cacheSet(key, value) {
  if (!redisReady) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL);
  } catch (err) {
    console.error('[redis] set failed:', err.message);
  }
}

async function cacheInvalidate(keys) {
  if (!redisReady) return;
  try {
    await redis.del(...keys);
  } catch (err) {
    console.error('[redis] del failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Schema bootstrap - retried, because the task may start before the proxy has
// finished registering its targets.
// ---------------------------------------------------------------------------
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id          SERIAL PRIMARY KEY,
    title       TEXT        NOT NULL,
    notes       TEXT        NOT NULL DEFAULT '',
    done        BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

async function initSchema(attempt = 1) {
  try {
    await pool.query(SCHEMA);
    console.log('[pg] schema ready');
  } catch (err) {
    console.error(`[pg] schema init attempt ${attempt} failed: ${err.message}`);
    if (attempt >= 15) return;
    await new Promise((r) => setTimeout(r, 5000));
    return initSchema(attempt + 1);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const asJson = (rows) => rows.map((r) => ({
  id: r.id,
  title: r.title,
  notes: r.notes,
  done: r.done,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
}));

// READ (list) - cache-aside. The response tells you which path served it, which
// is what makes the caching visible in the UI and in a live demo.
app.get('/api/tasks', async (req, res) => {
  const started = process.hrtime.bigint();
  try {
    const cached = await cacheGet(CACHE_KEY_ALL);
    if (cached) {
      stats.cacheHits += 1;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(`[read] cache HIT (${ms.toFixed(1)}ms)`);
      return res.json({ source: 'redis-cache', latencyMs: +ms.toFixed(1), count: cached.length, tasks: cached });
    }

    stats.cacheMisses += 1;
    stats.dbReads += 1;
    const { rows } = await pool.query(
      'SELECT id, title, notes, done, created_at, updated_at FROM tasks ORDER BY id DESC'
    );
    const tasks = asJson(rows);
    await cacheSet(CACHE_KEY_ALL, tasks);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`[read] cache MISS -> Aurora via RDS Proxy (${ms.toFixed(1)}ms)`);
    return res.json({ source: 'aurora-via-rds-proxy', latencyMs: +ms.toFixed(1), count: tasks.length, tasks });
  } catch (err) {
    console.error('[read] failed:', err.message);
    return res.status(500).json({ error: 'Failed to load tasks', detail: err.message });
  }
});

// READ (single) - also cache-aside
app.get('/api/tasks/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const cached = await cacheGet(CACHE_KEY_ONE(id));
    if (cached) {
      stats.cacheHits += 1;
      return res.json({ source: 'redis-cache', task: cached });
    }
    stats.cacheMisses += 1;
    stats.dbReads += 1;
    const { rows } = await pool.query(
      'SELECT id, title, notes, done, created_at, updated_at FROM tasks WHERE id = $1', [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Task not found' });
    const task = asJson(rows)[0];
    await cacheSet(CACHE_KEY_ONE(id), task);
    return res.json({ source: 'aurora-via-rds-proxy', task });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load task', detail: err.message });
  }
});

// CREATE
app.post('/api/tasks', async (req, res) => {
  const title = (req.body?.title || '').toString().trim();
  const notes = (req.body?.notes || '').toString().trim();
  if (!title) return res.status(400).json({ error: 'title is required' });
  if (title.length > 200) return res.status(400).json({ error: 'title too long (max 200)' });
  try {
    stats.dbWrites += 1;
    const { rows } = await pool.query(
      `INSERT INTO tasks (title, notes) VALUES ($1, $2)
       RETURNING id, title, notes, done, created_at, updated_at`,
      [title, notes]
    );
    await cacheInvalidate([CACHE_KEY_ALL]);
    console.log(`[write] created task ${rows[0].id}, cache invalidated`);
    return res.status(201).json({ task: asJson(rows)[0] });
  } catch (err) {
    console.error('[write] create failed:', err.message);
    return res.status(500).json({ error: 'Failed to create task', detail: err.message });
  }
});

// UPDATE
app.put('/api/tasks/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'id must be a number' });
  const { title, notes, done } = req.body || {};
  try {
    stats.dbWrites += 1;
    const { rows } = await pool.query(
      `UPDATE tasks
          SET title      = COALESCE($2, title),
              notes      = COALESCE($3, notes),
              done       = COALESCE($4, done),
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, title, notes, done, created_at, updated_at`,
      [
        id,
        title === undefined ? null : String(title).trim(),
        notes === undefined ? null : String(notes).trim(),
        done === undefined ? null : Boolean(done),
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Task not found' });
    await cacheInvalidate([CACHE_KEY_ALL, CACHE_KEY_ONE(id)]);
    console.log(`[write] updated task ${id}, cache invalidated`);
    return res.json({ task: asJson(rows)[0] });
  } catch (err) {
    console.error('[write] update failed:', err.message);
    return res.status(500).json({ error: 'Failed to update task', detail: err.message });
  }
});

// DELETE
app.delete('/api/tasks/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'id must be a number' });
  try {
    stats.dbWrites += 1;
    const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Task not found' });
    await cacheInvalidate([CACHE_KEY_ALL, CACHE_KEY_ONE(id)]);
    console.log(`[write] deleted task ${id}, cache invalidated`);
    return res.status(204).end();
  } catch (err) {
    console.error('[write] delete failed:', err.message);
    return res.status(500).json({ error: 'Failed to delete task', detail: err.message });
  }
});

// Manual cache flush - handy for demonstrating a cold read on stage.
app.post('/api/cache/flush', async (req, res) => {
  await cacheInvalidate([CACHE_KEY_ALL]);
  return res.json({ flushed: true });
});

app.get('/api/stats', (req, res) => {
  const total = stats.cacheHits + stats.cacheMisses;
  res.json({
    ...stats,
    hitRatePercent: total ? +((stats.cacheHits / total) * 100).toFixed(1) : 0,
    redisConnected: redisReady,
    cacheTtlSeconds: CACHE_TTL,
    dbHost: process.env.DB_HOST || null,
    redisHost: process.env.REDIS_HOST || null,
  });
});

// Shallow health check for the ALB. It deliberately does NOT depend on Redis:
// a cache outage should not take the whole service out of the target group.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', redis: redisReady ? 'connected' : 'degraded' });
});

// Deep check, for troubleshooting from inside the VPC or via the test listener.
app.get('/health/deep', async (req, res) => {
  const out = { database: 'unknown', cache: redisReady ? 'connected' : 'disconnected' };
  try {
    await pool.query('SELECT 1');
    out.database = 'connected';
  } catch (err) {
    out.database = `error: ${err.message}`;
    return res.status(503).json(out);
  }
  res.json(out);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[app] listening on ${PORT}`);
  console.log(`[app] db  -> ${process.env.DB_HOST}:${process.env.DB_PORT} (ssl=${process.env.DB_SSL})`);
  console.log(`[app] redis -> ${process.env.REDIS_HOST}:${process.env.REDIS_PORT} (tls=${process.env.REDIS_TLS})`);
  initSchema();
});

// Graceful shutdown so blue/green cutovers drain cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[app] ${sig} received, shutting down`);
    server.close(async () => {
      try { await pool.end(); } catch (_) {}
      try { redis.disconnect(); } catch (_) {}
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
