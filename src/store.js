// Persistance très simple en fichiers JSON dans ./data
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// La démo a son propre dossier : ses fausses étiquettes ne se mélangent jamais à l'historique réel
export const DATA_DIR = path.join(config.dataDir, ...(config.mock ? ['demo'] : []));
export const LABELS_DIR = path.join(DATA_DIR, 'labels');
fs.mkdirSync(LABELS_DIR, { recursive: true });

export function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${name}.json`), 'utf8'));
  } catch {
    return fallback;
  }
}

export function save(name, obj) {
  const file = path.join(DATA_DIR, `${name}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

export function update(name, fallback, fn) {
  const obj = load(name, fallback);
  const res = fn(obj) ?? obj;
  save(name, res);
  return res;
}
