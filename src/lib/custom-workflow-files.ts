/**
 * Loads custom graphs from data/workflows/<slug>.api.json and <slug>.map.json.
 * The slug is checked before it is joined onto the directory, so it cannot
 * leave that folder. A missing or broken pair is an error list, never a
 * shipped graph.
 */

import fs from "fs";
import path from "path";
import {
  CustomGraph,
  CustomGraphCard,
  CustomGraphNote,
  customGraphCard,
  failedCustomCard,
  noteFromFailure,
  noteFromGraph,
  preflightBox,
  validateCustomGraph,
} from "./custom-workflow";
import { customGraphSlug, isCustomGraphId } from "./types";

const MAX_BYTES = 8 * 1024 * 1024;

export function customWorkflowDir(): string {
  const root = process.env.STAR_DUST_DATA
    ? path.resolve(process.env.STAR_DUST_DATA)
    : path.join(process.cwd(), "data");
  return path.join(root, "workflows");
}

export function customApiPath(slug: string): string {
  return path.join(customWorkflowDir(), `${slug}.api.json`);
}

export function customMapPath(slug: string): string {
  return path.join(customWorkflowDir(), `${slug}.map.json`);
}

export function listCustomGraphSlugs(): string[] {
  const dir = customWorkflowDir();
  if (!fs.existsSync(dir)) return [];
  const slugs = new Set<string>();
  for (const name of fs.readdirSync(dir)) {
    const api = /^([a-z][a-z0-9-]{0,47})\.api\.json$/.exec(name);
    const map = /^([a-z][a-z0-9-]{0,47})\.map\.json$/.exec(name);
    const slug = api?.[1] ?? map?.[1];
    if (slug && customGraphSlug(`custom:${slug}`)) slugs.add(slug);
  }
  return Array.from(slugs).sort();
}

export function loadCustomGraph(slug: string): { ok: true; graph: CustomGraph } | { ok: false; errors: string[] } {
  const id = `custom:${slug}` as `custom:${string}`;
  if (customGraphSlug(id) !== slug) {
    return { ok: false, errors: [`${id} is not a usable custom graph id.`] };
  }
  const errors: string[] = [];
  const apiLabel = `data/workflows/${slug}.api.json`;
  const mapLabel = `data/workflows/${slug}.map.json`;
  const apiPath = customApiPath(slug);
  const mapPath = customMapPath(slug);
  const apiRaw = readGraphFile(apiPath, apiLabel, errors);
  const mapRaw = readGraphFile(mapPath, mapLabel, errors);
  if (apiRaw === undefined || mapRaw === undefined || errors.length > 0) {
    return { ok: false, errors: errors.length > 0 ? errors : [`Missing ${apiLabel}.`] };
  }
  const checked = validateCustomGraph(apiRaw, mapRaw);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  return {
    ok: true,
    graph: {
      id,
      slug,
      apiFile: apiLabel,
      mapFile: mapLabel,
      nodes: checked.nodes,
      map: checked.map,
    },
  };
}

export function loadCustomGraphById(
  id: string
): { ok: true; graph: CustomGraph } | { ok: false; errors: string[] } {
  const slug = isCustomGraphId(id) ? customGraphSlug(id) : null;
  if (!slug) {
    return {
      ok: false,
      errors: [`${id} is not a usable custom graph id. Use custom:<slug>, such as custom:wan22-ti2v-5b.`],
    };
  }
  return loadCustomGraph(slug);
}

export function listCustomGraphCards(): CustomGraphCard[] {
  return listCustomGraphSlugs().map((slug) => {
    const id = `custom:${slug}` as const;
    const loaded = loadCustomGraph(slug);
    if (!loaded.ok) return failedCustomCard(id, slug, loaded.errors);
    return customGraphCard(loaded.graph);
  });
}

export function describeCustomGraph(id: string): CustomGraphNote {
  const slug = isCustomGraphId(id) ? customGraphSlug(id) : null;
  if (!slug) return noteFromFailure(`custom:invalid`, [`${id} is not a usable custom graph id.`]);
  const loaded = loadCustomGraph(slug);
  if (!loaded.ok) return noteFromFailure(loadedId(slug), loaded.errors);
  return noteFromGraph(loaded.graph);
}

export function customGraphPreflightBox(
  id: string,
  lowMemory: boolean
): { width: number; height: number; writes: string; name: string } | null {
  const slug = isCustomGraphId(id) ? customGraphSlug(id) : null;
  if (!slug) return null;
  const loaded = loadCustomGraph(slug);
  if (!loaded.ok) return null;
  return preflightBox(loaded.graph.map, lowMemory);
}

function loadedId(slug: string): `custom:${string}` {
  return `custom:${slug}`;
}

function readGraphFile(file: string, label: string, errors: string[]): unknown | undefined {
  if (!insideWorkflowDir(file)) {
    errors.push(`${label} is outside data/workflows.`);
    return undefined;
  }
  if (!fs.existsSync(file)) {
    errors.push(`Missing ${label}.`);
    return undefined;
  }
  let text: string;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) {
      errors.push(`${label} is not a file.`);
      return undefined;
    }
    if (stat.size > MAX_BYTES) {
      errors.push(`${label} is larger than 8 MB.`);
      return undefined;
    }
    text = fs.readFileSync(file, "utf8");
  } catch {
    errors.push(`${label} could not be read.`);
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    errors.push(`${label} is not JSON.`);
    return undefined;
  }
}

function insideWorkflowDir(file: string): boolean {
  const root = path.resolve(customWorkflowDir());
  const target = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
  return target === root || target.startsWith(root + path.sep);
}
