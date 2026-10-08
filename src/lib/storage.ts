import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  AppSettings,
  ComfyWorkflowId,
  DEFAULT_SEAM_FADE_SEC,
  DEFAULT_SETTINGS,
  EMPTY_RATES,
  Job,
  JobKind,
  JobStatus,
  Project,
  ProviderId,
  RateTable,
  SAMPLE_PROJECT_ID,
  SeamMode,
  Shot,
  clampSeamFade,
  presetById,
} from "./types";

type DB = Database.Database;

const globalForDb = globalThis as unknown as { starDustDb?: DB };

function dataRoot(): string {
  return process.env.STAR_DUST_DATA
    ? path.resolve(process.env.STAR_DUST_DATA)
    : path.join(process.cwd(), "data");
}

function uploadsDir(): string {
  return path.join(dataRoot(), "uploads");
}

function outputsDir(): string {
  return path.join(dataRoot(), "outputs");
}

function posix(...parts: string[]): string {
  return path.join(...parts).split(path.sep).join("/");
}

function ensureDataDirs() {
  for (const dir of [dataRoot(), uploadsDir(), outputsDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function openDatabase(): DB {
  ensureDataDirs();
  const db = new Database(path.join(dataRoot(), "star-dust.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      character_sheet_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      comfyui_workflow TEXT,
      comfy_low_memory INTEGER,
      seam_mode TEXT NOT NULL DEFAULT 'cut',
      seam_fade_sec REAL NOT NULL DEFAULT 0.5
    );
    CREATE TABLE IF NOT EXISTS shots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      preset_id TEXT NOT NULL,
      duration_sec REAL NOT NULL,
      start_image_path TEXT,
      end_image_path TEXT,
      selected_job_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      comfyui_workflow TEXT,
      comfy_low_memory INTEGER,
      chain_from_previous INTEGER NOT NULL DEFAULT 0,
      chained_start_image_path TEXT,
      chained_from_job_id TEXT,
      seam_mode TEXT,
      seam_fade_sec REAL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      shot_id TEXT,
      prompt TEXT NOT NULL,
      preset_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'take',
      status TEXT NOT NULL,
      image_path TEXT NOT NULL,
      end_image_path TEXT,
      character_sheet_path TEXT,
      character_note TEXT,
      provider_note TEXT,
      output_path TEXT,
      error TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      model_name TEXT,
      duration_sec REAL,
      remote_id TEXT,
      await_previous_frame INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL,
      comfyui_base_url TEXT NOT NULL,
      fal_model TEXT NOT NULL,
      replicate_model TEXT NOT NULL,
      rates_json TEXT NOT NULL DEFAULT '{}',
      budget_cap REAL,
      comfyui_workflow TEXT NOT NULL DEFAULT 'svd',
      comfy_low_memory INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_shots_project ON shots(project_id, position);
    CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_shot ON jobs(shot_id);
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id TEXT PRIMARY KEY,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      stripe_session_id TEXT,
      paypal_order_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_session
      ON credit_ledger(stripe_session_id)
      WHERE stripe_session_id IS NOT NULL;
  `);
  migrate(db);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_paypal
      ON credit_ledger(paypal_order_id)
      WHERE paypal_order_id IS NOT NULL;
  `);
  const settings = db.prepare("SELECT id FROM settings WHERE id = 1").get();
  if (!settings) {
    db.prepare(
      `INSERT INTO settings (
        id, provider, comfyui_base_url, fal_model, replicate_model,
        rates_json, budget_cap, comfyui_workflow
      ) VALUES (1, ?, ?, ?, ?, ?, NULL, ?)`
    ).run(
      DEFAULT_SETTINGS.provider,
      DEFAULT_SETTINGS.comfyuiBaseUrl,
      DEFAULT_SETTINGS.falModel,
      DEFAULT_SETTINGS.replicateModel,
      "{}",
      DEFAULT_SETTINGS.comfyuiWorkflow
    );
  }
  seedSample(db);
  return db;
}

function hasColumn(db: DB, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((row) => row.name === column);
}

function migrate(db: DB) {
  if (!hasColumn(db, "shots", "selected_job_id")) {
    db.exec("ALTER TABLE shots ADD COLUMN selected_job_id TEXT");
  }
  if (!hasColumn(db, "jobs", "kind")) {
    db.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'take'");
  }
  if (!hasColumn(db, "settings", "rates_json")) {
    db.exec("ALTER TABLE settings ADD COLUMN rates_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!hasColumn(db, "settings", "budget_cap")) {
    db.exec("ALTER TABLE settings ADD COLUMN budget_cap REAL");
  }
  if (!hasColumn(db, "settings", "comfyui_workflow")) {
    db.exec("ALTER TABLE settings ADD COLUMN comfyui_workflow TEXT NOT NULL DEFAULT 'svd'");
  }
  if (!hasColumn(db, "credit_ledger", "paypal_order_id")) {
    db.exec("ALTER TABLE credit_ledger ADD COLUMN paypal_order_id TEXT");
  }
  if (!hasColumn(db, "settings", "comfy_low_memory")) {
    db.exec("ALTER TABLE settings ADD COLUMN comfy_low_memory INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn(db, "projects", "comfyui_workflow")) {
    db.exec("ALTER TABLE projects ADD COLUMN comfyui_workflow TEXT");
  }
  if (!hasColumn(db, "projects", "comfy_low_memory")) {
    db.exec("ALTER TABLE projects ADD COLUMN comfy_low_memory INTEGER");
  }
  if (!hasColumn(db, "shots", "comfyui_workflow")) {
    db.exec("ALTER TABLE shots ADD COLUMN comfyui_workflow TEXT");
  }
  if (!hasColumn(db, "shots", "comfy_low_memory")) {
    db.exec("ALTER TABLE shots ADD COLUMN comfy_low_memory INTEGER");
  }
  if (!hasColumn(db, "projects", "seam_mode")) {
    db.exec("ALTER TABLE projects ADD COLUMN seam_mode TEXT NOT NULL DEFAULT 'cut'");
  }
  if (!hasColumn(db, "projects", "seam_fade_sec")) {
    db.exec("ALTER TABLE projects ADD COLUMN seam_fade_sec REAL NOT NULL DEFAULT 0.5");
  }
  if (!hasColumn(db, "shots", "chain_from_previous")) {
    db.exec("ALTER TABLE shots ADD COLUMN chain_from_previous INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn(db, "shots", "chained_start_image_path")) {
    db.exec("ALTER TABLE shots ADD COLUMN chained_start_image_path TEXT");
  }
  if (!hasColumn(db, "shots", "chained_from_job_id")) {
    db.exec("ALTER TABLE shots ADD COLUMN chained_from_job_id TEXT");
  }
  if (!hasColumn(db, "shots", "seam_mode")) {
    db.exec("ALTER TABLE shots ADD COLUMN seam_mode TEXT");
  }
  if (!hasColumn(db, "shots", "seam_fade_sec")) {
    db.exec("ALTER TABLE shots ADD COLUMN seam_fade_sec REAL");
  }
  if (!hasColumn(db, "jobs", "await_previous_frame")) {
    db.exec("ALTER TABLE jobs ADD COLUMN await_previous_frame INTEGER NOT NULL DEFAULT 0");
  }
}

function seedSample(db: DB) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
  if (count.n > 0) return;
  const fixturePath = path.join(process.cwd(), "samples", "project.json");
  const imageName = "harbor-dusk.png";
  const imageSrc = path.join(process.cwd(), "samples", imageName);
  if (!fs.existsSync(fixturePath) || !fs.existsSync(imageSrc)) return;

  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
    id: string;
    name: string;
    description: string;
    shots: {
      id: string;
      prompt: string;
      presetId: string;
      durationSec: number;
    }[];
  };
  const destDir = path.join(uploadsDir(), fixture.id);
  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(path.join(outputsDir(), fixture.id), { recursive: true });
  const destImage = path.join(destDir, imageName);
  fs.copyFileSync(imageSrc, destImage);
  const relImage = posix("uploads", fixture.id, imageName);
  const now = new Date().toISOString();

  const insertProject = db.prepare(
    `INSERT INTO projects (id, name, description, character_sheet_path, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?)`
  );
  const insertShot = db.prepare(
    `INSERT INTO shots (
      id, project_id, position, prompt, preset_id, duration_sec,
      start_image_path, end_image_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  );
  const tx = db.transaction(() => {
    insertProject.run(fixture.id, fixture.name, fixture.description, now, now);
    fixture.shots.forEach((shot, index) => {
      insertShot.run(
        shot.id,
        fixture.id,
        index + 1,
        shot.prompt,
        shot.presetId,
        shot.durationSec,
        relImage,
        now,
        now
      );
    });
  });
  tx();
}

export function getDb(): DB {
  if (!globalForDb.starDustDb) globalForDb.starDustDb = openDatabase();
  return globalForDb.starDustDb;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mapProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
    characterSheetPath: str(row.character_sheet_path),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    shotCount: row.shot_count == null ? undefined : Number(row.shot_count),
    completedCount:
      row.completed_count == null ? undefined : Number(row.completed_count),
    isSample: String(row.id) === SAMPLE_PROJECT_ID,
    coverPath: str(row.cover_path),
    comfyuiWorkflow: parseOptionalWorkflow(row.comfyui_workflow),
    comfyLowMemory: parseOptionalFlag(row.comfy_low_memory),
    seamMode: parseSeamMode(row.seam_mode) ?? "cut",
    seamFadeSec:
      row.seam_fade_sec == null ? DEFAULT_SEAM_FADE_SEC : clampSeamFade(Number(row.seam_fade_sec)),
  };
}

function mapShot(row: Record<string, unknown>): Shot {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    position: Number(row.position),
    prompt: String(row.prompt),
    presetId: String(row.preset_id),
    durationSec: Number(row.duration_sec),
    startImagePath: str(row.start_image_path),
    endImagePath: str(row.end_image_path),
    selectedJobId: str(row.selected_job_id),
    comfyuiWorkflow: parseOptionalWorkflow(row.comfyui_workflow),
    comfyLowMemory: parseOptionalFlag(row.comfy_low_memory),
    chainFromPrevious: Number(row.chain_from_previous) === 1,
    chainedStartImagePath: str(row.chained_start_image_path),
    chainedFromJobId: str(row.chained_from_job_id),
    seamMode: parseSeamMode(row.seam_mode),
    seamFadeSec: row.seam_fade_sec == null ? null : clampSeamFade(Number(row.seam_fade_sec)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapJob(row: Record<string, unknown>): Job {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    shotId: str(row.shot_id),
    prompt: String(row.prompt),
    presetId: String(row.preset_id),
    provider: String(row.provider) as ProviderId,
    kind: row.kind === "preview" ? "preview" : "take",
    status: String(row.status) as JobStatus,
    imagePath: String(row.image_path),
    endImagePath: str(row.end_image_path),
    characterSheetPath: str(row.character_sheet_path),
    characterNote: str(row.character_note),
    providerNote: str(row.provider_note),
    outputPath: str(row.output_path),
    error: str(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    progress: Number(row.progress ?? 0),
    modelName: str(row.model_name),
    durationSec: row.duration_sec == null ? undefined : Number(row.duration_sec),
    remoteId: str(row.remote_id),
    awaitPreviousFrame: Number(row.await_previous_frame) === 1,
  };
}

export function getDataPaths() {
  ensureDataDirs();
  return {
    DATA_ROOT: dataRoot(),
    UPLOADS_DIR: uploadsDir(),
    OUTPUTS_DIR: outputsDir(),
  };
}

export function listProjects(): Project[] {
  const rows = getDb()
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM shots s WHERE s.project_id = p.id) AS shot_count,
        (SELECT COUNT(*) FROM jobs j WHERE j.project_id = p.id AND j.status = 'completed' AND COALESCE(j.kind, 'take') != 'preview') AS completed_count,
        (SELECT start_image_path FROM shots s WHERE s.project_id = p.id ORDER BY position ASC LIMIT 1) AS cover_path
       FROM projects p
       ORDER BY updated_at DESC`
    )
    .all() as Record<string, unknown>[];
  return rows.map(mapProject);
}

export function getProject(id: string): Project | undefined {
  const row = getDb()
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM shots s WHERE s.project_id = p.id) AS shot_count,
        (SELECT COUNT(*) FROM jobs j WHERE j.project_id = p.id AND j.status = 'completed' AND COALESCE(j.kind, 'take') != 'preview') AS completed_count,
        (SELECT start_image_path FROM shots s WHERE s.project_id = p.id ORDER BY position ASC LIMIT 1) AS cover_path
       FROM projects p WHERE p.id = ?`
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapProject(row) : undefined;
}

export function createProject(name: string, description = ""): Project {
  const now = new Date().toISOString();
  const project: Project = {
    id: uuidv4(),
    name: name.trim() || "Untitled project",
    description: description.trim(),
    createdAt: now,
    updatedAt: now,
    shotCount: 0,
    completedCount: 0,
    seamMode: "cut",
    seamFadeSec: DEFAULT_SEAM_FADE_SEC,
  };
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, description, character_sheet_path, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)`
    )
    .run(project.id, project.name, project.description, now, now);
  fs.mkdirSync(path.join(uploadsDir(), project.id), { recursive: true });
  fs.mkdirSync(path.join(outputsDir(), project.id), { recursive: true });
  return project;
}

export function updateProject(
  id: string,
  patch: Partial<
    Pick<Project, "name" | "description" | "comfyuiWorkflow" | "comfyLowMemory" | "seamMode" | "seamFadeSec">
  > & {
    characterSheetPath?: string | null;
  }
): Project | undefined {
  const current = getProject(id);
  if (!current) return undefined;
  const next = {
    name: patch.name !== undefined ? patch.name.trim() || current.name : current.name,
    description:
      patch.description !== undefined ? patch.description.trim() : current.description,
    characterSheetPath:
      patch.characterSheetPath === undefined
        ? current.characterSheetPath ?? null
        : patch.characterSheetPath || null,
    comfyuiWorkflow:
      patch.comfyuiWorkflow === undefined ? current.comfyuiWorkflow ?? null : patch.comfyuiWorkflow,
    comfyLowMemory:
      patch.comfyLowMemory === undefined ? current.comfyLowMemory ?? null : patch.comfyLowMemory,
    seamMode: patch.seamMode === undefined ? current.seamMode : patch.seamMode,
    seamFadeSec:
      patch.seamFadeSec === undefined ? current.seamFadeSec : clampSeamFade(patch.seamFadeSec),
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .prepare(
      `UPDATE projects
       SET name = ?, description = ?, character_sheet_path = ?, updated_at = ?,
           comfyui_workflow = ?, comfy_low_memory = ?, seam_mode = ?, seam_fade_sec = ?
       WHERE id = ?`
    )
    .run(
      next.name,
      next.description,
      next.characterSheetPath,
      next.updatedAt,
      next.comfyuiWorkflow,
      next.comfyLowMemory == null ? null : next.comfyLowMemory ? 1 : 0,
      next.seamMode,
      next.seamFadeSec,
      id
    );
  return getProject(id);
}

export function deleteProject(id: string): boolean {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM jobs WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM shots WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  });
  tx();
  for (const dir of [
    path.join(uploadsDir(), id),
    path.join(outputsDir(), id),
  ]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return true;
}

export function touchProject(id: string) {
  getDb()
    .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
}

export function listShots(projectId: string): Shot[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM shots WHERE project_id = ? ORDER BY position ASC, created_at ASC"
    )
    .all(projectId) as Record<string, unknown>[];
  return rows.map(mapShot);
}

export function getShot(id: string): Shot | undefined {
  const row = getDb().prepare("SELECT * FROM shots WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapShot(row) : undefined;
}

export function createShot(input: {
  projectId: string;
  prompt: string;
  presetId: string;
  durationSec: number;
  startImagePath?: string;
  endImagePath?: string;
  comfyuiWorkflow?: ComfyWorkflowId | null;
  comfyLowMemory?: boolean | null;
  chainFromPrevious?: boolean;
  id?: string;
}): Shot {
  const now = new Date().toISOString();
  const max = getDb()
    .prepare("SELECT COALESCE(MAX(position), 0) AS max FROM shots WHERE project_id = ?")
    .get(input.projectId) as { max: number };
  const shot: Shot = {
    id: input.id ?? uuidv4(),
    projectId: input.projectId,
    position: Number(max.max) + 1,
    prompt: input.prompt.trim(),
    presetId: presetById(input.presetId).id,
    durationSec: input.durationSec,
    startImagePath: input.startImagePath,
    endImagePath: input.endImagePath,
    comfyuiWorkflow: input.comfyuiWorkflow ?? null,
    comfyLowMemory: input.comfyLowMemory ?? null,
    chainFromPrevious: Boolean(input.chainFromPrevious),
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      `INSERT INTO shots (
        id, project_id, position, prompt, preset_id, duration_sec,
        start_image_path, end_image_path, created_at, updated_at,
        comfyui_workflow, comfy_low_memory, chain_from_previous
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      shot.id,
      shot.projectId,
      shot.position,
      shot.prompt,
      shot.presetId,
      shot.durationSec,
      shot.startImagePath ?? null,
      shot.endImagePath ?? null,
      shot.createdAt,
      shot.updatedAt,
      shot.comfyuiWorkflow,
      shot.comfyLowMemory == null ? null : shot.comfyLowMemory ? 1 : 0,
      shot.chainFromPrevious ? 1 : 0
    );
  touchProject(shot.projectId);
  return shot;
}

export function updateShot(
  id: string,
  patch: Partial<
    Pick<
      Shot,
      | "prompt"
      | "presetId"
      | "durationSec"
      | "startImagePath"
      | "endImagePath"
      | "comfyuiWorkflow"
      | "comfyLowMemory"
      | "chainFromPrevious"
      | "chainedStartImagePath"
      | "chainedFromJobId"
      | "seamMode"
      | "seamFadeSec"
    >
  >
): Shot | undefined {
  const current = getShot(id);
  if (!current) return undefined;
  const next = {
    prompt: patch.prompt !== undefined ? patch.prompt.trim() : current.prompt,
    presetId: patch.presetId ? presetById(patch.presetId).id : current.presetId,
    durationSec: patch.durationSec ?? current.durationSec,
    startImagePath:
      patch.startImagePath !== undefined
        ? patch.startImagePath
        : current.startImagePath ?? null,
    endImagePath:
      patch.endImagePath !== undefined ? patch.endImagePath : current.endImagePath ?? null,
    comfyuiWorkflow:
      patch.comfyuiWorkflow === undefined ? current.comfyuiWorkflow ?? null : patch.comfyuiWorkflow,
    comfyLowMemory:
      patch.comfyLowMemory === undefined ? current.comfyLowMemory ?? null : patch.comfyLowMemory,
    chainFromPrevious:
      patch.chainFromPrevious === undefined ? current.chainFromPrevious : patch.chainFromPrevious,
    chainedStartImagePath:
      patch.chainedStartImagePath !== undefined
        ? patch.chainedStartImagePath || null
        : current.chainedStartImagePath ?? null,
    chainedFromJobId:
      patch.chainedFromJobId !== undefined
        ? patch.chainedFromJobId || null
        : current.chainedFromJobId ?? null,
    seamMode: patch.seamMode === undefined ? current.seamMode ?? null : patch.seamMode,
    seamFadeSec:
      patch.seamFadeSec === undefined
        ? current.seamFadeSec ?? null
        : patch.seamFadeSec == null
          ? null
          : clampSeamFade(patch.seamFadeSec),
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .prepare(
      `UPDATE shots
       SET prompt = ?, preset_id = ?, duration_sec = ?, start_image_path = ?,
           end_image_path = ?, comfyui_workflow = ?, comfy_low_memory = ?,
           chain_from_previous = ?, chained_start_image_path = ?, chained_from_job_id = ?,
           seam_mode = ?, seam_fade_sec = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      next.prompt,
      next.presetId,
      next.durationSec,
      next.startImagePath,
      next.endImagePath,
      next.comfyuiWorkflow,
      next.comfyLowMemory == null ? null : next.comfyLowMemory ? 1 : 0,
      next.chainFromPrevious ? 1 : 0,
      next.chainedStartImagePath,
      next.chainedFromJobId,
      next.seamMode,
      next.seamFadeSec,
      next.updatedAt,
      id
    );
  touchProject(current.projectId);
  return getShot(id);
}

export function deleteShot(id: string): boolean {
  const shot = getShot(id);
  if (!shot) return false;
  getDb().prepare("DELETE FROM shots WHERE id = ?").run(id);
  touchProject(shot.projectId);
  return true;
}

export function moveShot(id: string, direction: "up" | "down"): Shot | undefined {
  const shot = getShot(id);
  if (!shot) return undefined;
  const shots = listShots(shot.projectId);
  const index = shots.findIndex((item) => item.id === id);
  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= shots.length) return shot;
  const other = shots[swapIndex];
  const now = new Date().toISOString();
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("UPDATE shots SET position = ?, updated_at = ? WHERE id = ?").run(
      other.position,
      now,
      shot.id
    );
    db.prepare("UPDATE shots SET position = ?, updated_at = ? WHERE id = ?").run(
      shot.position,
      now,
      other.id
    );
  });
  tx();
  touchProject(shot.projectId);
  return getShot(id);
}

