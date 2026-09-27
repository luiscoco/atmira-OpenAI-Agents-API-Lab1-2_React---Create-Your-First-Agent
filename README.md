# Lab 01 — Create your first agent

The first of 50 hands-on labs for learning the OpenAI Agents API. This lab builds a React 19.3 + Vite interface and a small Node server. The server creates a fresh agent session for each question and streams the answer to the browser. The API key stays on the server. **Lab 02 is also implemented** in this app: see [LAB02.md](LAB02.md) for the conversation and instructions walkthrough.

See [CURRICULUM.md](CURRICULUM.md) for the proposed 50-lab sequence.

## What students learn

1. **Agent:** a model and instructions define the tutor's role.
2. **Session:** the Agents API creates a session for the work.
3. **Turn and events:** sending a prompt starts a turn, and text events arrive as it runs.

This first lab uses `environment: { type: 'none' }` because the tutor only answers questions. It deliberately starts a new session for every prompt. The sidebar opens the implemented Lab 02 lessons, which reuse a session for follow-ups.

## Prerequisites

- Node.js 22 or newer
- An OpenAI API key with `api.agents.read`, `api.agents.write`, and `api.responses.write` access
- Access to the model set in `OPENAI_MODEL` (default: `gpt-6-astra`)

## Run it

```powershell
npm ci
Copy-Item .env.example .env
notepad .env
npm run dev
```

Replace `your_api_key_here` in `.env` with your own key, save it, and open <http://localhost:5173>. Restart the server after changing `.env`. Never place a real key in `.env.example` or browser code. The local `.env` is excluded by `.gitignore`.

For a production build, stop the development server, run `npm run build`, then `npm run start`.

## Explore the code

- `server/index.js`: server-only API key, agent definition, session creation, event handling
- `src/App.jsx`: React form, response stream reader, and UI states
- `src/styles.css`: responsive lab interface

The bottom of the app includes a collapsible code section with four annotated, syntax-highlighted excerpts for teaching the agent definition, session creation, streamed events, and React response display. Each card has a **Viva voice** button that reads its title and explanation aloud using the browser's built-in speech synthesis. It prefers an available masculine English voice. If the browser has none, it uses an available English voice at a lower pitch; the exact voice depends on the voices installed on the student's device. Press the button again to stop, or choose another card to hear that explanation instead.

Try changing the agent's instructions in `server/index.js`, restart the server, and compare the response to the same prompt. Next, change `OPENAI_MODEL` in `.env` to a model available to your project.

