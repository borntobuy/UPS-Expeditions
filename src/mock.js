// Mode démo : fausses commandes, faux tarifs, fausses étiquettes (aucun appel externe)
import { zoneOf } from './zones.js';
import { serviceName } from './zones.js';

const day = (n) => new Date(Date.now() - n * 86400_000).toISOString();

const demoImg = (label, color) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="170" height="135"><rect width="170" height="135" fill="${color}"/><text x="85" y="75" font-family="sans-serif" font-size="16" fill="#fff" text-anchor="middle">${label}</text></svg>`)}`;

export function mockOrders() {
  return [
    {
      key: 'ebay:12-34567-89012', platform: 'ebay', ref: '12-34567-89012', date: day(0), buyer: 'vintagelover_tx',
      address: { name: 'Sarah Miller', company: '', line1: '2201 Oak Lawn Ave', line2: 'Apt 4B', city: 'Dallas', state: 'TX', postalCode: '75219', country: 'US', phone: '2145550187', email: '' },
      items: [{ title: 'Pair of French brass candlesticks, 19th c.', sku: 'BR-0412', image: demoImg('Bougeoirs', '#9a7b3c'), qty: 1, price: 145 }],
      goodsValue: 145, currency: 'EUR',
    },
    {
      key: 'etsy:3301245577', platform: 'etsy', ref: '3301245577', date: day(1), buyer: 'Camille Durand',
      address: { name: 'Camille Durand', company: '', line1: '14 rue des Tanneurs', line2: '', city: 'Lyon', state: '', postalCode: '69005', country: 'FR', phone: '', email: 'camille@example.com' },
      items: [{ title: 'Ancienne boîte à couture en bois', sku: 'BX-221', image: demoImg('Boîte', '#7a5230'), qty: 1, price: 38 }],
      goodsValue: 38, currency: 'EUR',
    },
    {
      key: 'shopify:5801123', platform: 'shopify', ref: '#1087', date: day(1), buyer: 'Jonas Weber',
      address: { name: 'Jonas Weber', company: '', line1: 'Kastanienallee 12', line2: '', city: 'Berlin', state: '', postalCode: '10435', country: 'DE', phone: '+4915112345678', email: 'jonas@example.com' },
      items: [{ title: 'French art deco mirror', sku: 'MI-090', image: demoImg('Miroir', '#5d6d7e'), qty: 1, price: 220 }],
      goodsValue: 220, currency: 'EUR',
    },
    {
      key: 'etsy:3301249981', platform: 'etsy', ref: '3301249981', date: day(2), buyer: 'Emily Chen',
      address: { name: 'Emily Chen', company: '', line1: '88 Fifth Avenue', line2: '', city: 'New York', state: 'New York', postalCode: '10011', country: 'US', phone: '', email: 'emily@example.com' },
      items: [
        { title: 'Antique French linen sheet', sku: 'LI-310', image: demoImg('Drap', '#8e9aaf'), qty: 1, price: 89 },
        { title: 'Monogrammed napkins x6', sku: 'LI-311', qty: 1, price: 42 },
      ],
      goodsValue: 131, currency: 'USD',
    },
    {
      key: 'ebay:23-11111-22222', platform: 'ebay', ref: '23-11111-22222', date: day(3), buyer: 'londonfinds',
      address: { name: 'Oliver Hughes', company: '', line1: '5 Camden Passage', line2: '', city: 'London', state: '', postalCode: 'N1 8EA', country: 'GB', phone: '+447700900123', email: '' },
      items: [{ title: 'Faience plate Quimper', sku: 'FA-077', image: demoImg('Assiette', '#2e6f95'), qty: 1, price: 65 }],
      goodsValue: 65, currency: 'EUR',
    },
  ];
}

export function mockRates(o) {
  const w = Math.max(Number(o.parcel.weight), (o.parcel.length * o.parcel.width * o.parcel.height) / 5000);
  const zone = zoneOf(o.address.country);
  const table =
    zone === 'FR' ? [['11', 9 + w * 1.2], ['65', 21 + w * 2.5], ['07', 29 + w * 3]]
    : zone === 'EU' ? [['11', 14 + w * 2], ['65', 32 + w * 4], ['07', 41 + w * 5]]
    : [['08', 52 + w * 7], ['65', 58 + w * 8], ['07', 71 + w * 9]];
  return table.map(([code, total]) => ({
    code, name: serviceName(code), total: Math.round(total * 100) / 100, currency: 'EUR',
    negotiated: true, publishedTotal: Math.round(total * 1.35 * 100) / 100, days: null,
  }));
}

export function mockShipment(o, serviceCode) {
  const tracking = `1Z999AA1${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
  const a = o.address;
  const esc = (s) => String(s ?? '').replace(/[<&>]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200" viewBox="0 0 800 1200">
<rect width="800" height="1200" fill="#fff" stroke="#000" stroke-width="6"/>
<text x="40" y="80" font-family="Arial" font-size="40" font-weight="bold">UPS — ÉTIQUETTE DE DÉMO</text>
<text x="40" y="140" font-family="Arial" font-size="26">${esc(serviceName(serviceCode))}</text>
<text x="40" y="260" font-family="Arial" font-size="30" font-weight="bold">SHIP TO:</text>
<text x="40" y="310" font-family="Arial" font-size="30">${esc(a.name)}</text>
<text x="40" y="355" font-family="Arial" font-size="30">${esc(a.line1)}</text>
<text x="40" y="400" font-family="Arial" font-size="30">${esc(a.postalCode)} ${esc(a.city)} ${esc(a.state)}</text>
<text x="40" y="445" font-family="Arial" font-size="30">${esc(a.country)}</text>
<text x="40" y="620" font-family="Courier New" font-size="44" font-weight="bold">${tracking}</text>
<text x="40" y="1150" font-family="Arial" font-size="22" fill="#b00">NE PAS UTILISER — mode démo</text></svg>`;
  return {
    shipmentId: tracking,
    labels: [{ tracking, format: 'SVG', base64: Buffer.from(svg).toString('base64') }],
    invoicePdfBase64: null,
    total: mockRates(o).find((r) => r.code === serviceCode)?.total ?? 0,
    currency: 'EUR',
  };
}
