// The web UI: serves the page and runs one prompt through the pipeline, returning every state.
//
// Runs the steps itself rather than in the browser so the page needs no CORS from any service:
// it asks the analyzer what it detects, sends the prompt through LiteLLM, then reads back what the
// provider side recorded.
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const PORT = Number(process.env.PORT ?? 4020);
const ANALYZER = process.env.ANALYZER_URL ?? 'http://localhost:5002';
const PROXY = process.env.PROXY_URL ?? 'http://localhost:4000';
const TAP = process.env.TAP_URL ?? 'http://localhost:4010';
const PROXY_KEY = process.env.PROXY_KEY ?? 'sk-poc-local';
const LITELLM_CONFIG = process.env.LITELLM_CONFIG ?? new URL('../litellm/config.yaml', import.meta.url).pathname;
const SAMPLES = process.env.SAMPLES ?? new URL('../samples.json', import.meta.url).pathname;
const TOKEN = /(<[A-Z_]+_\d+>)/;
const TOKEN_G = /<[A-Z_]+_\d+>/g;

/** The entity types LiteLLM drops before masking, read from its config so the two never disagree. */
async function deniedEntities() {
  const config = await readFile(LITELLM_CONFIG, 'utf8');
  const match = config.match(/presidio_entities_deny_list:\s*\[([^\]]*)\]/);
  return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

