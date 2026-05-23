/**
 * Generate a markdown report from a scored run.
 *
 * Usage: tsx scripts/report.ts results/run-<timestamp>.scored.json
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

interface ScoredResult {
  question_id: string;
  model: string;
  condition: string;
  answer: string;
  memory_block_chars: number;
  latency_ms: number;
  score: number;
  score_reason: string;
  error?: string;
}

interface Question {
  id: string;
  question: string;
  ground_truth: string;
}

function main() {
  const runFile = process.argv[2];
  if (!runFile) {
    console.error("Usage: tsx scripts/report.ts results/run-<timestamp>.scored.json");
    process.exit(1);
  }

  const runPath = resolve(runFile);
  if (!existsSync(runPath)) {
    console.error(`Not found: ${runPath}`);
    process.exit(1);
  }

  const runData = JSON.parse(readFileSync(runPath, "utf-8"));
  const scored: ScoredResult[] = runData.scored;
  const questions: Question[] = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "..", "questions.json"), "utf-8"),
  );
  const qMap = new Map(questions.map((q) => [q.id, q]));

  // Group by model × condition
  const grouped = new Map<string, ScoredResult[]>();
  for (const r of scored) {
    const key = `${r.model}::${r.condition}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  // Build summary table
  const models = [...new Set(scored.map((r) => r.model))].sort();
  const conditions = ["chronicle-db", "baseline"];

  let md = `# ChronicleDB Eval Report\n\n`;
  md += `- Run: ${runData.timestamp}\n`;
  md += `- Questions: ${runData.question_count}\n`;
  md += `- Dry run: ${runData.dry_run}\n\n`;

  md += `## Summary\n\n`;
  md += `| Model | Condition | Avg Score | Accuracy | Full | Partial | Wrong |\n`;
  md += `|---|---|---|---|---|---|---|\n`;

  for (const model of models) {
    for (const condition of conditions) {
      const rows = grouped.get(`${model}::${condition}`) || [];
      if (rows.length === 0) continue;
      const scores = rows.map((r) => r.score);
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const full = scores.filter((s) => s === 2).length;
      const partial = scores.filter((s) => s === 1).length;
      const wrong = scores.filter((s) => s === 0).length;
      const acc = ((full + partial * 0.5) / rows.length * 100).toFixed(1);
      md += `| ${model} | ${condition} | ${avg.toFixed(2)} | ${acc}% | ${full} | ${partial} | ${wrong} |\n`;
    }
  }

  // Win rate — how often chronicle-db beats baseline per model
  md += `\n## Win rate: chronicle-db vs baseline\n\n`;
  md += `| Model | CDB wins | Ties | Baseline wins |\n`;
  md += `|---|---|---|---|\n`;

  for (const model of models) {
    const cdb = grouped.get(`${model}::chronicle-db`) || [];
    const base = grouped.get(`${model}::baseline`) || [];
    const baseByQ = new Map(base.map((r) => [r.question_id, r.score]));
    let wins = 0, ties = 0, losses = 0;
    for (const r of cdb) {
      const bScore = baseByQ.get(r.question_id) ?? 0;
      if (r.score > bScore) wins++;
      else if (r.score === bScore) ties++;
      else losses++;
    }
    md += `| ${model} | ${wins} | ${ties} | ${losses} |\n`;
  }

  // Average memory block size
  md += `\n## Retrieval quality\n\n`;
  const cdbResults = scored.filter((r) => r.condition === "chronicle-db");
  const avgBlockSize =
    cdbResults.reduce((a, r) => a + r.memory_block_chars, 0) / cdbResults.length;
  md += `- Average memory block size: ${avgBlockSize.toFixed(0)} chars\n`;
  const errors = scored.filter((r) => r.error).length;
  md += `- Errors: ${errors}/${scored.length}\n`;

  // Interesting failures — questions where CDB got 0 but baseline also got 0
  md += `\n## Failure cases (both CDB and baseline failed)\n\n`;
  const failedQids = new Set<string>();
  for (const model of models) {
    const cdb = grouped.get(`${model}::chronicle-db`) || [];
    const base = grouped.get(`${model}::baseline`) || [];
    const baseByQ = new Map(base.map((r) => [r.question_id, r.score]));
    for (const r of cdb) {
      if (r.score === 0 && (baseByQ.get(r.question_id) ?? 0) === 0) {
        failedQids.add(r.question_id);
      }
    }
  }
  const failedList = [...failedQids].slice(0, 10);
  for (const qid of failedList) {
    const q = qMap.get(qid);
    if (!q) continue;
    md += `\n### ${qid}\n`;
    md += `- **Q**: ${q.question}\n`;
    md += `- **Truth**: ${q.ground_truth.slice(0, 200)}\n`;
  }

  // CDB wins — questions where chronicle-db beat baseline significantly
  md += `\n## ChronicleDB wins (where it helped)\n\n`;
  const winQids = new Set<string>();
  for (const model of models) {
    const cdb = grouped.get(`${model}::chronicle-db`) || [];
    const base = grouped.get(`${model}::baseline`) || [];
    const baseByQ = new Map(base.map((r) => [r.question_id, r.score]));
    for (const r of cdb) {
      if (r.score === 2 && (baseByQ.get(r.question_id) ?? 0) === 0) {
        winQids.add(r.question_id);
      }
    }
  }
  const winList = [...winQids].slice(0, 10);
  for (const qid of winList) {
    const q = qMap.get(qid);
    if (!q) continue;
    md += `\n### ${qid}\n`;
    md += `- **Q**: ${q.question}\n`;
  }

  const outPath = runPath.replace(/\.scored\.json$/, ".report.md");
  writeFileSync(outPath, md);
  console.log(md);
  console.log(`\nWrote report to ${outPath}`);
}

main();
