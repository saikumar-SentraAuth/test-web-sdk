import { createSDK } from '@sentraauth/web-mouse-dynamics-sdk';

const THRESH_CONF_BLOCK = 0.8;
const THRESH_SCORE_BLOCK = 0.75;
const THRESH_CONF_WARN = 0.6;
const THRESH_SCORE_WARN = 0.55;
const CONF_MIN = 0.6;

const app = document.querySelector('#app');
if (!app) {
  throw new Error('App root not found');
}

app.innerHTML = `
  <form id="loginForm" autocomplete="off">
    <div class="grid">
      <label>
        Username
        <input id="username" name="username" type="text" placeholder="jane.doe" />
      </label>
      <label>
        Password
        <input id="password" name="password" type="password" placeholder="********" />
      </label>
    </div>
    <button type="submit">Attempt login</button>
  </form>

  <div class="meters">
    <div>
      <div class="grid">
        <strong>Risk score</strong>
        <span id="riskBadge" class="badge">No signal yet</span>
      </div>
      <div class="meter"><div id="riskBar" class="bar"></div></div>
      <small>score: <span id="riskScore">0.000</span></small>
    </div>
    <div>
      <strong>Confidence</strong>
      <div class="meter"><div id="confBar" class="bar"></div></div>
      <small>value: <span id="confScore">0.000</span></small>
    </div>
  </div>

  <div id="hint" class="status"></div>
  <div id="status" class="status"></div>
  <p>Event batches stream to Google Cloud Pub/Sub &rarr; BigQuery for analysis.</p>
`;

const form = app.querySelector('#loginForm');
const inputs = Array.from(form.querySelectorAll('input'));
const riskBar = app.querySelector('#riskBar');
const confBar = app.querySelector('#confBar');
const riskScoreEl = app.querySelector('#riskScore');
const confScoreEl = app.querySelector('#confScore');
const badgeEl = app.querySelector('#riskBadge');
const hintEl = app.querySelector('#hint');
const statusEl = app.querySelector('#status');

let lastRisk = { score: 0, confidence: 0 };
let started = false;

const colors = {
  muted: 'var(--muted)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  block: 'var(--block)'
};

const sdk = createSDK({
  onRisk: (risk) => {
    lastRisk = {
      score: Number(risk?.score ?? 0),
      confidence: Number(risk?.confidence ?? 0)
    };
    updateMeters();
  },
  onBatch: () => {
    // Live streaming can be wired here if desired.
  }
});

function ensureCapture() {
  if (started) return;
  started = true;
  try {
    sdk.start?.();
  } catch (err) {
    console.error('start failed', err);
  }
  setStatus('Capturing mouse dynamics...', 'muted');
}

function updateMeters() {
  const scorePct = Math.round(Math.min(1, Math.max(0, lastRisk.score)) * 100);
  const confPct = Math.round(Math.min(1, Math.max(0, lastRisk.confidence)) * 100);
  if (riskBar) riskBar.style.width = `${scorePct}%`;
  if (confBar) confBar.style.width = `${confPct}%`;
  if (riskScoreEl) riskScoreEl.textContent = lastRisk.score.toFixed(3);
  if (confScoreEl) confScoreEl.textContent = lastRisk.confidence.toFixed(3);
  updateBadge();
  updateHint();
}

function updateBadge() {
  if (!badgeEl) return;
  let label = 'Low risk';
  let tone = 'ok';
  if (lastRisk.confidence < CONF_MIN) {
    label = 'Low confidence';
    tone = 'warn';
  } else if (lastRisk.score >= THRESH_SCORE_BLOCK && lastRisk.confidence >= THRESH_CONF_BLOCK) {
    label = 'High risk';
    tone = 'block';
  } else if (lastRisk.score >= THRESH_SCORE_WARN && lastRisk.confidence >= THRESH_CONF_WARN) {
    label = 'Elevated risk';
    tone = 'warn';
  }
  badgeEl.textContent = label;
  badgeEl.className = `badge ${tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'block' ? 'block' : ''}`.trim();
}

function updateHint() {
  if (!hintEl) return;
  if (lastRisk.confidence < CONF_MIN) {
    hintEl.style.color = colors.warn;
    hintEl.textContent = 'Move your mouse a bit more...';
  } else {
    hintEl.style.color = colors.muted;
    hintEl.textContent = '';
  }
}

function setStatus(message, tone = 'muted') {
  if (!statusEl) return;
  statusEl.style.color = colors[tone] ?? colors.muted;
  statusEl.textContent = message;
}

async function handleSubmit(event) {
  event.preventDefault();
  ensureCapture();
  if (typeof sdk.flush === 'function') {
    try {
      await sdk.flush();
    } catch (err) {
      console.error('flush failed', err);
    }
  }

  const risk = typeof sdk.getRisk === 'function' ? sdk.getRisk() ?? lastRisk : lastRisk;
  const score = Number(risk?.score ?? 0);
  const confidence = Number(risk?.confidence ?? 0);
  lastRisk = { score, confidence };
  updateMeters();

  if (confidence < CONF_MIN) {
    setStatus('Need more pointer signal before deciding.', 'warn');
    return;
  }
  if (score >= THRESH_SCORE_BLOCK && confidence >= THRESH_CONF_BLOCK) {
    setStatus('Access blocked: anomalous mouse dynamics.', 'block');
  } else if (score >= THRESH_SCORE_WARN && confidence >= THRESH_CONF_WARN) {
    setStatus('Warning: elevated risk detected, step-up verification advised.', 'warn');
  } else {
    setStatus('Access granted: mouse dynamics look good.', 'ok');
  }

  const eventPayload = {
    event: 'login_attempt',
    label: 'login_flow_test',
    risk: { score, confidence },
    timestamp: new Date().toISOString()
  };
  sendPayload(eventPayload);
}

function sendPayload(eventPayload) {
  const url = '/api/store';
  const batch = {
    batchId: crypto.randomUUID?.() ?? `batch-${Date.now()}`,
    source: 'frontend/login_demo',
    entries: [eventPayload]
  };
  const json = JSON.stringify(batch);
  if (navigator.sendBeacon) {
    const blob = new Blob([json], { type: 'application/json' });
    const ok = navigator.sendBeacon(url, blob);
    if (ok) return;
  }
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: json,
    keepalive: true
  }).catch((err) => {
    console.error('store failed', err);
  });
}

inputs.forEach((input) => {
  input.addEventListener('focus', ensureCapture);
});

form.addEventListener('submit', (event) => {
  handleSubmit(event).catch((err) => {
    console.error('submit failed', err);
    setStatus('Submit failed, check console for details.', 'warn');
  });
});

window.addEventListener('beforeunload', () => {
  try {
    sdk.flush?.();
  } catch (err) {
    console.error('flush before unload failed', err);
  }
});

setStatus('Move the cursor and focus the form to begin.', 'muted');
