// The provider side of the POC: what LiteLLM talks to, recorded so the UI can show it.
//
//   POST /v1/chat/completions   a fake AI (OpenAI protocol). It does no AI: it echoes the prompt
//                               back with the placeholders it saw, so restoring is visible.
//   POST /anthropic/...         a tap in front of the real Anthropic API: forwards the request
//                               unchanged and records what was sent and what came back.
//   GET  /last                  the last exchange; DELETE /last clears it.
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 4010);
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const TOKEN = /<[A-Z_]+_\d+>/g;
let last = null;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : (b.text ?? ''))).join('');
  return '';
}

function lastUserText(messages) {
  return textOf([...(messages ?? [])].reverse().find((m) => m.role === 'user')?.content);
}

function fakeReply(prompt) {
  const tokens = [...new Set(prompt.match(TOKEN) ?? [])];
  const lines = tokens.length
    ? tokens.map((t) => `- I can see ${t} in your message.`)
    : ['- I could not see any placeholders, so I received your text as written.'];
  return ['Here is what reached me:', '', prompt, '', ...lines].join('\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fakeCompletion(req, res) {
  const body = JSON.parse(await readBody(req));
  const prompt = lastUserText(body.messages);
  const content = fakeReply(prompt);
  last = { provider: 'fake', path: req.url, sentPrompt: prompt, request: body, reply: content, at: new Date().toISOString() };

  const id = `chatcmpl-fake-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const pieces = content.match(/.{1,12}/gs) ?? [];
    last.chunks = pieces.length;
    for (const piece of pieces) {
      const chunk = { id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      await sleep(15);
    }
    const end = { id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    res.end(`data: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      id,
      object: 'chat.completion',
      created,
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  );
}

async function anthropicTap(req, res) {
  const raw = await readBody(req);
  const body = JSON.parse(raw);
  const headers = { 'content-type': 'application/json' };
  for (const name of ['x-api-key', 'anthropic-version', 'anthropic-beta', 'authorization']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  last = { provider: 'anthropic', path: req.url, sentPrompt: lastUserText(body.messages), request: body, reply: '', at: new Date().toISOString() };

  const upstream = await fetch(ANTHROPIC, { method: 'POST', headers, body: raw });
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });

  if (!body.stream || !upstream.ok) {
    const text = await upstream.text();
    try {
      const json = JSON.parse(text);
      last.reply = upstream.ok ? textOf(json.content) : `HTTP ${upstream.status}: ${json.error?.message ?? text}`;
    } catch {
      last.reply = text;
    }
    res.end(text);
    return;
  }

  // Pass the stream through untouched, collecting the text deltas for the record.
  let buffered = '';
  last.chunks = 0;
  const decoder = new TextDecoder();
  for await (const chunk of upstream.body) {
    res.write(chunk);
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          last.reply += event.delta.text;
          last.chunks++;
        }
      } catch {
        // not JSON: keep going
      }
    }
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/last') {
      if (req.method === 'DELETE') last = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(last));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/anthropic')) return await anthropicTap(req, res);
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) return await fakeCompletion(req, res);
    res.writeHead(404);
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: String(err) } }));
  }
});

server.listen(PORT, () => console.log(`provider side listening on :${PORT}`));