async function analyze(text, language) {
  const started = Date.now();
  const res = await fetch(`${ANALYZER}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language, return_decision_process: true }),
  });
  if (!res.ok) throw new Error(`analyzer answered ${res.status}: ${await res.text()}`);
  const raw = (await res.json()).sort((a, b) => a.start - b.start || b.end - a.end);
  const denied = await deniedEntities();
  const findings = raw.map((f, i) => ({
    entity: f.entity_type,
    start: f.start,
    end: f.end,
    text: text.slice(f.start, f.end),
    score: f.score,
    recognizer: f.analysis_explanation?.recognizer ?? '',
    denied: denied.includes(f.entity_type),
    overlaps: raw.some((g, j) => j !== i && g.start < f.end && f.start < g.end),
  }));
  return { findings, ms: Date.now() - started };
}

async function viaProxy(text, model, stream, language) {
  const started = Date.now();
  const res = await fetch(`${PROXY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROXY_KEY}` },
    body: JSON.stringify({
      model,
      stream,
      max_tokens: 1024,
      messages: [{ role: 'user', content: text }],
      guardrail_config: { 'presidio-pii': { language } },
    }),
  });
  if (!res.ok) throw new Error(`LiteLLM answered ${res.status}: ${await res.text()}`);
  if (!stream) {
    const json = await res.json();
    return { text: json.choices?.[0]?.message?.content ?? '', ms: Date.now() - started };
  }

  let out = '';
  let chunks = 0;
  let firstChunkMs;
  let buffered = '';
  const decoder = new TextDecoder();
  for await (const part of res.body) {
    buffered += decoder.decode(part, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? '';
      if (!delta) continue;
      chunks++;
      firstChunkMs ??= Date.now() - started;
      out += delta;
    }
  }
  return { text: out, ms: Date.now() - started, chunks, firstChunkMs };
}

/**
 * Recovers token → original value by laying the masked prompt over the original: the text between
 * tokens must match exactly, so what the original holds where a token stands is its value. When
 * the literal text does not line up, the masked prompt was not a faithful copy -- which is how the
 * overlapping-detection bug shows itself.
 */
function alignTokens(original, masked) {
  const parts = masked.split(TOKEN);
  const map = [];
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 0) {
      if (!original.startsWith(part, pos)) return { map, aligned: false, at: pos };
      pos += part.length;
      continue;
    }
    const next = parts[i + 1] ?? '';
    const end = next === '' && i + 1 === parts.length - 1 ? original.length : original.indexOf(next, pos);
    if (end < 0) return { map, aligned: false, at: pos };
    map.push({ token: part, value: original.slice(pos, end) });
    pos = end;
  }
  return { map, aligned: pos === original.length, at: pos };
}

async function run({ text, language = 'pl', model = 'fake', stream = false, expect = [] }) {
  const result = { text, language, model, stream, stages: {}, checks: [], timings: {} };

  const analysis = await analyze(text, language);
  result.stages.findings = analysis.findings;
  result.timings.analyzeMs = analysis.ms;

  await fetch(`${TAP}/last`, { method: 'DELETE' });
  const proxied = await viaProxy(text, model, stream, language);
  result.stages.restored = proxied.text;
  result.timings.roundTripMs = proxied.ms;
  if (stream) result.timings.stream = { chunks: proxied.chunks, firstChunkMs: proxied.firstChunkMs };

  const tap = await (await fetch(`${TAP}/last`)).json();
  if (!tap) {
    result.checks.push({ ok: false, label: 'The provider side recorded nothing — the request never reached it.' });
    return result;
  }
  result.stages.sent = tap.sentPrompt;
  result.stages.providerReply = tap.reply;
  result.stages.providerPath = tap.path;
  if (stream) result.timings.stream.providerChunks = tap.chunks;

  const alignment = alignTokens(text, tap.sentPrompt);
  result.stages.tokenMap = alignment.map;

  const mustNotLeak = [...new Set([...expect, ...analysis.findings.filter((f) => !f.denied).map((f) => f.text)])];
  const leaked = mustNotLeak.filter((v) => tap.sentPrompt.includes(v));
  result.checks.push(
    leaked.length
      ? { ok: false, label: `Leaked to the provider: ${leaked.map((l) => `“${l}”`).join(', ')}` }
      : { ok: true, label: `None of ${mustNotLeak.length} detected or expected values reached the provider` },
  );
  result.checks.push(
    alignment.aligned
      ? { ok: true, label: 'The masked prompt is a faithful copy of the original, placeholders aside' }
      : { ok: false, label: `The masked prompt does not line up with the original from character ${alignment.at}: masking changed the text` },
  );

  if (tap.provider === 'fake') {
    const echoed = proxied.text.split('\n')[2];
    result.checks.push(
      echoed === text
        ? { ok: true, label: 'Round trip is lossless: the echoed prompt came back exactly as sent' }
        : { ok: false, label: 'Round trip changed the text: the echoed prompt differs from what you sent' },
    );
  }
  const unrestored = [...new Set(proxied.text.match(TOKEN_G) ?? [])];
  const strayPlaceholders = proxied.text.match(/<[A-Z_]+>/g);
  result.checks.push(
    unrestored.length
      ? { ok: false, label: `Placeholders left unrestored: ${unrestored.join(', ')}` }
      : strayPlaceholders
        ? { ok: false, label: `The reply came back masked again: ${[...new Set(strayPlaceholders)].join(', ')}` }
        : { ok: true, label: 'Every placeholder in the reply was restored' },
  );
  if (stream) {
    result.checks.push({
      ok: proxied.chunks > 1,
      label:
        proxied.chunks > 1
          ? `Streamed in ${proxied.chunks} chunks`
          : `Provider sent ${tap.chunks ?? '?'} chunks; your app got ${proxied.chunks} — the proxy buffers the stream to restore it`,
    });
  }
  return result;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      return send(res, 200, await readFile(new URL('./index.html', import.meta.url)), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && req.url === '/api/samples') {
      return send(res, 200, JSON.parse(await readFile(SAMPLES, 'utf8')));
    }
    if (req.method === 'GET' && req.url === '/api/config') {
      return send(res, 200, { denied: await deniedEntities() });
    }
    if (req.method === 'POST' && req.url === '/api/run') {
      let body = '';
      for await (const chunk of req) body += chunk;
      return send(res, 200, await run(JSON.parse(body)));
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => console.log(`web UI on http://localhost:${PORT}`));
