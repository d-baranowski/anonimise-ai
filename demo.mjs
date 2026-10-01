#!/usr/bin/env node
// Walks one prompt through the proxy and prints every stage.
//
//   node demo.mjs                      every sample in samples.json, against the fake provider
//   node demo.mjs basic                one sample by name
//   node demo.mjs --text "..." [--lang pl]
//   node demo.mjs --model claude       a real provider (needs ANTHROPIC_API_KEY in .env)
//   node demo.mjs --stream             request a streamed reply
//   node demo.mjs --plain              LiteLLM's own numbering instead of one placeholder per person
import { readFileSync } from 'node:fs';

const PROXY = 'http://localhost:4000';
const ANALYZER = 'http://localhost:5002';
const FAKE = 'http://localhost:4010';
const KEY = 'sk-poc-local';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const TOKEN = /<[A-Z_]+_\d+(?:_[A-Z]+)?>/g;
const highlight = (s) => s.replace(TOKEN, (t) => c.cyan(t));

function args() {
  const a = process.argv.slice(2);
  const opt = { model: 'fake', stream: false, guardrail: 'presidio-linked', names: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--model') opt.model = a[++i];
    else if (a[i] === '--stream') opt.stream = true;
    else if (a[i] === '--plain') opt.guardrail = 'presidio-pii';
    else if (a[i] === '--text') opt.text = a[++i];
    else if (a[i] === '--lang') opt.lang = a[++i];
    else opt.names.push(a[i]);
  }
  return opt;
}

async function analyze(text, language) {
  const res = await fetch(`${ANALYZER}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language, return_decision_process: true }),
  });
  return (await res.json()).sort((x, y) => x.start - y.start);
}

async function viaProxy(text, model, stream, language, guardrail) {
  const res = await fetch(`${PROXY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model,
      stream,
      messages: [{ role: 'user', content: text }],
      // Per-request language for the guardrail.
      guardrails: [guardrail],
      guardrail_config: { [guardrail]: { language } },
    }),
  });
  if (!res.ok) throw new Error(`proxy answered ${res.status}: ${await res.text()}`);
  if (!stream) return (await res.json()).choices[0].message.content;

  let out = '';
  let chunks = 0;
  const started = Date.now();
  let firstChunkAt;
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? '';
    if (delta) {
      chunks++;
      firstChunkAt ??= Date.now() - started;
    }
    out += delta;
  }
  console.log(c.dim(`  (streamed: ${chunks} chunk(s); proxy buffers the whole stream to restore it)`));
  return out;
}

function stage(n, title) {
  console.log(`\n${c.bold(`${n}. ${title}`)}`);
}

async function run(sample, opt) {
  const { text, language = 'pl', expect = [] } = sample;
  console.log(`\n${'═'.repeat(100)}\n${c.bold(sample.name)} ${c.dim(`[${language}] → model: ${opt.model}${opt.stream ? ', stream' : ''}`)}`);

  stage(1, 'Original prompt (what your app sends)');
  console.log(`  ${text}`);

  stage(2, 'Presidio analyzer — what it detected (runs locally, no LLM)');
  const findings = await analyze(text, language);
  if (!findings.length) console.log(c.yellow('  nothing detected'));
  for (const [i, f] of findings.entries()) {
    const overlaps = findings.some((g, j) => j !== i && g.start < f.end && f.start < g.end);
    const recognizer = f.analysis_explanation?.recognizer ?? '?';
    console.log(
      `  ${f.entity_type.padEnd(14)} ${f.score.toFixed(2)}  ${JSON.stringify(text.slice(f.start, f.end)).padEnd(36)} ${c.dim(recognizer)}${overlaps ? c.yellow('  ⚠ overlaps another finding') : ''}`,
    );
  }

  const answer = await viaProxy(text, opt.model, opt.stream, language, opt.guardrail);

  if (opt.model === 'fake') {
    const last = await (await fetch(`${FAKE}/last`)).json();
    const received = last.sentPrompt;

    stage(3, 'What the AI provider received (after the proxy masked it)');
    console.log(`  ${highlight(received)}`);
    const leaked = expect.filter((e) => received.includes(e));
    const missed = findings.map((f) => text.slice(f.start, f.end)).filter((s) => received.includes(s));
    if (leaked.length || missed.length) {
      for (const l of new Set([...leaked, ...missed])) console.log(c.red(`  ✗ LEAKED to provider: ${JSON.stringify(l)}`));
    } else {
      console.log(c.green(`  ✓ none of the ${expect.length} expected values reached the provider`));
    }

    stage(4, "AI provider's raw reply (still placeholders)");
    console.log(highlight(last.reply).replace(/^/gm, '  '));

    stage(5, 'Reply your app gets back (proxy restored the originals)');
    console.log(answer.replace(/^/gm, '  '));

    // The fake echoes the prompt back, so a lossless round trip gives back the original text.
    const echoed = answer.split('\n')[2];
    console.log(
      echoed === text
        ? c.green('  ✓ round trip is lossless: the echoed prompt matches the original exactly')
        : opt.guardrail === 'presidio-linked'
          ? c.yellow(`  ℹ linked mentions came back in one form:\n     sent:     ${JSON.stringify(text)}\n     restored: ${JSON.stringify(echoed)}`)
          : c.red(`  ✗ round trip changed the text:\n     sent:     ${JSON.stringify(text)}\n     restored: ${JSON.stringify(echoed)}`),
    );
    const leftovers = answer.match(TOKEN);
    if (leftovers) console.log(c.red(`  ✗ placeholders left unrestored: ${leftovers.join(', ')}`));
  } else {
    stage(3, `Reply from ${opt.model} (restored by the proxy)`);
    console.log(answer.replace(/^/gm, '  '));
    const leftovers = answer.match(TOKEN);
    if (leftovers) console.log(c.yellow(`  ⚠ placeholders left unrestored (the model altered them?): ${leftovers.join(', ')}`));
    console.log(c.dim('  What the provider received is in the LiteLLM logs: docker compose logs litellm'));
  }
}

const opt = args();
const samples = JSON.parse(readFileSync(new URL('./samples.json', import.meta.url)));
const selected = opt.text
  ? [{ name: 'custom', text: opt.text, language: opt.lang ?? 'pl', expect: [] }]
  : opt.names.length
    ? samples.filter((s) => opt.names.includes(s.name))
    : samples;

for (const s of selected) {
  try {
    await run(s, opt);
  } catch (err) {
    console.log(c.red(`  error: ${err.message}`));
  }
}