The Agents API currently uses the beta namespace in the JavaScript SDK. See the [official Agents API quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart) and [event guide](https://developers.openai.com/api/docs/guides/agents-api/sessions/events).

## How the app works

```text
Student → React prompt form → POST /api/run → Node server → Agents API
Student ← Markdown response ← newline-delimited JSON ← streamed events
```

The browser sends questions to the local Node server. The server holds the API key, starts the agent session, and forwards simple updates to React. Each question starts a **fresh** session. Continuing a conversation is planned for Lab 02.

## Implementation, step by step

### 1. Set up the React and Node project

`package.json` defines `dev`, `build`, and `start` scripts. `dev` runs `server/index.js`, which loads Vite as middleware so one local address serves both the React page and API routes. `build` creates the browser bundle in `dist`; `start` serves that bundle. The app uses React 19.3, the OpenAI JavaScript SDK, `react-markdown`, `remark-gfm`, and Prism.

**Teaching point:** React code is downloaded by the browser. Keep the secret key and SDK call in the Node process.

### 2. Load configuration and define the tutor

At startup, `server/index.js` loads the local `.env` file and prepares an inline agent configuration:

```js
if (existsSync(join(root, '.env'))) {
  process.loadEnvFile(join(root, '.env'));
}

const agent = {
  model: process.env.OPENAI_MODEL || 'gpt-6-astra',
  instructions:
    'You are a friendly programming tutor. Answer clearly and concisely. ' +
    'When useful, include one short example. If you are unsure, say so.',
};
```

**Teaching point:** The model produces the answer. The instructions give the tutor its role and response style. This lab passes the configuration directly to each session; it does not create a reusable saved agent.

### 3. Validate the question and create a session

The `POST /api/run` route rejects malformed JSON, a missing key, and prompts outside the 1–2,000 character limit. Once the prompt is valid, the server starts an Agents API session:

```js
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
stream = await client.beta.agents.sessions.create({
  agent,
  environment: { type: 'none' },
  input: prompt,
  stream: true,
});
```

**Teaching point:** `input` is the first user prompt. `stream: true` makes progress events available while the answer is generated. The `none` environment fits a question-answering tutor that does not run commands or use local files. The [Agents API quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart) documents this option.

### 4. Convert API events into browser updates

The server iterates through the event stream. These excerpts show the main cases; the full handler also covers errors, cancellation, early disconnection, and stream cleanup:

```js
if (event.type === 'agent.session.turn.output_text.delta') {
  const key = partKey(event);
  parts.set(key, (parts.get(key) || '') + event.delta);
  writeEvent(response, {
    type: 'text',
    text: [...parts.values()].join('\n'),
  });
} else if (event.type === 'agent.session.turn.output_text.done') {
  parts.set(partKey(event), event.text);
  writeEvent(response, {
    type: 'text',
    text: [...parts.values()].join('\n'),
  });
} else if (event.type === 'agent.session.turn.completed' && event.turn?.subagent_id == null) {
  writeEvent(response, { type: 'complete' });
}
```

**Teaching point:** A *delta* is one piece of output. `partKey` combines the event's item, output, and content indexes so pieces from separate parts do not overwrite each other. A `done` event supplies the final text for its part, even when deltas are absent. The server forwards each update as one newline-delimited JSON record. It considers the run complete only after the root turn's completed event, not merely when the connection closes. See the [Agents API events guide](https://developers.openai.com/api/docs/guides/agents-api/sessions/events).

### 5. Read the stream in React

`runAgent` in `src/App.jsx` posts the question to the local server. It reads response chunks and holds unfinished JSON lines until the next chunk:

```js
const response = await fetch('/api/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt }),
});
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

// Inside the read loop:
buffer += decoder.decode(value, { stream: true });
const lines = buffer.split('\n');
buffer = lines.pop();
for (const line of lines) {
  if (line) onEvent(JSON.parse(line));
}
```

**Teaching point:** Network chunks need not end at JSON boundaries. `buffer` prevents a partial record from being parsed too early. The full function also handles HTTP errors, streamed errors, and a missing completion event.

The form's event handler updates React state when text arrives:

```jsx
if (item.type === 'text') {
  setAnswer(item.text);
  setMessage('Streaming response');
}
```

### 6. Display readable Markdown and code

The response panel uses `react-markdown` with `remark-gfm` to render headings, bold text, lists, tables, and code rather than showing raw Markdown marks:

```jsx
<ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
  {answer}
</ReactMarkdown>
```

The actual component also opens links in a new tab with safe `rel` attributes. `skipHtml` keeps raw HTML in the answer from becoming page HTML.

The collapsible **View code** area teaches four steps: define the agent, start a session, forward the answer, and display it in React. Each card pairs a snippet with a plain-language explanation. Prism tokenizes the JavaScript so CSS can color keywords, strings, functions, and other syntax.

### 7. Read each explanation aloud

Each card has a **Viva voice · Read aloud** button. The browser's speech synthesis reads its title and explanation; this does not make another OpenAI API call. The key part of `toggleSpeech` is:

```js
const narrator = selectNarratorVoice(
  voices.length ? voices : window.speechSynthesis.getVoices()
);
const utterance = new SpeechSynthesisUtterance(
  `${lesson.title}. ${lesson.explanation}`
);
if (narrator) utterance.voice = narrator;
utterance.lang = narrator?.lang || 'en-US';
utterance.pitch = narrator && masculineVoiceName.test(narrator.name) ? 1 : 0.78;
window.speechSynthesis.speak(utterance);
```

**Teaching point:** The app prefers a recognized masculine English voice installed in the browser. If none is available, it uses an English voice at a lower pitch; the precise sound depends on the student's device. Pressing the same button stops playback, pressing another card switches explanations, and closing **View code** also stops playback.

## Practice exercise

1. Ask “What is the difference between an agent and a chatbot?” and watch the response stream in.
2. Open **View code** and connect each card to what happened on screen.
3. Play one Viva voice explanation, switch cards, then close the section during playback.
4. Change `agent.instructions` in `server/index.js`, restart the server, and ask the same question. Compare the answers.

The live run needs a valid key, permissions, model access, and an API connection. Students can still inspect the code cards without making an API request.
