import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config, ROOT } from './config.js';
import { load, save, update, LABELS_DIR, purgeThumbs } from './store.js';
import * as ups from './ups.js';
import * as ebay from './connectors/ebay.js';
import * as etsy from './connectors/etsy.js';
import * as shopify from './connectors/shopify.js';
import { installAuth } from './auth.js';
import { mockOrders, mockRates, mockShipment } from './mock.js';
import { needsCustoms, pickService, serviceName, zoneOf } from './zones.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
installAuth(app);
app.use(express.static(path.join(ROOT, 'public')));
app.use('/labels', express.static(LABELS_DIR));

const PLATFORMS = { ebay, etsy, shopify };
const DEFAULT_PRESETS = [
  { name: 'Petit', length: 25, width: 20, height: 10, weight: 1 },
  { name: 'Moyen', length: 40, width: 30, height: 20, weight: 3 },
  { name: 'Grand', length: 60, width: 40, height: 40, weight: 8 },
];
if (!load('presets', null)) save('presets', DEFAULT_PRESETS);

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: e.message }));

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- Statut / réglages ----------

const WHERE = () => (config.hosted ? 'les variables Render (Environment)' : 'le fichier .env');
const MISSING = {
  ebay: () => [['EBAY_CLIENT_ID', config.ebay.clientId], ['EBAY_CLIENT_SECRET', config.ebay.clientSecret], ['EBAY_RUNAME', config.ebay.ruName]],
  etsy: () => [['ETSY_KEYSTRING', config.etsy.keystring], ['ETSY_SHARED_SECRET', config.etsy.sharedSecret], ['ETSY_REDIRECT_URI', config.etsy.redirectUri]],
  shopify: () =>
    config.shopify.adminToken
      ? [['SHOPIFY_SHOP', config.shopify.shop]]
      : [['SHOPIFY_SHOP', config.shopify.shop], ['SHOPIFY_CLIENT_ID', config.shopify.clientId], ['SHOPIFY_CLIENT_SECRET', config.shopify.clientSecret]],
};
const missingVars = (k) => MISSING[k]().filter(([, v]) => !v).map(([n]) => n);

function etsyWarnings() {
  const { keystring, redirectUri } = config.etsy;
  if (!keystring) return [];
  if (!redirectUri)
    return [`Etsy : renseignez ETSY_REDIRECT_URI dans ${WHERE()} avec une des « Callback URLs » déclarées dans l'app Etsy (copie exacte).`];
  if (!redirectUri.startsWith('https://'))
    return ['Etsy : ETSY_REDIRECT_URI doit commencer par https:// (exigence Etsy).'];
  return [];
}

app.get('/api/status', (req, res) => {
  const platforms = Object.fromEntries(
    Object.entries(PLATFORMS).map(([k, m]) => [
      k,
      {
        configured: config.mock || m.configured(),
        connected: config.mock || m.connected(),
        // bouton « Connecter » (Shopify seulement en mode oauth)
        connectable: k !== 'shopify' || m.needsConnect(),
        reconnect: !config.mock && k === 'etsy' && m.needsReconnect(),
        // connexion par copier-coller de l'adresse d'arrivée (sinon retour automatique)
        paste: !config.mock && (k === 'ebay' ? !config.hosted : k === 'etsy' ? m.pasteFlow() : false),
        missing: config.mock ? [] : missingVars(k),
      },
    ]),
  );
  res.json({
    mock: config.mock,
    hosted: config.hosted,
    authEnabled: Boolean(config.auth.password),
    configWhere: WHERE(),
    upsEnv: config.mock ? 'démo' : config.ups.env,
    upsConfigured: config.mock || ups.upsConfigured(),
    shipperOk: Boolean(config.shipper.line1 && config.shipper.phone),
    labelFormat: config.ups.labelFormat,
    platforms,
    warnings: config.mock ? [] : [...(ebay.configured() ? ebay.diagnose() : []), ...etsyWarnings()],
    presets: load('presets', DEFAULT_PRESETS),
  });
});

app.put('/api/presets', (req, res) => {
  const list = (Array.isArray(req.body) ? req.body : [])
    .filter((p) => p && p.name)
    .map((p) => ({
      name: String(p.name).slice(0, 30),
      length: Number(p.length) || 0,
      width: Number(p.width) || 0,
      height: Number(p.height) || 0,
      weight: Number(p.weight) || 0,
    }));
  save('presets', list);
  res.json(list);
});

