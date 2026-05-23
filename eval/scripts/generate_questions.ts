/**
 * Generate 50 needle-in-haystack questions from the Majima 457-msg chat.
 * Run ONCE to create questions.json. The main eval reads from that file,
 * so you can re-run the eval against the same fixed question set.
 *
 * Usage: tsx scripts/generate_questions.ts [count]
 *
 * If questions.json already exists, this refuses to overwrite unless
 * you pass --force.
 */

import "dotenv/config";
import { writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { loadCorpus, pickChunks } from "../lib/corpus.js";
import { chat } from "../lib/proxy.js";

const OUTPUT_PATH = resolve(import.meta.dirname, "..", "questions.json");
const QUESTION_GEN_MODEL = process.env.QGEN_MODEL || "claude-sonnet-4-5";

interface Question {
  id: string;
  question: string;
  ground_truth: string;
  source_chunk: string;
  chunk_offset: number;
}

const QUESTION_PROMPT = `Read this passage from a roleplay story and generate ONE specific question whose answer is clearly in the passage.

Rules:
- The question should be SPECIFIC (ask about a concrete detail, action, relationship, or item) — not vague like "what happens?"
- The question should be NATURAL, phrased as if asking a friend who read the story
- The answer should be extractable from the passage text
- Avoid questions that require knowledge from outside this passage
- The question should be answerable in 1-2 sentences

Return ONLY valid JSON (no markdown fences, no explanation):
{"question": "...", "ground_truth": "..."}

Passage:
---
{passage}
---`;

async function generateQuestionForChunk(
  chunk: string,
  offset: number,
  idx: number,
): Promise<Question | null> {
  const prompt = QUESTION_PROMPT.replace("{passage}", chunk);

  try {
    const response = await chat(
      QUESTION_GEN_MODEL,
      [{ role: "user", content: prompt }],
      { temperature: 0.3, max_tokens: 500 },
    );

    // Parse JSON, handling any stray markdown fences
    let jsonText = response.trim();
    const fenceMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) jsonText = fenceMatch[1].trim();

    const firstBrace = jsonText.indexOf("{");
    const lastBrace = jsonText.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1) {
      console.warn(`  Q${idx}: no JSON found in response`);
      return null;
    }
    const parsed = JSON.parse(jsonText.slice(firstBrace, lastBrace + 1));

    if (!parsed.question || !parsed.ground_truth) {
      console.warn(`  Q${idx}: missing fields`);
      return null;
    }

    return {
      id: `q-${String(idx + 1).padStart(3, "0")}`,
      question: parsed.question,
      ground_truth: parsed.ground_truth,
      source_chunk: chunk,
      chunk_offset: offset,
    };
  } catch (err) {
    console.warn(`  Q${idx}: error —`, (err as Error).message);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const countArg = args.find((a) => !a.startsWith("--"));
  const targetCount = countArg ? parseInt(countArg) : 50;

  if (existsSync(OUTPUT_PATH) && !force) {
    console.error(`${OUTPUT_PATH} already exists. Use --force to overwrite.`);
    process.exit(1);
  }

  console.log("Loading Majima 457-msg corpus...");
  const { fullText, messageCount } = loadCorpus();
  console.log(`  ${messageCount} messages, ${fullText.length} chars`);

  console.log(`Picking ${targetCount} random 1000-char chunks (seed: 42)...`);
  const chunks = pickChunks(fullText, targetCount, 1000, 42);
  console.log(`  ${chunks.length} chunks selected`);

  console.log(`\nGenerating questions via ${QUESTION_GEN_MODEL}...`);
  const questions: Question[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const { chunk, offset } = chunks[i];
    process.stdout.write(`  [${i + 1}/${chunks.length}] offset=${offset}... `);
    const q = await generateQuestionForChunk(chunk, offset, i);
    if (q) {
      questions.push(q);
      console.log(`ok — "${q.question.slice(0, 60)}..."`);
    }
    // Rate limit: 500ms between calls
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n${questions.length} questions generated.`);
  writeFileSync(OUTPUT_PATH, JSON.stringify(questions, null, 2));
  console.log(`Saved to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
