// Lead storage: Postgres when DATABASE_URL is set (Railway), NDJSON file otherwise.
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const NDJSON_PATH = path.join(DATA_DIR, 'leads.ndjson');

let pool = null;
let ready = null;

function mode() {
  return DATABASE_URL ? 'postgres' : 'file';
}

function init() {
  if (ready) return ready;
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: DATABASE_URL,
      // Railway's private-network DATABASE_URL has no TLS; the public proxy URL does.
      ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
    });
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        moving_from TEXT NOT NULL,
        moving_to TEXT NOT NULL,
        move_date TEXT,
        home_size TEXT,
        phone TEXT NOT NULL,
        user_agent TEXT,
        ip TEXT
      )`);
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    ready = Promise.resolve();
  }
  return ready;
}

async function addLead(lead) {
  await init();
  if (pool) {
    const r = await pool.query(
      `INSERT INTO leads (moving_from, moving_to, move_date, home_size, phone, user_agent, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [lead.moving_from, lead.moving_to, lead.move_date, lead.home_size, lead.phone, lead.user_agent, lead.ip]
    );
    return { id: r.rows[0].id, created_at: r.rows[0].created_at };
  }
  const row = { id: Date.now(), created_at: new Date().toISOString(), ...lead };
  await fs.promises.appendFile(NDJSON_PATH, JSON.stringify(row) + '\n');
  return { id: row.id, created_at: row.created_at };
}

async function listLeads() {
  await init();
  if (pool) {
    const r = await pool.query('SELECT * FROM leads ORDER BY created_at DESC');
    return r.rows;
  }
  let text = '';
  try {
    text = await fs.promises.readFile(NDJSON_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .reverse();
}

module.exports = { addLead, listLeads, mode };