// ---------- Commandes ----------

app.get(
  '/api/orders',
  wrap(async (req, res) => {
    const errors = [];
    let orders = [];
    if (config.mock) {
      orders = mockOrders();
    } else {
      const checked = [];
      const results = await Promise.all(
        Object.entries(PLATFORMS).map(async ([name, m]) => {
          if (!m.configured() || !m.connected()) return [];
          try {
            const list = await m.fetchOrders();
            checked.push(name);
            return list;
          } catch (e) {
            errors.push({ platform: name, message: e.message });
            return [];
          }
        }),
      );
      orders = results.flat();
      // miniatures des commandes traitées (ici ou ailleurs) : supprimées
      try {
        purgeThumbs(new Set(orders.map((o) => o.key)), checked);
      } catch (e) {
        console.error(`Nettoyage des miniatures : ${e.message}`);
      }
    }
    const drafts = load('drafts', {});
    const shipments = load('shipments', {});
    orders = orders
      .map((o) => ({
        ...o,
        zone: zoneOf(o.address.country),
        customs: needsCustoms(o.address.country, o.address.postalCode),
        draft: drafts[o.key] || null,
        shipment: shipments[o.key] && !shipments[o.key].voided ? shipments[o.key] : null,
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    res.json({ orders, errors });
  }),
);

app.put('/api/drafts/:key', (req, res) => {
  update('drafts', {}, (d) => {
    d[req.params.key] = { ...req.body, savedAt: new Date().toISOString() };
  });
  res.json({ ok: true });
});

// ---------- Contrôle des données avant appel UPS ----------

function checkOrder(o) {
  const p = o?.parcel || {};
  const a = o?.address || {};
  const miss = [];
  for (const k of ['length', 'width', 'height', 'weight']) if (!(Number(p[k]) > 0)) miss.push(k);
  if (!String(p.contents || '').trim()) miss.push('contenu');
  if (!(Number(p.value) > 0)) miss.push('valeur');
  if (!p.currency) miss.push('devise');
  if (!a.name || !a.line1 || !a.city || !a.country) miss.push('adresse');
  if (a.country === 'US' && !a.state) miss.push('État (US)');
  // UPS : code SH de 6 à 15 caractères (erreur 128048 sinon) ; vide = pas de code
  const hs = String(p.hsCode || '').replace(/[\s.]/g, '');
  if (hs && !/^[0-9A-Za-z]{6,15}$/.test(hs)) miss.push('code SH (6 à 15 chiffres, ex. 970690)');
  const labels = { length: 'longueur', width: 'largeur', height: 'hauteur', weight: 'poids' };
  return miss.map((m) => labels[m] || m);
}

// ---------- Tarifs ----------

app.post(
  '/api/rates',
  wrap(async (req, res) => {
    if (!config.mock && !ups.upsConfigured()) throw new Error(`Identifiants UPS manquants dans ${WHERE()}`);
    const list = Array.isArray(req.body?.orders) ? req.body.orders : [];
    const results = await mapLimit(list, 3, async (o) => {
      const missing = checkOrder(o);
      if (missing.length) return { key: o.key, error: `Champs manquants : ${missing.join(', ')}` };
      try {
        const rates = config.mock ? mockRates(o) : await ups.shopRates(o);
        rates.sort((a, b) => a.total - b.total);
        const pick = pickService(rates, o.address.country);
        if (!pick) return { key: o.key, error: 'Aucun tarif UPS renvoyé', rates };
        return { key: o.key, rates, ...pick };
      } catch (e) {
        return { key: o.key, error: e.message };
      }
    });
    res.json({ results });
  }),
);

// ---------- Estimation libre (aucune étiquette créée) ----------

app.post(
  '/api/quote',
  wrap(async (req, res) => {
    const b = req.body || {};
    const country = String(b.country || '').trim().toUpperCase();
    const postalCode = String(b.postalCode || '').trim();
    const parcel = {
      length: Number(String(b.length).replace(',', '.')),
      width: Number(String(b.width).replace(',', '.')),
      height: Number(String(b.height).replace(',', '.')),
      weight: Number(String(b.weight).replace(',', '.')),
      value: Number(String(b.value).replace(',', '.')) || 20,
      currency: 'EUR',
      contents: 'Estimation',
    };
    const miss = [];
    for (const [k, l] of [['length', 'longueur'], ['width', 'largeur'], ['height', 'hauteur'], ['weight', 'poids']]) {
      if (!(parcel[k] > 0)) miss.push(l);
    }
    if (!/^[A-Z]{2}$/.test(country)) miss.push('pays (code à 2 lettres, ex. FR, US)');
    if (!postalCode) miss.push('code postal');
    if (miss.length) throw new Error(`Champs manquants : ${miss.join(', ')}`);
    if (!config.mock && !ups.upsConfigured()) throw new Error(`Identifiants UPS manquants dans ${WHERE()}`);
    const o = {
      key: 'estimation',
      ref: 'estimation',
      parcel,
      address: {
        name: 'Estimation',
        line1: 'Estimation',
        city: String(b.city || '').trim() || 'Estimation',
        state: String(b.state || '').trim(),
        postalCode,
        country,
      },
    };
    const rates = config.mock ? mockRates(o) : await ups.shopRates(o);
    rates.sort((a, c) => a.total - c.total);
    res.json({ rates, ...(pickService(rates, country) || {}) });
  }),
);

// ---------- Aperçu avant création (aucun appel UPS) ----------

app.post(
  '/api/preview',
  wrap(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const results = items.map(({ order: o, serviceCode }) => {
      const missing = checkOrder(o);
      if (missing.length || !serviceCode) return { key: o?.key, error: `Champs manquants : ${missing.join(', ') || 'service'}` };
      try {
        return { ...ups.previewShipment(o, serviceCode), serviceName: serviceName(serviceCode) };
      } catch (e) {
        return { key: o.key, error: e.message };
      }
    });
    res.json({ results });
  }),
);

// ---------- Expédition ----------

const safe = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 60);
const EXT = { GIF: 'gif', PNG: 'png', ZPL: 'zpl', EPL: 'epl', SPL: 'spl', SVG: 'svg' };

function writeFile(dir, name, base64) {
  fs.mkdirSync(path.join(LABELS_DIR, dir), { recursive: true });
  fs.writeFileSync(path.join(LABELS_DIR, dir, name), Buffer.from(base64, 'base64'));
  return `/labels/${dir}/${name}`;
}

/** Envoie le numéro de suivi à la plateforme (eBay, Etsy, Shopify) et mémorise le résultat */
async function syncTracking(key) {
  const rec = load('shipments', {})[key];
  if (!rec || rec.voided || !['ebay', 'etsy', 'shopify'].includes(rec.platform)) return rec?.platformSync || null;
  let result;
  try {
    if (rec.mock || config.mock) result = { ok: true, at: new Date().toISOString(), demo: true };
    else {
      if (rec.platform === 'ebay') await ebay.markShipped(rec.ref, rec.tracking[0], rec.createdAt);
      else if (rec.platform === 'etsy') await etsy.markShipped(rec.ref, rec.tracking[0]);
      else await shopify.markShipped(key.split(':')[1], rec.tracking[0]);
      result = { ok: true, at: new Date().toISOString() };
    }
  } catch (e) {
    result = { ok: false, at: new Date().toISOString(), error: e.message };
  }
  update('shipments', {}, (s) => {
    if (s[key]) s[key].platformSync = result;
  });
  return result;
}

app.post(
  '/api/sync/:key',
  wrap(async (req, res) => {
    const r = await syncTracking(req.params.key);
    if (!r) throw new Error('Rien à envoyer pour cette commande');
    res.json(r);
  }),
);

app.post(
  '/api/ship',
  wrap(async (req, res) => {
    if (!config.mock && !ups.upsConfigured()) throw new Error(`Identifiants UPS manquants dans ${WHERE()}`);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const force = Boolean(req.body?.force);
    const results = [];

    // séquentiel : on ne veut pas de doublon ni d'erreur en rafale sur des étiquettes facturées
    for (const { order: o, serviceCode } of items) {
      const existing = load('shipments', {})[o?.key];
      if (existing && !existing.voided && !force) {
        results.push({ key: o.key, error: 'Bordereau déjà créé pour cette commande', shipment: existing });
        continue;
      }
      const missing = checkOrder(o);
      if (missing.length || !serviceCode) {
        results.push({ key: o?.key, error: `Champs manquants : ${missing.join(', ') || 'service'}` });
        continue;
      }
      try {
        const r = config.mock ? mockShipment(o, serviceCode) : await ups.createShipment(o, serviceCode);
        const dir = new Date().toISOString().slice(0, 10);
        const baseName = `${o.platform}-${safe(o.ref)}`;
        const labelFiles = r.labels
          .filter((l) => l.base64)
          .map((l) => ({
            tracking: l.tracking,
            format: l.format,
            url: writeFile(dir, `${baseName}-${l.tracking}.${EXT[l.format] || 'bin'}`, l.base64),
          }));
        const invoiceUrl = r.invoicePdfBase64
          ? writeFile(dir, `${baseName}-facture.pdf`, r.invoicePdfBase64)
          : null;
        const rec = {
          key: o.key,
          platform: o.platform,
          ref: o.ref,
          name: o.address.name,
          country: o.address.country,
          serviceCode,
          serviceName: serviceName(serviceCode),
          shipmentId: r.shipmentId,
          tracking: labelFiles.map((l) => l.tracking),
          labels: labelFiles,
          invoiceUrl,
          total: r.total,
          currency: r.currency,
          createdAt: new Date().toISOString(),
          mock: config.mock,
          voided: false,
        };
        update('shipments', {}, (s) => {
          s[o.key] = rec;
        });
        rec.platformSync = await syncTracking(o.key);
        results.push({ key: o.key, shipment: rec });
      } catch (e) {
        results.push({ key: o.key, error: e.message });
      }
    }
    res.json({ results });
  }),
);

app.post(
  '/api/void/:key',
  wrap(async (req, res) => {
    const rec = load('shipments', {})[req.params.key];
    if (!rec || rec.voided) throw new Error('Aucun bordereau actif pour cette commande');
    const r = rec.mock || config.mock ? { ok: true, message: 'Annulé (démo)' } : await ups.voidShipment(rec.shipmentId);
    if (!r.ok) throw new Error(r.message);
    update('shipments', {}, (s) => {
      s[req.params.key].voided = true;
      s[req.params.key].voidedAt = new Date().toISOString();
    });
    res.json(r);
  }),
);

app.get('/api/shipments', (req, res) => {
  const all = Object.values(load('shipments', {}));
  res.json(all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

// ---------- Page d'impression ----------

app.get('/print', (req, res) => {
  const keys = String(req.query.keys || '').split(',').filter(Boolean);
  const format = req.query.format === 'a4' ? 'a4' : '10x15';
  const all = load('shipments', {});
  const recs = keys.map((k) => all[k]).filter((r) => r && !r.voided);
  const imgs = recs.flatMap((r) =>
    r.labels.filter((l) => ['GIF', 'PNG', 'SVG'].includes(l.format)).map((l) => ({ ...l, rec: r })),
  );
  const raw = recs.flatMap((r) => r.labels.filter((l) => !['GIF', 'PNG', 'SVG'].includes(l.format)));
  const invoices = recs.filter((r) => r.invoiceUrl);
  const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

  res.type('html').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Bordereaux UPS</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font-family: system-ui, sans-serif; background: #eee; }
  .bar { padding: 12px 16px; background: #fff; border-bottom: 1px solid #ccc; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .bar a, .bar button { font: inherit; }
  .sheet { background: #fff; margin: 16px auto; box-shadow: 0 1px 4px rgba(0,0,0,.2); overflow: hidden; position: relative; }
  .f10 .sheet { width: 4in; height: 6in; }
  .a4 .sheet { width: 210mm; height: 297mm; display: flex; flex-direction: column; justify-content: space-around; align-items: center; }
  .f10 img.land { position: absolute; top: 0; left: 0; width: 6in; height: 4in; transform-origin: top left; transform: rotate(90deg) translateY(-4in); }
  .f10 img.port { width: 4in; height: 6in; object-fit: contain; }
  .a4 img.land { width: 190mm; max-height: 140mm; object-fit: contain; }
  .a4 img.port { height: 140mm; object-fit: contain; }
  @media print {
    body { background: #fff; }
    .bar { display: none; }
    .sheet { margin: 0; box-shadow: none; page-break-after: always; break-after: page; }
    .sheet:last-child { page-break-after: auto; break-after: auto; }
  }
  @page { margin: 0; size: ${format === 'a4' ? 'A4 portrait' : '4in 6in'}; }
</style></head>
<body class="${format === 'a4' ? 'a4' : 'f10'}">
<div class="bar">
  <strong>${imgs.length} étiquette(s)</strong>
  <button onclick="window.print()">Imprimer</button>
  <a href="?keys=${esc(keys.join(','))}&format=10x15">Format 10×15</a>
  <a href="?keys=${esc(keys.join(','))}&format=a4">Format A4 (2 par page)</a>
  ${invoices.length ? `<span>Factures commerciales : ${invoices.map((r) => `<a href="${esc(r.invoiceUrl)}" target="_blank">${esc(r.ref)}</a>`).join(', ')}</span>` : ''}
  ${raw.length ? `<span>Fichiers ${esc(raw[0].format)} : ${raw.map((l) => `<a href="${esc(l.url)}" download>${esc(l.tracking)}</a>`).join(', ')}</span>` : ''}
</div>
<div id="sheets"></div>
<script>
  const imgs = ${JSON.stringify(imgs.map((i) => ({ url: i.url, alt: `${i.rec.ref} ${i.tracking}` }))).replace(/</g, '\\u003c')};
  const perSheet = document.body.classList.contains('a4') ? 2 : 1;
  const root = document.getElementById('sheets');
  let sheet;
  imgs.forEach((it, i) => {
    if (i % perSheet === 0) { sheet = document.createElement('div'); sheet.className = 'sheet'; root.appendChild(sheet); }
    const img = new Image();
    img.alt = it.alt;
    img.onload = () => { img.className = img.naturalWidth > img.naturalHeight ? 'land' : 'port'; };
    img.src = it.url;
    sheet.appendChild(img);
  });
</script>
</body></html>`);
});

// ---------- Connexion aux plateformes ----------

app.get('/auth/ebay/start', (req, res) => res.redirect(ebay.authUrl()));
const authError = (res, e) =>
  res.status(400).send(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css">
<p class="error pad">${String(e.message).replace(/[<>&]/g, '')}</p><p class="pad"><a href="/">Retour</a></p>`);
app.get('/auth/ebay/callback', (req, res) =>
  ebay.handleCallback(req.query).then(() => res.redirect('/?connected=ebay'), (e) => authError(res, e)),
);
app.get('/auth/shopify/start', (req, res) => res.redirect(shopify.authUrl()));
app.get('/auth/shopify/callback', (req, res) =>
  shopify.handleCallback(req.query).then(() => res.redirect('/?connected=shopify'), (e) => authError(res, e)),
);
app.post(
  '/auth/ebay/code',
  wrap(async (req, res) => {
    await ebay.exchangeCode(req.body?.value);
    res.json({ ok: true });
  }),
);
app.get('/auth/etsy/start', (req, res) => res.redirect(etsy.authUrl()));
app.post(
  '/auth/etsy/code',
  wrap(async (req, res) => {
    await etsy.exchangePasted(req.body?.value);
    res.json({ ok: true });
  }),
);
app.get('/auth/etsy/callback', (req, res) =>
  (req.query.error
    ? Promise.reject(new Error(`Etsy : ${req.query.error_description || req.query.error}`))
    : etsy.handleCallback(String(req.query.code || ''), String(req.query.state || ''))
  ).then(() => res.redirect('/?connected=etsy'), (e) => authError(res, e)),
);

// ---------- Arrêt depuis l'interface (l'application tourne sans fenêtre) ----------

app.post('/api/shutdown', (req, res) => {
  if (config.hosted) return res.status(403).json({ error: 'Non disponible sur la version en ligne' });
  res.json({ ok: true });
  console.log('Arrêt demandé depuis l\'interface.');
  setTimeout(() => process.exit(0), 200);
});

// Nettoyage des miniatures des commandes étiquetées : au démarrage puis toutes les heures
const runPurge = () => {
  try {
    const n = purgeThumbs();
    if (n) console.log(`Miniatures supprimées : ${n}`);
  } catch (e) {
    console.error(`Nettoyage des miniatures : ${e.message}`);
  }
};
runPurge();
setInterval(runPurge, 3600_000).unref();

const server = app.listen(config.port, config.host, () => {
  console.log(`\n  UPS Expéditions : ${config.baseUrl}`);
  if (config.hosted && !config.auth.password) console.log('  ATTENTION : APP_PASSWORD manquant, application verrouillée.');
  console.log(
    config.mock
      ? '  Mode DÉMO : aucune donnée réelle, aucune étiquette facturée.\n'
      : `  UPS : environnement ${config.ups.env}${config.ups.env === 'production' ? ' (étiquettes FACTURÉES)' : ' (test)'}\n`,
  );
});
server.on('error', (e) => {
  console.error(
    e.code === 'EADDRINUSE'
      ? `Le port ${config.port} est déjà utilisé (application déjà lancée ?).`
      : `Erreur serveur : ${e.message}`,
  );
  process.exit(1);
});
