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

/** Miniatures : adresses d'images en cache, supprimées dès que la commande est traitée */
const THUMB_TTL = 7 * 24 * 3600_000;
const THUMB_MISS_TTL = 3600_000; // échec : on réessaie au bout d'1 h

/** Commande étiquetée dans l'application (étiquette non annulée) */
export function shippedInApp(orderKey, shipments = load('shipments', {})) {
  const s = shipments[orderKey];
  return Boolean(s && !s.voided);
}

export async function cachedThumb(key, fetcher, orderKey) {
  if (orderKey && shippedInApp(orderKey)) return ''; // déjà traitée : pas de miniature
  const c = load('thumbs', {})[key];
  if (c && Date.now() - c.t < (c.url ? THUMB_TTL * 4 : THUMB_MISS_TTL)) {
    if (orderKey && !(c.orders || []).includes(orderKey)) {
      update('thumbs', {}, (all) => {
        all[key] = { ...all[key], orders: [...new Set([...(all[key].orders || []), orderKey])] };
      });
    }
    return c.url;
  }
  let url = '';
  try {
    url = (await fetcher()) || '';
  } catch {
    url = '';
  }
  update('thumbs', {}, (all) => {
    all[key] = { url, t: Date.now(), orders: [...new Set([...(all[key]?.orders || []), ...(orderKey ? [orderKey] : [])])] };
  });
  return url;
}

/**
 * Supprime les miniatures des commandes traitées :
 * - étiquetées dans l'application ;
 * - ou absentes de la liste « à expédier » d'une plateforme lue avec succès (expédiées ailleurs, annulées…).
 * Supprime aussi les entrées orphelines de plus de 30 jours.
 * @param {Set<string>|null} pending  clés des commandes encore à expédier
 * @param {string[]} checked          plateformes dont la liste vient d'être lue sans erreur
 */
export function purgeThumbs(pending = null, checked = []) {
  const shipments = load('shipments', {});
  const handled = (key) =>
    shippedInApp(key, shipments) || (pending && checked.includes(key.split(':')[0]) && !pending.has(key));
  let removed = 0;
  update('thumbs', {}, (all) => {
    for (const [k, v] of Object.entries(all)) {
      const orders = v.orders || [];
      const done = orders.length > 0 && orders.every(handled);
      const orphan = orders.length === 0 && Date.now() - v.t > 30 * 24 * 3600_000;
      if (done || orphan) {
        delete all[k];
        removed++;
      }
    }
  });
  return removed;
}

/** Exécute fn sur chaque élément avec au plus `limit` appels simultanés */
export async function eachLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}
