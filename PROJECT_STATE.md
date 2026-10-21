# Claudia AI — Project State

> **Repo:** https://github.com/wmabra/claudia-ai · **Branch:** `master` · **Local path:** `~/github/claudia`
> **Note:** the local folder is `claudia/`, the GitHub repo is **`claudia-ai`** — do not look for `wmabra/claudia`.
> **Fresh-machine resume:** `git clone git@github.com:wmabra/claudia-ai.git && cd claudia-ai && npm install` then create `.env` from `.env.example` (see *Secrets*).
> **Last updated:** 2026-10-21 · **Last code change:** 2026-08-03 · **Status:** working voice agent, deployed on Render

## What this is

**Claudia** — a realtime Spanish-language voice agent for mental-health mentoring.
Browser app: hold-to-talk → speech-to-text → LLM → text-to-speech, over a WebSocket.

## Architecture (deliberately tiny — 2 dependencies)

```
public/index.html  ──WebSocket──▶  server.js  ──▶  Deepgram  (STT)
   (mic, WAV)                        (ws)    ──▶  DeepSeek  (LLM, knowledge-grounded)
                                     ▼       ──▶  ElevenLabs (TTS + cloned voice)
                              knowledge/claudia_raw.txt
                              (split on "\n--- " → retrieval over sections)
```

- `type: module`, deps are only `dotenv` + `ws`. Everything else is `fetch`.
- Default port **8787** (`PORT` overrides).
- Knowledge base = `knowledge/claudia_raw.txt`, split on `\n--- `, with a
  simple retrieval step (`knowledge/claudia.json` is the parsed form).

## Run locally

```bash
cd ~/github/claudia
npm install
cp .env.example .env      # then fill in the 4 keys
npm start                 # http://localhost:8787
```

## Deploy

**Render** (see `render.yaml`): web service `claudia`, node runtime 22, region oregon,
build `npm install`, start `npm start`, free plan. All four API keys are `sync: false`
— set them in the Render dashboard, not in the repo.

## Secrets (never in the repo)

| Key | Used for |
| --- | --- |
| `DEEPGRAM_API_KEY` | Speech-to-text |
| `DEEPSEEK_API_KEY` | The LLM |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | TTS + cloned voice (default voice id is in `.env.example`) |

## History / gotchas (painful ones — don't re-derive)

1. **Recording must be WAV.** Opus via MediaRecorder produced Deepgram 400s. Switched to WAV (`c2051bd`).
2. **MIME type must be passed from the browser** and `encoding` params set explicitly (`bc6bfd3`).
3. **Push-to-talk semantics:** hold to speak, release sends. Users found toggle confusing (`43c820c`).
4. `node_modules/` and `.pi-checkpoint-ignore` are gitignored.

## Next steps

Not scoped. Candidate ideas: barge-in (interrupt Claudia while she speaks),
conversation memory across sessions, and streaming STT instead of per-utterance POSTs.
