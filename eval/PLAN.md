# ChronicleDB Memory Eval

## Goal

Measure how well ChronicleDB's graph RAG retrieval helps an LLM recall specific details from a long roleplay history when the raw chat is too large to fit in the model's context window.

**Core question**: Does injecting the ChronicleDB `memoryBlock` on top of a context-limited chat tail help the model answer questions more correctly than the chat tail alone?

## Methodology

### Corpus

A single SillyTavern chat file (JSONL). Configure via `EVAL_CHAT_PATH` env var or edit `lib/corpus.ts`.

### Question generation (one-time)

`scripts/generate_questions.ts`:

1. Loads the chat → concatenates all messages into one narrative string
2. Picks N non-overlapping random 1000-character chunks (default 50, seed 42 — reproducible)
3. For each chunk, calls a strong LLM with: _"Read this passage and generate ONE specific question whose answer is clearly in the passage."_
4. Saves `{question, ground_truth, source_chunk}` to `questions.json`

Chunks span the entire chat, so most ground truths fall outside any context-limited tail window — that's the needle-in-haystack test.

### Conditions

For each question, run **6 conditions**:

| Condition | Context |
|---|---|
| `raw-16k-only` | char card + persona + last 16k tokens of chat |
| `raw-16k-plus-cdb` | char card + persona + ChronicleDB memory block + last 16k tokens of chat |
| `raw-32k-only` | char card + persona + last 32k tokens of chat |
| `raw-32k-plus-cdb` | char card + persona + ChronicleDB memory block + last 32k tokens of chat |
| `raw-55k-only` | char card + persona + last 55k tokens of chat |
| `raw-55k-plus-cdb` | char card + persona + ChronicleDB memory block + last 55k tokens of chat |

The chat tail loads from the back (most recent messages first), matching how SillyTavern builds prompts.

### Models

Three model tiers via the OpenAI-compatible proxy in `.env`:
- `STRONG_MODEL` — frontier (e.g., `claude-sonnet-4.6`)
- `MID_MODEL` — fast frontier (e.g., `gemini-2.5-pro`)
- `CHEAP_MODEL` — open-weight (e.g., `gemma-3-27b-it`)

### Matrix

50 questions × 3 models × 6 conditions = **900 model calls**, plus 900 judge calls.

### Retrieval

`lib/cdb-client.ts` calls PostgreSQL directly — no SillyTavern HTTP layer. Same graph + vector queries as the live ST plugin.

### Scoring

Strongest model judges each answer 0–2 against the ground truth chunk:
- 0 = wrong / "I don't know" / hallucinated
- 1 = partially correct
- 2 = fully correct

## Files

```
eval/
├── PLAN.md                 # This file
├── .env.example            # Proxy + DB credentials template
├── package.json            # tsx, pg, dotenv
├── lib/
│   ├── proxy.ts            # OpenAI-compatible proxy client w/ retry+backoff
│   ├── cdb-client.ts       # Direct PostgreSQL retrieval
│   └── corpus.ts           # Chat loader, chunker, character/persona cards
└── scripts/
    ├── generate_questions.ts   # one-time → questions.json
    ├── run_eval.ts             # incremental writes + --resume support
    ├── score.ts                # judge results
    └── report.ts               # markdown summary
```

## Usage

```bash
cd eval
npm install
cp .env.example .env       # fill in proxy credentials
# Configure your corpus via EVAL_CHAT_PATH / EVAL_CHAT_ID / etc.

# One-time: generate question set
npx tsx scripts/generate_questions.ts

# Run the eval (incremental writes; --resume picks up after a crash)
npx tsx scripts/run_eval.ts
# Smaller dry run:
npx tsx scripts/run_eval.ts --dry-run
# Resume:
npx tsx scripts/run_eval.ts --resume=results/run-<timestamp>.json

# Score and report
npx tsx scripts/score.ts results/run-<timestamp>.json
npx tsx scripts/report.ts results/run-<timestamp>.scored.json
```

## Reproducibility

- Question generation is seeded (default 42) — same seed picks the same chunks
- Models, sizes, and judge prompt are fixed in code
- `questions.json` is committed once per corpus and reused across runs

## Privacy

- `questions.json` and `results/` are gitignored — they contain raw chat content
- `.env` is gitignored
- All LLM traffic goes through your configured proxy — point it at whatever you trust
