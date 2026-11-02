import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const KEV_ROOT = process.env.KEV_ROOT;
const PORT = Number(process.env.KEV_PORT ?? 8011);
const URL = `http://127.0.0.1:${PORT}`;
const MODEL = process.env.KEV_MODEL ?? "jaredpalmer/kev-0.8b@v1.0";
const SAFE_CHARS = 27_000; // ~6.75k tokens; Kev-0.8B is validated through 8k.
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
const IDLE_MS = 5 * 60_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "dist", "build", ".next", "coverage", "__pycache__", "vendor", ".cache"]);
const TEXT_EXTS = new Set([".c", ".cc", ".cpp", ".css", ".csv", ".eml", ".go", ".html", ".ini", ".java", ".js", ".json", ".jsx", ".mjs", ".cjs", ".md", ".mbox", ".py", ".rb", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml"]);
const DOCUMENT_EXTS = new Set([".pdf", ".doc", ".docx", ".rtf", ".xls", ".xlsx", ".ppt", ".pptx", ".ods", ".odp"]);
const ANYDOC = process.env.KEV_ANYDOC ?? "anydoc";
const RESULTS_DIR = path.resolve(process.env.KEV_RESULTS_DIR ?? path.join(homedir(), ".pi", "agent", "kev-results"));

type Source = { path?: string; text?: string };
type InputMode = "content" | "metadata" | "inline";
type Question = { id: string; instruction: string; choices: string[] };
type Answer = { probabilities: Record<string, number> };
type DecisionResponse = { answers: Record<string, Answer> };
type DecisionResult = { answer: string; confidence: number; probabilities: Record<string, number>; evidence: { start: number; end: number } };
type FileResult = { source: string; input?: InputMode; reason?: string; chunks?: number; results?: Record<string, DecisionResult>; skipped?: string };
type Job = { id: string; status: "queued" | "running" | "complete" | "failed"; queuedAt: string; startedAt?: string; completedAt?: string; durationMs?: number; total: number; completed: number; results: FileResult[]; error?: string };
let server: ReturnType<typeof spawn> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queue = Promise.resolve();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function healthy() {
  try { return (await fetch(`${URL}/v1/models`, { signal: AbortSignal.timeout(500) })).ok; }
  catch { return false; }
}

async function ensureServer() {
  if (await healthy()) return;
  if (!KEV_ROOT) throw new Error("Set KEV_ROOT to a local clone of https://github.com/jaredpalmer/kev.");
  server = spawn("uv", ["run", "--extra", "serve", "python", "-m", "kev.serve", "--run", MODEL, "--port", String(PORT)], {
    cwd: KEV_ROOT, stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (await healthy()) return;
    if (server.exitCode !== null) throw new Error(`Kev server exited while starting. Run \`cd ${KEV_ROOT} && uv sync --extra serve\`.`);
  }
  throw new Error("Kev did not become ready within 20 seconds.");
}

function deferStop() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { server?.kill(); server = undefined; }, IDLE_MS);
}

function contentFile(file: string) {
  const name = path.basename(file).toLowerCase();
  return name === ".env" || name.startsWith(".env.") || TEXT_EXTS.has(path.extname(file).toLowerCase()) || DOCUMENT_EXTS.has(path.extname(file).toLowerCase());
}

async function filesAt(input: string, maxFiles: number) {
  const root = path.resolve(input);
  const stat = await fs.stat(root);
  if (stat.isFile()) return [root];
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (found.length >= maxFiles) return;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(target);
      } else if (entry.isFile() && contentFile(target)) {
        try {
          await fs.access(target, constants.R_OK);
          found.push(target);
        } catch {
          // Ignore unreadable files during directory expansion.
        }
      }
    }
  }
  await walk(root);
  return found;
}

async function readInput(file: string): Promise<{ input: InputMode; reason?: string; text: string }> {
  const stat = await fs.stat(file);
  const ext = path.extname(file).toLowerCase();
  const metadata = (reason: string) => ({
    input: "metadata" as const,
    reason,
    text: `Input mode: metadata only\nPath: ${file}\nSize: ${stat.size} bytes\nModified: ${stat.mtime.toISOString()}\nExtension: ${ext || "(none)"}\nReason: ${reason}`,
  });
  if (!contentFile(file)) return metadata(`unsupported extension ${ext || "(none)"}`);
  if (stat.size > MAX_CONTENT_BYTES) return metadata(`file exceeds ${MAX_CONTENT_BYTES} byte content limit`);
  const text = TEXT_EXTS.has(ext) || path.basename(file).toLowerCase().startsWith(".env")
    ? await fs.readFile(file, "utf8")
    : await command(ANYDOC, [file]);
  return { input: "content", text: `Input mode: extracted content\nPath: ${file}\n\n${text}` };
}

