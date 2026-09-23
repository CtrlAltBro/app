import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

const dataFile = (name: string) => path.join(app.getPath('userData'), name);

export async function readJson<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(dataFile(name), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeJson(name: string, value: unknown) {
  const file = dataFile(name);
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function removeJson(name: string) {
  await fs.rm(dataFile(name), { force: true });
}