export function listJobs(projectId?: string): Job[] {
  const rows = (
    projectId
      ? getDb()
          .prepare(
            "SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC"
          )
          .all(projectId)
      : getDb().prepare("SELECT * FROM jobs ORDER BY created_at DESC").all()
  ) as Record<string, unknown>[];
  return rows.map(mapJob);
}

export function getJob(id: string): Job | undefined {
  const row = getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapJob(row) : undefined;
}

export function createJob(input: {
  projectId: string;
  shotId?: string;
  prompt: string;
  presetId: string;
  provider: ProviderId;
  kind?: JobKind;
  status?: JobStatus;
  imagePath: string;
  endImagePath?: string;
  characterSheetPath?: string;
  characterNote?: string;
  providerNote?: string;
  error?: string;
  modelName?: string;
  durationSec?: number;
  progress?: number;
  awaitPreviousFrame?: boolean;
  createdAt?: string;
}): Job {
  const now = input.createdAt ?? new Date().toISOString();
  const job: Job = {
    id: uuidv4(),
    projectId: input.projectId,
    shotId: input.shotId,
    prompt: input.prompt,
    presetId: input.presetId,
    provider: input.provider,
    kind: input.kind ?? "take",
    status: input.status ?? "queued",
    imagePath: input.imagePath,
    endImagePath: input.endImagePath,
    characterSheetPath: input.characterSheetPath,
    characterNote: input.characterNote,
    providerNote: input.providerNote,
    error: input.error,
    modelName: input.modelName,
    durationSec: input.durationSec,
    progress: input.progress ?? 0,
    awaitPreviousFrame: Boolean(input.awaitPreviousFrame),
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      `INSERT INTO jobs (
        id, project_id, shot_id, prompt, preset_id, provider, kind, status, image_path,
        end_image_path, character_sheet_path, character_note, provider_note,
        output_path, error, progress, model_name, duration_sec, remote_id,
        await_previous_frame, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?)`
    )
    .run(
      job.id,
      job.projectId,
      job.shotId ?? null,
      job.prompt,
      job.presetId,
      job.provider,
      job.kind,
      job.status,
      job.imagePath,
      job.endImagePath ?? null,
      job.characterSheetPath ?? null,
      job.characterNote ?? null,
      job.providerNote ?? null,
      job.error ?? null,
      job.progress ?? 0,
      job.modelName ?? null,
      job.durationSec ?? null,
      job.awaitPreviousFrame ? 1 : 0,
      job.createdAt,
      job.updatedAt
    );
  touchProject(job.projectId);
  return job;
}

