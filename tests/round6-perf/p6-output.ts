// P6 artifacts stay under this private C: scratch root. Set P6_RUN_ID to give
// each new execution a unique directory; unset it only for legacy reruns.
import fs from 'node:fs';
import path from 'node:path';

const BASE = path.resolve('C:/Users/user/portfolio-build/alder/.local/scratch-r6/runs');
const runId = process.env.P6_RUN_ID;

if (runId && !/^p6-[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{4,20}$/.test(runId)) {
  throw new Error('P6_RUN_ID must look like p6-YYYYMMDDTHHMMSSZ-suffix');
}

export function p6OutputPath(relativePath: string, legacyPath: string): string {
  if (!runId) return legacyPath;
  const root = path.resolve(BASE, runId);
  const rel = path.relative(BASE, root);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('P6_OUTPUT_ROOT_UNSAFE');
  const output = path.resolve(root, relativePath);
  const outputRel = path.relative(root, output);
  if (outputRel.startsWith('..') || path.isAbsolute(outputRel)) throw new Error('P6_OUTPUT_PATH_UNSAFE');
  fs.mkdirSync(root, { recursive: true });
  const marker = path.join(root, 'P6-RUN.json');
  if (!fs.existsSync(marker)) {
    try {
      fs.writeFileSync(marker, JSON.stringify({ runId, createdAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const record = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (record.runId !== runId) throw new Error('P6_RUN_ID_MARKER_MISMATCH');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  return output;
}
