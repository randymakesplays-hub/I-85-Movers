const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const MAX_BODY = 10 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Naive per-IP rate limit for lead submissions: 15 per hour.
const RATE_LIMIT = 15;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_LIMIT) return true;
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 10000) hits.clear();
  return false;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
}

function keyOk(req, url) {
  if (!ADMIN_KEY) return false;
  const given = req.headers['x-admin-key'] || url.searchParams.get('key') || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, cb) {
  let body = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (!tooBig) cb(body);
  });
}

function clean(v, max = 200) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, storage: storage.mode(), admin_key_set: Boolean(ADMIN_KEY) });
    return true;
  }

  if (url.pathname === '/api/leads' && req.method === 'POST') {
    readBody(req, async (body) => {
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
      }
      // Honeypot: real users never fill this field. Pretend success for bots.
      if (clean(data.company)) return sendJson(res, 200, { ok: true });

      const lead = {
        moving_from: clean(data.moving_from),
        moving_to: clean(data.moving_to),
        move_date: clean(data.move_date, 40),
        home_size: clean(data.home_size, 60),
        phone: clean(data.phone, 40),
        user_agent: clean(req.headers['user-agent'], 300),
        ip: clean(clientIp(req), 60),
      };
      if (!lead.moving_from || !lead.moving_to || !lead.phone) {
        return sendJson(res, 400, { ok: false, error: 'moving_from, moving_to and phone are required' });
      }
      if (rateLimited(lead.ip)) return sendJson(res, 429, { ok: false, error: 'too many requests' });

      try {
        const saved = await storage.addLead(lead);
        sendJson(res, 200, { ok: true, id: saved.id });
      } catch (err) {
        console.error('lead save failed:', err.message);
        sendJson(res, 500, { ok: false, error: 'storage error' });
      }
    });
    return true;
  }

  if (url.pathname === '/api/leads' && req.method === 'GET') {
    if (!ADMIN_KEY) {
      sendJson(res, 503, { ok: false, error: 'ADMIN_KEY is not configured on the server' });
      return true;
    }
    if (!keyOk(req, url)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }
    try {
      const leads = await storage.listLeads();
      if (url.searchParams.get('format') === 'csv') {
        const cols = ['id', 'created_at', 'moving_from', 'moving_to', 'move_date', 'home_size', 'phone', 'ip'];
        const csv = [cols.join(',')]
          .concat(leads.map((l) => cols.map((c) => csvEscape(l[c])).join(',')))
          .join('\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="i85-movers-leads.csv"',
        }).end(csv);
      } else {
        sendJson(res, 200, { ok: true, count: leads.length, leads });
      }
    } catch (err) {
      console.error('lead list failed:', err.message);
      sendJson(res, 500, { ok: false, error: 'storage error' });
    }
    return true;
  }

  return false;
}

function serveStatic(res, urlPath) {
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  if (urlPath === '/admin') urlPath = '/admin.html';

  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, fileData) => {
    if (err) {
      // Single-page site: fall back to index.html for unknown paths
      fs.readFile(path.join(ROOT, 'index.html'), (err2, home) => {
        if (err2) {
          res.writeHead(404).end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(home);
      });
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }).end(fileData);
  });
}

http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    const handled = await handleApi(req, res, url);
    if (!handled) sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }

  // Never serve server internals as static files
  if (/^\/(server\.js|storage\.js|package(-lock)?\.json|data(\/|$))/.test(url.pathname)) {
    res.writeHead(404).end('Not found');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  serveStatic(res, pathname);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`I-85 Movers site listening on port ${PORT} (storage: ${storage.mode()})`);
});
