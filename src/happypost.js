// Export Excel au format « import colis » de Happy Post (modèle fourni par Happy Post, assets/happypost-template.xlsx)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { config } from './config.js';
import { needsCustoms } from './zones.js';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'happypost-template.xlsx');
const FIRST_ROW = 3; // lignes 1-2 = en-têtes du modèle
const ORIGIN = 'FRANCE MÉTROPOLITAINE';

const strip = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[’']/g, "'").trim();

// Noms de la liste Happy Post qui diffèrent du nom français standard (ISO → libellé de la liste)
const OVERRIDES = {
  FR: ORIGIN, US: 'ETATS-UNIS', GB: 'ROYAUME-UNI', NL: 'PAYS-BAS', VN: 'VIET NAM', CZ: 'REP. TCHEQUE',
  CD: 'REP. DEMOC. DU CONGO', CF: 'REP. CENTRAFRICAINE', DO: 'REP. DOMINICAINE', KP: 'COREE DU NORD', KR: 'COREE DU SUD',
  HK: 'HONG-KONG', MO: 'MACAO', MK: 'MACEDOINE', RU: 'RUSSIE', SZ: 'SWAZILAND', MM: 'MYANMAR', CI: "COTE D\\&apos;IVOIRE",
  BN: 'BRUNEI DARUSSALAM', CV: 'CAP-VERT', LA: 'LAOS', PS: 'PALESTINE', PR: 'PORTO RICO', TL: 'TIMOR-LESTE', VA: 'VATICAN',
  AE: 'EMIRATS ARABES UNIS', SA: 'ARABIE SAOUDITE', ZA: 'AFRIQUE DU SUD', NZ: 'NOUVELLE-ZELANDE', SG: 'SINGAPOUR',
};

/** Code pays ISO → libellé exact de la liste Happy Post (null si introuvable) */
export function countryLabel(iso, list) {
  const c = String(iso || '').toUpperCase();
  if (OVERRIDES[c] && list.has(OVERRIDES[c])) return OVERRIDES[c];
  let name;
  try {
    name = new Intl.DisplayNames(['fr'], { type: 'region' }).of(c);
  } catch {
    return null;
  }
  const key = strip(name || '');
  for (const l of list) if (strip(l) === key) return l;
  return null;
}

/** « Prénom Nom » → [nom, prénom] (dernier mot = nom) */
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [parts[0] || '', ''];
  return [parts.slice(-1)[0], parts.slice(0, -1).join(' ')];
}

const us5 = (country, pc) => {
  const c = String(country || '').toUpperCase();
  const d = String(pc || '').replace(/\D/g, '');
  return (c === 'US' || c === 'PR') && d.length >= 5 ? d.slice(0, 5) : String(pc || '').trim();
};

export async function buildHappyPostXlsx(orders) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const ws = wb.getWorksheet('Liste colis');
  const data = wb.getWorksheet('data');
  const list = new Set();
  data.getColumn(2).eachCell((c) => {
    if (typeof c.value === 'string' && !c.value.startsWith('=')) list.add(c.value);
  });
  // la première cellule de la colonne contient parfois la formule matricielle : on reconstruit la liste sans elle
  const problems = [];
  const s = config.shipper;
  const [sn, sp] = splitName(s.name);

  orders.forEach((o, idx) => {
    const r = ws.getRow(FIRST_ROW + idx);
    const a = o.address;
    const p = o.parcel;
    const dest = countryLabel(a.country, list);
    if (!dest) problems.push(`${o.ref} : pays « ${a.country} » absent de la liste Happy Post`);
    const [n, pn] = splitName(a.name);
    const set = (col, v) => {
      r.getCell(col).value = v === '' || v == null ? null : v;
    };
    set('A', ORIGIN);
    set('B', dest || a.country);
    set('C', Number(p.weight));
    set('D', Number(p.length));
    set('E', Number(p.width));
    set('F', Number(p.height));
    set('G', String(o.ref).replace(/^#/, ''));
    set('H', 'Autre');
    // expéditeur
    set('I', sn); set('J', sp); set('K', s.company);
    set('L', s.line1); set('M', s.line2); set('N', s.postalCode); set('O', s.city);
    set('Q', s.email); set('R', s.phone);
    // destinataire
    set('S', n); set('T', pn); set('U', a.company);
    set('V', a.line1); set('W', a.line2); set('X', us5(a.country, a.postalCode)); set('Y', a.city); set('Z', a.state);
    set('AA', a.email); set('AB', a.phone);
    // douane (un article récapitulatif) : seulement hors UE
    if (needsCustoms(a.country, a.postalCode)) {
      set('AC', String(p.contents).slice(0, 100));
      const hs = String(p.hsCode || '').replace(/[^0-9A-Za-z]/g, '');
      if (hs) { r.getCell('AD').value = hs; r.getCell('AD').numFmt = '@'; }
      set('AE', ORIGIN);
      set('AF', 1);
      set('AG', Number(p.value));
      if (p.currency && p.currency !== 'EUR') set('AH', p.currency); // sinon la formule du modèle met EUR
    }
    r.commit?.();
  });
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), problems };
}
