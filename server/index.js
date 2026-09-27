import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import OpenAI from 'openai';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');

// Node 22+ loads .env without sending its contents to the browser.
if (existsSync(join(root, '.env'))) {
  process.loadEnvFile(join(root, '.env'));
}

// Lab 01 deliberately starts a fresh, single-turn session for every prompt.
// Session continuation is introduced in a later lab.
const agent = {
  model: process.env.OPENAI_MODEL || 'gpt-6-astra',
  instructions:
    'You are a friendly programming tutor. Answer clearly and concisely. ' +
    'When useful, include one short example. If you are unsure, say so.',
};

const port = Number(process.env.PORT || 5173);
const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--production');

const vite = isProduction
  ? null
  : await (await import('vite')).createServer({
      configFile: join(root, 'vite.config.js'),
      server: { middlewareMode: true },
    });

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 12_000) throw new Error('Request is too large.');
  }
  return JSON.parse(text);
}

function writeEvent(response, event) {
  response.write(`${JSON.stringify(event)}\n`);
}

async function handleRun(request, response, lab2 = false) {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_api_key_here') {
    sendJson(response, 503, { error: 'Add OPENAI_API_KEY to .env, then restart the server.' });
    return;
  }

  let prompt;
  let sessionId;
  let instructions;
  try {
    const body = await readJson(request);
    prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (lab2) {
      sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
    }
  } catch {
    sendJson(response, 400, { error: 'Send a valid JSON request with a prompt.' });
    return;
  }
  if (!prompt || prompt.length > 2000) {
    sendJson(response, 400, { error: 'Prompt must be between 1 and 2,000 characters.' });
    return;
  }
  if (lab2 && sessionId && (sessionId.length > 200 || !/^sess_[A-Za-z0-9_-]+$/.test(sessionId))) {
    sendJson(response, 400, { error: 'Invalid session ID.' });
    return;
  }
  if (lab2 && !sessionId && (!instructions || instructions.length > 4000)) {
    sendJson(response, 400, { error: 'Instructions must be between 1 and 4,000 characters.' });
    return;
  }

  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let stream;
  let completed = false;
  let sessionSent = false;
  const parts = new Map();
  const partKey = (event) => `${event.item_id}:${event.output_index}:${event.content_index}`;

  try {
    if (lab2 && sessionId) {
      writeEvent(response, { type: 'session', sessionId });
      sessionSent = true;
      writeEvent(response, { type: 'status', label: 'Continuing the same session' });
      // Open the event stream before sending input so the first events are captured.
      stream = await client.beta.agents.sessions.events.stream(sessionId);
      await client.beta.agents.sessions.events.create(sessionId, {
        events: [{
          type: 'agent.session.input.message',
          input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
        }],
      });
    } else {
      writeEvent(response, { type: 'status', label: 'Starting agent session' });
      stream = await client.beta.agents.sessions.create({
        agent: lab2 ? { ...agent, instructions } : agent,
        environment: { type: 'none' },
        input: prompt,
        stream: true,
      });
    }

    for await (const event of stream) {
      if (response.destroyed) break;
      if (lab2 && !sessionSent && event.session_id) {
        sessionId = event.session_id;
        sessionSent = true;
        writeEvent(response, { type: 'session', sessionId });
      }
      if (event.type === 'agent.session.turn.output_text.delta') {
        const key = partKey(event);
        parts.set(key, (parts.get(key) || '') + event.delta);
        writeEvent(response, { type: 'text', text: [...parts.values()].join('\n') });
      } else if (event.type === 'agent.session.turn.output_text.done') {
        parts.set(partKey(event), event.text);
        writeEvent(response, { type: 'text', text: [...parts.values()].join('\n') });
      } else if (event.type === 'agent.session.turn.completed' && event.turn?.subagent_id == null) {
        completed = true;
        writeEvent(response, { type: 'complete' });
        break;
      } else if (event.type === 'agent.session.turn.failed' && event.turn?.subagent_id == null) {
        throw new Error(event.turn.error?.message || 'The agent turn failed.');
      } else if (event.type === 'agent.session.turn.cancelled' && event.turn?.subagent_id == null) {
        throw new Error('The agent turn was cancelled.');
      } else if (event.type === 'error') {
        throw new Error(event.error?.message || 'The agent returned an error.');
      } else if (event.type === 'agent.session.failed' || event.type === 'agent.session.environment.failed') {
        throw new Error('The agent session failed.');
      }
    }
    if (!completed && !response.destroyed) throw new Error('The connection closed before the turn completed.');
    if (lab2 && completed && !sessionSent) throw new Error('The session finished without a session ID.');
  } catch (error) {
    if (!response.destroyed) {
      writeEvent(response, { type: 'error', message: error.message || 'Something went wrong.' });
    }
  } finally {
    stream?.controller?.abort();
    if (!response.destroyed) response.end();
  }
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createHttpServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/api/health' && request.method === 'GET') {
    sendJson(response, 200, {
      configured: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_api_key_here'),
      model: agent.model,
    });
    return;
  }
  if (path === '/api/run' && request.method === 'POST') {
    await handleRun(request, response);
    return;
  }
  if (path === '/api/lab2/run' && request.method === 'POST') {
    await handleRun(request, response, true);
    return;
  }
  if (path.startsWith('/api/')) {
    sendJson(response, 404, { error: 'API route not found.' });
    return;
  }
  if (vite) {
    vite.middlewares(request, response, () => {});
    return;
  }
  const file = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
  if (file !== dist && !file.startsWith(dist + sep)) {
    sendJson(response, 403, { error: 'Forbidden.' });
    return;
  }
  try {
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: 'Page not found.' });
  }
});

server.listen(port, () => console.log(`Agent Labs running at http://localhost:${port}`));
