import { workerPlan } from "../src/lib/pack";

const projectId = process.argv[2];
if (!projectId) {
  console.log("Usage: npx tsx scripts/pack-worker.ts <projectId>");
  console.log("Optional self-hosted pack. The MIT studio does not need it.");
  process.exit(0);
}

const plan = workerPlan(projectId);
console.log(JSON.stringify(plan, null, 2));
process.exit(0);
