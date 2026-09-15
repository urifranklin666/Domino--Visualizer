import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types';
import { sanitizeRule, type ObsRule } from '@shared/stream';

let cache: AppSettings | null = null;
let writeChain: Promise<void> = Promise.resolve();

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** Keep only known keys, and only when the value has the expected type. */
function sanitize(raw: unknown): AppSettings {
  const out: AppSettings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    const value = obj[key];
    if (value === undefined) continue;
    const expected = typeof DEFAULT_SETTINGS[key];
    if (key === 'lastVisual') {
      if (value === null) {
        out.lastVisual = null;
      } else if (value && typeof value === 'object') {
        const v = value as Record<string, unknown>;
        const kind = v.kind;
        if (
          typeof v.id === 'string' &&
          (kind === 'shader' || kind === 'milk' || kind === 'preset')
        ) {
          out.lastVisual = { kind, id: v.id };
        }
      }
      continue;
    }
    if (key === 'obsRules') {
      if (Array.isArray(value)) {
        out.obsRules = value.map(sanitizeRule).filter((r): r is ObsRule => r !== null);
      }
      continue;
    }
    if (typeof value === expected) {
      (out as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

export async function getSettings(): Promise<AppSettings> {
  if (cache) return cache;
  try {
    const text = await fs.readFile(settingsPath(), 'utf8');
    cache = sanitize(JSON.parse(text));
  } catch {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  cache = sanitize({ ...current, ...patch });
  const snapshot = cache;
  // Serialize writes so rapid slider drags can't interleave and corrupt the file.
  writeChain = writeChain.then(async () => {
    try {
      await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
      await fs.writeFile(settingsPath(), JSON.stringify(snapshot, null, 2), 'utf8');
    } catch {
      /* Settings are a convenience; never let a failed write break the app. */
    }
  });
  return cache;
}

export function flushSettings(): Promise<void> {
  return writeChain;
}