export function updateJob(id: string, patch: Partial<Job>): Job | undefined {
  const current = getJob(id);
  if (!current) return undefined;
  const next: Job = {
    ...current,
    ...patch,
    id: current.id,
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .prepare(
      `UPDATE jobs SET
        status = ?, prompt = ?, preset_id = ?, provider = ?, image_path = ?,
        end_image_path = ?, character_sheet_path = ?, character_note = ?,
        provider_note = ?, output_path = ?, error = ?, progress = ?,
        model_name = ?, duration_sec = ?, remote_id = ?, shot_id = ?,
        await_previous_frame = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      next.status,
      next.prompt,
      next.presetId,
      next.provider,
      next.imagePath,
      next.endImagePath ?? null,
      next.characterSheetPath ?? null,
      next.characterNote ?? null,
      next.providerNote ?? null,
      next.outputPath ?? null,
      next.error ?? null,
      next.progress ?? 0,
      next.modelName ?? null,
      next.durationSec ?? null,
      next.remoteId ?? null,
      next.shotId ?? null,
      next.awaitPreviousFrame ? 1 : 0,
      next.updatedAt,
      id
    );
  return getJob(id);
}

function cleanRateMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const model = key.trim();
    const rate = typeof raw === "number" ? raw : Number(raw);
    if (!model || !Number.isFinite(rate) || rate < 0) continue;
    out[model] = rate;
  }
  return out;
}

function parseRates(raw: unknown): RateTable {
  if (typeof raw !== "string" || !raw.trim()) return { fal: {}, replicate: {} };
  try {
    const parsed = JSON.parse(raw) as { fal?: unknown; replicate?: unknown };
    return { fal: cleanRateMap(parsed.fal), replicate: cleanRateMap(parsed.replicate) };
  } catch {
    return { fal: {}, replicate: {} };
  }
}

function parseWorkflow(value: unknown): ComfyWorkflowId {
  if (value === "wan" || value === "ltx" || value === "svd") return value;
  return "svd";
}

function parseOptionalWorkflow(value: unknown): ComfyWorkflowId | null {
  if (value === "wan" || value === "ltx" || value === "svd") return value;
  return null;
}

function parseSeamMode(value: unknown): SeamMode | null {
  if (value === "cut" || value === "crossfade") return value;
  return null;
}

function parseOptionalFlag(value: unknown): boolean | null {
  if (value == null) return null;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return null;
}

export function getSettings(): AppSettings {
  const row = getDb().prepare("SELECT * FROM settings WHERE id = 1").get() as
    | {
        provider: ProviderId;
        comfyui_base_url: string;
        fal_model: string;
        replicate_model: string;
        rates_json?: string;
        budget_cap?: number | null;
        comfyui_workflow?: string;
        comfy_low_memory?: number | null;
      }
    | undefined;
  if (!row) return { ...DEFAULT_SETTINGS, rates: { ...EMPTY_RATES, fal: {}, replicate: {} } };
  const cap = row.budget_cap;
  return {
    provider: row.provider,
    comfyuiBaseUrl: row.comfyui_base_url,
    falModel: row.fal_model,
    replicateModel: row.replicate_model,
    comfyuiWorkflow: parseWorkflow(row.comfyui_workflow),
    comfyLowMemory: Number(row.comfy_low_memory) === 1,
    rates: parseRates(row.rates_json),
    budgetCap: cap == null || !Number.isFinite(Number(cap)) ? null : Number(cap),
  };
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  const next: AppSettings = {
    provider: patch.provider ?? current.provider,
    comfyuiBaseUrl: patch.comfyuiBaseUrl ?? current.comfyuiBaseUrl,
    falModel: patch.falModel ?? current.falModel,
    replicateModel: patch.replicateModel ?? current.replicateModel,
    comfyuiWorkflow: patch.comfyuiWorkflow ?? current.comfyuiWorkflow,
    comfyLowMemory: patch.comfyLowMemory ?? current.comfyLowMemory,
    rates: patch.rates ?? current.rates,
    budgetCap: patch.budgetCap === undefined ? current.budgetCap : patch.budgetCap,
  };
  getDb()
    .prepare(
      `UPDATE settings
       SET provider = ?, comfyui_base_url = ?, fal_model = ?, replicate_model = ?,
           rates_json = ?, budget_cap = ?, comfyui_workflow = ?, comfy_low_memory = ?
       WHERE id = 1`
    )
    .run(
      next.provider,
      next.comfyuiBaseUrl,
      next.falModel,
      next.replicateModel,
      JSON.stringify(next.rates),
      next.budgetCap,
      next.comfyuiWorkflow,
      next.comfyLowMemory ? 1 : 0
    );
  return next;
}

export function selectTake(shotId: string, jobId: string): Shot | undefined {
  const shot = getShot(shotId);
  const job = getJob(jobId);
  if (!shot || !job) return undefined;
  if (job.shotId !== shot.id || job.projectId !== shot.projectId) return undefined;
  if (job.kind === "preview") return undefined;
  if (job.status !== "completed" || !job.outputPath) return undefined;
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE shots SET selected_job_id = ?, updated_at = ? WHERE id = ?")
    .run(jobId, now, shotId);
  touchProject(shot.projectId);
  return getShot(shotId);
}

export function saveUpload(projectId: string, filename: string, buffer: Buffer): string {
  ensureDataDirs();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_") || "image.png";
  const name = `${Date.now()}_${safe}`;
  const dir = path.join(uploadsDir(), projectId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buffer);
  return posix("uploads", projectId, name);
}

export function resolveDataPath(relativePath: string): string {
  const clean = relativePath.replace(/^[/\\]+/, "").replace(/\\/g, "/");
  if (clean.includes("..")) throw new Error("Invalid path");
  if (!clean.startsWith("uploads/") && !clean.startsWith("outputs/")) {
    throw new Error("Invalid path");
  }
  const full = path.resolve(dataRoot(), clean);
  const root = path.resolve(dataRoot());
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new Error("Invalid path");
  }
  return full;
}

export function absoluteOutputPath(projectId: string, filename: string): {
  abs: string;
  rel: string;
} {
  ensureDataDirs();
  const dir = path.join(outputsDir(), projectId);
  fs.mkdirSync(dir, { recursive: true });
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return {
    abs: path.join(dir, safe),
    rel: posix("outputs", projectId, safe),
  };
}

export function completedJobsForGallery(projectId: string): Job[] {
  return listJobs(projectId).filter(
    (job) => job.kind !== "preview" && job.status === "completed" && job.outputPath
  );
}
