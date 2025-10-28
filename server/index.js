// server/index.js
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import { PubSub } from '@google-cloud/pubsub';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Cloud Run: must honor $PORT and bind 0.0.0.0
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

const PUBSUB_TOPIC = process.env.PUBSUB_TOPIC;
const INGEST_TOKEN = process.env.INGEST_TOKEN;

const pubsubEnabled = Boolean(PUBSUB_TOPIC);
let topic = null;

if (pubsubEnabled) {
  const pubsub = new PubSub();
  topic = pubsub.topic(PUBSUB_TOPIC, {
    batching: { maxBytes: 5 * 1024 * 1024, maxMessages: 50, maxMilliseconds: 100 }
  });
} else {
  console.warn('[boot] PUBSUB_TOPIC not set. /api/store will log instead of publishing.');
}

app.use(morgan('tiny'));
app.use(express.json({ limit: '1mb' }));

// healthz helps Cloud Run mark container healthy
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// static UI (Vite build must be copied to server/public)
app.use(express.static(path.join(__dirname, 'public')));

// ---- helpers ----
const SENSITIVE_KEYS = new Set(['password', 'pass', 'passwd', 'pwd', 'secret', 'token']);

function requireToken(req, res) {
  if (!INGEST_TOKEN) return true; // open if not configured
  // Accept either header name:
  const token = req.get('x-ingest-token') || req.get('INGEST_TOKEN');
  if (token === INGEST_TOKEN) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

function stripSensitive(value) {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(String(k).toLowerCase())) continue;
      out[k] = stripSensitive(v);
    }
    return out;
  }
  return value;
}

function getRemoteIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  if (Array.isArray(xff) && xff.length) return xff[0];
  return req.socket?.remoteAddress || null;
}

// Try to normalize different incoming shapes into your BigQuery schema
function toBQRow(body, req) {
  // if caller already sends flat fields, prefer them
  const flat = {
    event: body.event ?? 'login_attempt',
    label: body.label ?? 'login_flow_test',
    risk_score: Number(body.risk_score ?? body?.risk?.score ?? 0),
    risk_confidence: Number(body.risk_confidence ?? body?.risk?.confidence ?? 0),
    timestamp: body.timestamp ?? new Date().toISOString(),
    received_at: new Date().toISOString(),
    ua: req.get('user-agent') || null,
    ip: getRemoteIp(req),
    // keep original (sanitized) JSON as raw for debugging
    raw: stripSensitive(body)
  };
  return flat;
}

// ---- API ----
app.post('/api/store', async (req, res) => {
  if (!requireToken(req, res)) return;

  // Light validation (accept both old entries[] shape and flat JSON)
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }

  const out = toBQRow(req.body, req);

  if (!pubsubEnabled) {
    console.log('[store] Pub/Sub disabled. Would publish:', JSON.stringify(out));
    return res.status(202).json({ status: 'received_local' });
  }

  try {
    await topic.publishMessage({ json: out });
    return res.status(202).json({ status: 'queued' });
  } catch (err) {
    console.error('pubsub publish error', err);
    return res.status(500).json({ error: 'publish_failed' });
  }
});

app.get('/api/data', (_req, res) => {
  res.status(501).json({ error: 'not_available', hint: 'Query BigQuery table fed by Pub/Sub subscription.' });
});

// SPA fallback AFTER API routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Ingestion API listening on http://${HOST}:${PORT}`);
});
