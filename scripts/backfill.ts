import { loadConfig } from "../src/config.js";
import { backfill } from "../src/backfill/backfill.js";
import { closePool } from "../src/db/connection.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const characterFilter = args
  .find((a) => a.startsWith("--character="))
  ?.split("=")[1];

async function main() {
  const config = loadConfig();

  console.log("=== ChronicleDB Backfill ===");
  console.log(`Data root: ${config.sillytavern.dataRoot}`);
  console.log(`Extraction model: ${config.extraction.model}`);
  console.log(`Dry run: ${dryRun}`);
  if (characterFilter) {
    console.log(`Character filter: ${characterFilter}`);
  }
  console.log();

  const result = await backfill(config, {
    dryRun,
    characterFilter,
    onProgress: (p) => {
      const pct = p.total > 0 ? ((p.done / p.total) * 100).toFixed(1) : "0";
      process.stdout.write(
        `\r[${pct}%] ${p.done}/${p.total} files | errors: ${p.errors} | current: ${p.currentFile.split("/").pop()}`,
      );
    },
  });

  console.log("\n");
  console.log("=== Backfill Complete ===");
  console.log(`Total:  ${result.total}`);
  console.log(`Done:   ${result.done}`);
  console.log(`Errors: ${result.errors}`);

  await closePool();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
