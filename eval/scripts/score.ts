/**
 * Score a run file using the strongest model as judge.
 *
 * Usage: tsx scripts/score.ts results/run-<timestamp>.json
 *
 * Writes a scored file next to the input: run-<timestamp>.scored.json
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { chat } from "../lib/proxy.js";

const JUDGE_MODEL = process.env.JUDGE_MODEL || "claude-sonnet-4-5";

interface Question {
  id: string;
  question: string;
  ground_truth: string;
}

interface AnswerResult {
  question_id: string;
  model: string;
  condition: string;
  answer: string;
  memory_block_chars: number;
  latency_ms: number;
  error?: string;
}

interface ScoredResult extends AnswerResult {
  score: number;
  score_reason: string;
}

const JUDGE_PROMPT = `You are grading answers to questions about a roleplay story.

Question: {question}
Ground truth passage: {ground_truth}
Answer given: {answer}

Score 0-2:
- 0 = wrong, "I don't know", or hallucinated
- 1 = partially correct (got some of it, missed details, or added minor errors)
- 2 = fully correct (captures the essential answer)

Respond with ONLY valid JSON: {"score": 0|1|2, "reason": "one sentence"}`;

async function judge(
  question: string,
  groundTruth: string,
  answer: string,
): Promise<{ score: number; reason: string }> {
  const prompt = JUDGE_PROMPT
    .replace("{question}", question)
    .replace("{ground_truth}", groundTruth)
    .replace("{answer}", answer || "(empty)");

  const response = await chat(
    JUDGE_MODEL,
    [{ role: "user", content: prompt }],
    { temperature: 0, max_tokens: 200 },
  );

  // Parse JSON
  let jsonText = response.trim();
  const fenceMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) jsonText = fenceMatch[1].trim();
  const firstBrace = jsonText.indexOf("{");
  const lastBrace = jsonText.lastIndexOf("}");
  if (firstBrace === -1) {
    return { score: 0, reason: "judge response could not be parsed" };
  }
  try {
    const parsed = JSON.parse(jsonText.slice(firstBrace, lastBrace + 1));
    return {
      score: Math.max(0, Math.min(2, parseInt(parsed.score) || 0)),
      reason: parsed.reason || "",
    };
  } catch {
    return { score: 0, reason: "judge JSON parse failed" };
  }
}

async function main() {
  const runFile = process.argv[2];
  if (!runFile) {
    console.error("Usage: tsx scripts/score.ts results/run-<timestamp>.json");
    process.exit(1);
  }

  const runPath = resolve(runFile);
  if (!existsSync(runPath)) {
    console.error(`Not found: ${runPath}`);
    process.exit(1);
  }

  const questionsPath = resolve(import.meta.dirname, "..", "questions.json");
  const questions: Question[] = JSON.parse(readFileSync(questionsPath, "utf-8"));
  const qMap = new Map(questions.map((q) => [q.id, q]));

  const runData = JSON.parse(readFileSync(runPath, "utf-8"));
  const results: AnswerResult[] = runData.results;

  console.log(`Scoring ${results.length} answers via ${JUDGE_MODEL}...`);

  const scored: ScoredResult[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const q = qMap.get(r.question_id);
    if (!q) {
      scored.push({ ...r, score: 0, score_reason: "question not found" });
      continue;
    }
    if (r.error || !r.answer) {
      scored.push({ ...r, score: 0, score_reason: r.error || "no answer" });
      continue;
    }

    process.stdout.write(`[${i + 1}/${results.length}] ${r.question_id} ${r.model} ${r.condition}... `);
    try {
      const { score, reason } = await judge(q.question, q.ground_truth, r.answer);
      scored.push({ ...r, score, score_reason: reason });
      console.log(`${score}/2`);
    } catch (err) {
      scored.push({ ...r, score: 0, score_reason: (err as Error).message });
      console.log("error");
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  const outPath = runPath.replace(/\.json$/, ".scored.json");
  writeFileSync(
    outPath,
    JSON.stringify({ ...runData, scored }, null, 2),
  );
  console.log(`\nWrote scored results to ${outPath}`);
  console.log(`Next: tsx scripts/report.ts ${outPath}`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
