// Zones de destination et règle de choix du service UPS

const EU27 = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);
// Europe hors UE : on prend aussi le moins cher, mais la douane s'applique
const EUROPE_OTHER = new Set(['GB', 'CH', 'NO', 'IS', 'LI', 'MC', 'AD', 'SM', 'VA', 'GI']);

export const SERVICE_NAMES = {
  '01': 'Next Day Air', '02': '2nd Day Air', '03': 'Ground', '07': 'Express',
  '08': 'Expedited', '11': 'Standard', '12': '3 Day Select', '13': 'Next Day Air Saver',
  '14': 'Next Day Air Early', '17': 'Worldwide Economy DDU', '54': 'Express Plus',
  '59': '2nd Day Air A.M.', '65': 'Express Saver', '70': 'Access Point Economy',
  '71': 'Worldwide Express Freight Midday', '72': 'Worldwide Economy DDP',
  '74': 'Express 12:00', '96': 'Worldwide Express Freight',
};
export const serviceName = (code) => SERVICE_NAMES[code] || `Service ${code}`;

/** 'FR' | 'EU' | 'INTL' */
export function zoneOf(country) {
  const c = String(country || '').toUpperCase();
  if (c === 'FR' || c === 'MC') return 'FR';
  if (EU27.has(c) || EUROPE_OTHER.has(c)) return 'EU';
  return 'INTL';
}

/** Facture commerciale nécessaire ? (hors territoire douanier UE) */
export function needsCustoms(country, postalCode = '') {
  const c = String(country || '').toUpperCase();
  if (c === 'MC') return false;
  if (c === 'ES' && /^(35|38)/.test(String(postalCode))) return true; // Canaries
  return !EU27.has(c);
}

/**
 * France / Europe -> service le moins cher
 * Reste du monde  -> Express Saver (65), sinon le moins cher avec alerte
 */
export function pickService(rates, country) {
  const usable = rates.filter((r) => Number.isFinite(r.total));
  if (!usable.length) return null;
  const cheapest = [...usable].sort((a, b) => a.total - b.total)[0];
  if (zoneOf(country) !== 'INTL') {
    return { code: cheapest.code, rule: 'Le moins cher', warning: null };
  }
  const saver = usable.find((r) => r.code === '65');
  if (saver) return { code: '65', rule: 'Express Saver', warning: null };
  return {
    code: cheapest.code,
    rule: 'Le moins cher',
    warning: 'Express Saver non proposé pour cette destination',
  };
}

const US_STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'puerto rico': 'PR',
};

/** Convertit "California" -> "CA" pour les USA ; sinon renvoie tel quel */
export function normalizeState(state, country) {
  const s = String(state || '').trim();
  if (!s) return '';
  if (String(country).toUpperCase() === 'US' && s.length > 2) {
    return US_STATES[s.toLowerCase()] || s;
  }
  return s;
}
