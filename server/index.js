import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import { PubSub } from '@google-cloud/pubsub';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const PUBSUB_TOPIC = process.env.PUBSUB_TOPIC;
const INGEST_TOKEN = process.env.INGEST_TOKEN;

const pubsubEnabled = Boolean(PUBSUB_TOPIC);
let topic = null;

if (pubsubEnabled) {
  const pubsub = new PubSub();
  topic = pubsub.topic(PUBSUB_TOPIC, {
    batching: {
      maxBytes: 5 * 1024 * 1024,
      maxMessages: 50,
      maxMilliseconds: 100
    }
  });
} else {
  console.warn('PUBSUB_TOPIC not set. POST /api/store will log batches locally instead of publishing.');
}

app.use(morgan('tiny'));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SENSITIVE_KEYS = new Set(['password', 'pass', 'passwd', 'pwd', 'secret', 'token']);

function requireToken(req, res) {
  if (!INGEST_TOKEN) return true;
  const token = req.get('x-ingest-token');
  if (token && token === INGEST_TOKEN) {
    return true;
  }
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

function stripSensitive(value) {
  if (Array.isArray(value)) {
    return value.map(stripSensitive);
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((acc, [key, val]) => {
      if (SENSITIVE_KEYS.has(String(key).toLowerCase())) {
        return acc;
      }
      acc[key] = stripSensitive(val);
      return acc;
    }, {});
  }
  return value;
}

function getRemoteIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return xff[0];
  }
  return req.socket?.remoteAddress || null;
}

function validateBatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Body must be a JSON object';
  }
  if (!Array.isArray(body.entries) || body.entries.length === 0) {
    return 'entries array is required';
  }
  return null;
}

app.post('/api/store', async (req, res) => {
  if (!requireToken(req, res)) return;
  const validationError = validateBatch(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const cleanPayload = stripSensitive(req.body);
  const envelope = {
    ...cleanPayload,
    _receivedAt: new Date().toISOString(),
    _ua: req.get('user-agent') || null,
    _ip: getRemoteIp(req)
  };

  if (!pubsubEnabled) {
    console.log('Pub/Sub disabled. Received batch:', JSON.stringify(envelope));
    return res.status(202).json({ status: 'received', hint: 'PUBSUB_TOPIC not set; batch logged locally.' });
  }

  try {
    await topic.publishMessage({ json: envelope });
    res.status(202).json({ status: 'queued' });
  } catch (err) {
    console.error('pubsub publish error', err);
    res.status(500).json({ error: 'publish_failed' });
  }
});

app.get('/api/data', (_req, res) => {
  res.status(501).json({ error: 'not_available', hint: 'Query BigQuery table fed by Pub/Sub subscription.' });
});

app.get('/data', (_req, res) => {
  if (!pubsubEnabled) {
    res.type('html').send(`<!doctype html>
      <meta charset="utf-8" />
      <title>Mouse Risk Data Pipeline</title>
      <style>
        body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; padding: 24px; background: #0f172a; color: #e2e8f0; }
        code { background: rgba(148,163,184,0.18); padding: 2px 6px; border-radius: 6px; }
        a { color: #7c3aed; }
        ul { line-height: 1.6; }
      </style>
      <h1>Local Development Mode</h1>
      <p><code>PUBSUB_TOPIC</code> is not configured. Batches received by <code>/api/store</code> are logged to the server console.</p>
      <p>Set <code>PUBSUB_TOPIC</code> to a real Pub/Sub topic when you are ready to stream events into BigQuery.</p>`);
    return;
  }
  res.type('html').send(`<!doctype html>
    <meta charset="utf-8" />
    <title>Mouse Risk Data Pipeline</title>
    <style>
      body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; padding: 24px; background: #0f172a; color: #e2e8f0; }
      code { background: rgba(148,163,184,0.18); padding: 2px 6px; border-radius: 6px; }
      a { color: #7c3aed; }
      ul { line-height: 1.6; }
    </style>
    <h1>Event Data Available in BigQuery</h1>
    <p>Batched events are forwarded to Pub/Sub topic <code>${PUBSUB_TOPIC}</code>. Configure a BigQuery subscription to land the data:</p>
    <ul>
      <li>Create / verify a dataset + table schema for mouse dynamics</li>
      <li>Attach a BigQuery subscription to the topic (e.g. via <code>gcloud pubsub subscriptions create</code>)</li>
      <li>Query the table for <code>_receivedAt</code>, risk score, confidence, and entries</li>
    </ul>
    <p>With live data, build dashboards or analytics directly in BigQuery or Looker Studio.</p>`);
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ingestion API listening on http://localhost:${PORT}`);
});