function command(bin: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", b => {
      out += b;
      if (out.length > MAX_CONTENT_BYTES) child.kill();
    });
    child.stderr.on("data", b => err += b);
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(out) : reject(new Error(out.length > MAX_CONTENT_BYTES ? "extracted text exceeds content limit" : err || `${bin} exited ${code}`)));
  });
}

function chunks(text: string) {
  if (text.length <= SAFE_CHARS) return [{ text, start: 0, end: text.length }];
  const result: { text: string; start: number; end: number }[] = [];
  for (let start = 0; start < text.length; start += SAFE_CHARS - 800) {
    let end = Math.min(text.length, start + SAFE_CHARS);
    if (end < text.length) end = text.lastIndexOf("\n", end) || end;
    result.push({ text: text.slice(start, end), start, end });
    if (end === text.length) break;
  }
  return result;
}

async function decide(text: string, questions: Question[]) {
  const body = {
    model: "kev-latest", state: text,
    questions: Object.fromEntries(questions.map(q => [q.id, { type: "choice", instructions: q.instruction, criteria: Object.fromEntries(q.choices.map(c => [c, ""])) }])),
  };
  const response = await fetch(`${URL}/v1/systemone`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Kev ${response.status}: ${await response.text()}`);
  return response.json() as Promise<DecisionResponse>;
}

function merge(parts: Array<{ answer: Answer; range: { start: number; end: number } }>, question: Question) {
  const totals = Object.fromEntries(question.choices.map(c => [c, 0])) as Record<string, number>;
  for (const part of parts) for (const [label, score] of Object.entries(part.answer.probabilities)) totals[label] += Number(score);
  for (const label of question.choices) totals[label] /= parts.length;
  const answer = question.choices.reduce((best, label) => totals[label] > totals[best] ? label : best, question.choices[0]);
  const evidence = parts.reduce((best, part) => Number(part.answer.probabilities[answer]) > Number(best.answer.probabilities[answer]) ? part : best).range;
  return { answer, confidence: Math.round(totals[answer] * 10_000) / 10_000, probabilities: totals, evidence };
}

export default function (pi: ExtensionAPI) {
  const jobs = new Map<string, Job>();

  async function save(job: Job) {
    await fs.mkdir(RESULTS_DIR, { recursive: true });
    await fs.writeFile(path.join(RESULTS_DIR, `${job.id}.json`), JSON.stringify(job, null, 2));
  }

  function report(job: Job, complete = false) {
    const summary = { job_id: job.id, status: job.status, completed: job.completed, total: job.total, result_total: job.results.length, error: job.error }; 
    pi.sendMessage({
      customType: "kev_decide",
      content: JSON.stringify(complete ? { ...summary, note: "Use kev_decide_status with offset and limit to retrieve result pages." } : summary),
      display: true,
      details: summary,
    }, { triggerTurn: complete, deliverAs: complete ? "followUp" : "nextTurn" });
  }

  async function runJob(job: Job, args: { sources: Array<string | Source>; questions: Question[]; limits?: { max_files?: number; max_tokens_per_file?: number } }) {
    const started = Date.now();
    job.status = "running";
    job.startedAt = new Date(started).toISOString();
    try {
      await ensureServer(); deferStop();
      const maxFiles = args.limits?.max_files ?? Number.POSITIVE_INFINITY;
      const sources: Source[] = [];
      for (const source of args.sources) {
        if (sources.length >= maxFiles) break;
        if (typeof source === "string") {
          sources.push(...(await filesAt(source, maxFiles - sources.length)).map(file => ({ path: file })));
        } else if (source.text !== undefined) {
          sources.push(source);
        } else if (source.path) {
          sources.push(...(await filesAt(source.path, maxFiles - sources.length)).map(file => ({ path: file })));
        } else {
          throw new Error("Each source must provide text or a path.");
        }
      }
      job.total = sources.length;
      report(job);
      for (const source of sources) {
        const name = source.path ?? "inline";
        try {
          const data = source.text === undefined ? await readInput(source.path!) : { input: "inline" as const, text: source.text };
          let text = data.text;
          if (args.limits?.max_tokens_per_file) text = text.slice(0, args.limits.max_tokens_per_file * 4);
          const parts = chunks(text);
          const answers: Array<{ answers: DecisionResponse["answers"]; range: { start: number; end: number } }> = [];
          for (const part of parts) answers.push({ answers: (await decide(part.text, args.questions)).answers, range: { start: part.start, end: part.end } });
          job.results.push({ source: name, input: data.input, reason: data.reason, chunks: parts.length, results: Object.fromEntries(args.questions.map(q => [q.id, merge(answers.map(a => ({ answer: a.answers[q.id], range: a.range })), q)])) });
        } catch (error) {
          job.results.push({ source: name, skipped: String(error instanceof Error ? error.message : error) });
        }
        job.completed++;
      }
      job.status = "complete";
      job.completedAt = new Date().toISOString();
      job.durationMs = Date.now() - started;
      await save(job);
      report(job, true);
    } catch (error) {
      job.status = "failed";
      job.error = String(error instanceof Error ? error.message : error);
      job.completedAt = new Date().toISOString();
      job.durationMs = Date.now() - started;
      await save(job).catch(() => undefined);
      report(job, true);
    }
  }

  pi.registerTool({
    name: "kev_decide", label: "Kev decide",
    description: "Queue a local Kev 0.8B fixed-choice decision over supplied text, files, or folders. Folder inputs expand recursively to readable supported files, are processed internally, and report per-file results in pages.",
    promptSnippet: "kev_decide: background local fixed-choice decisions",
    promptGuidelines: ["Use kev_decide for fixed-choice decisions over supplied text, local files, or folders instead of open-ended summaries.", "Use kev_decide_status with pagination for folder-wide jobs; do not request all results at once."],
    parameters: Type.Object({
      sources: Type.Array(Type.Union([Type.String(), Type.Object({ path: Type.Optional(Type.String()), text: Type.Optional(Type.String()) })]), { minItems: 1 }),
      questions: Type.Array(Type.Object({ id: Type.String(), instruction: Type.String(), choices: Type.Array(Type.String(), { minItems: 2, maxItems: 12 }) }), { minItems: 1, maxItems: 16 }),
      limits: Type.Optional(Type.Object({ max_files: Type.Optional(Type.Integer({ minimum: 1 })), max_tokens_per_file: Type.Optional(Type.Integer({ minimum: 256, maximum: 7500 })) })),
    }),
    async execute(_id, args: { sources: Array<string | Source>; questions: Question[]; limits?: { max_files?: number; max_tokens_per_file?: number } }) {
      const job: Job = { id: randomUUID(), status: "queued", queuedAt: new Date().toISOString(), total: 0, completed: 0, results: [] };
      jobs.set(job.id, job);
      const next = queue.then(() => runJob(job, args), () => runJob(job, args));
      queue = next.then(() => undefined, () => undefined);
      void next;
      return { content: [{ type: "text" as const, text: JSON.stringify({ job_id: job.id, status: job.status, note: "Kev decision is running in the background. Use kev_decide_status for progress; completion is sent back automatically." }) }], details: { job_id: job.id, status: job.status } };
    },
  });

  pi.registerTool({
    name: "kev_decide_status", label: "Kev decide status",
    description: "Get progress or a paginated result page for a background Kev decision job.",
    promptSnippet: "Kev decision job progress and paginated results",
    promptGuidelines: ["Use kev_decide_status to inspect a queued Kev decision job. For folder-wide jobs, request small result pages with offset and limit."],
    parameters: Type.Object({ job_id: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    async execute(_id, args: { job_id: string; offset?: number; limit?: number }) {
      const job = jobs.get(args.job_id);
      if (!job) throw new Error(`Unknown Kev decision job ${args.job_id}`);
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 25;
      const page = job.results.slice(offset, offset + limit);
      return { content: [{ type: "text" as const, text: JSON.stringify({ job_id: job.id, status: job.status, completed: job.completed, total: job.total, result_total: job.results.length, offset, limit, results: page, error: job.error }, null, 2) }], details: { job_id: job.id, status: job.status, completed: job.completed, total: job.total, result_total: job.results.length, offset, limit } };
    },
  });
}
