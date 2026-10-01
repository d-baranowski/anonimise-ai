// A stand-in for an AI provider, speaking the OpenAI chat-completions protocol.
//
// It does no AI. It records exactly what it was sent and replies with a message that repeats the
// tokens back, so the demo can show what a real provider would have seen and whether the proxy
// restores the originals on the way back. GET /last returns the last request and reply.
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 4010);
let last = null;

const TOKEN = /<[A-Z_]+_\d+>/g;

function replyFor(messages) {
  const user = [...messages].reverse().find((m) => m.role === 'user');
  const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? '');
  const tokens = [...new Set(text.match(TOKEN) ?? [])];
  const lines = tokens.length
    ? tokens.map((t) => `- I can see ${t} in your message.`)
    : ['- I could not see any placeholders, so I received your text as written.'];
  return ['Here is what reached me:', '', text, '', ...lines].join('\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/last') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(last));
    return;
  }

  if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
    const body = JSON.parse(await readBody(req));
    const content = replyFor(body.messages ?? []);
    last = { received: body, replied: content, at: new Date().toISOString() };
    const id = `chatcmpl-fake-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const piece of content.match(/.{1,12}/gs) ?? []) {
        const chunk = { id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        await new Promise((r) => setTimeout(r, 15));
      }
      const end = { id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      res.write(`data: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
      res.end();
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
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`fake LLM listening on :${PORT}`));
