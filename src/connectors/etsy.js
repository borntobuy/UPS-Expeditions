// Etsy — Open API v3 (OAuth 2.0 + PKCE, en-tête x-api-key "keystring:secret")
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { load, update, cachedThumb, eachLimit } from '../store.js';

const API = 'https://api.etsy.com/v3';
const SCOPES = 'transactions_r email_r shops_r';
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const configured = () =>
  Boolean(config.etsy.keystring && config.etsy.sharedSecret && config.etsy.redirectUri);
// Si la callback est celle de cette application, Etsy nous renvoie directement ; sinon copier-coller
export const pasteFlow = () => !config.etsy.redirectUri.startsWith(`${config.baseUrl}/`);
export const connected = () => Boolean(load('tokens', {}).etsy?.refresh);

// state -> verifier, conservé sur disque pour survivre à un redémarrage
const PENDING = 'etsy-oauth-pending';
const TTL = 30 * 60_000;

export function authUrl() {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  update(PENDING, {}, (p) => {
    for (const [k, v] of Object.entries(p)) if (v.t < Date.now() - TTL) delete p[k];
    p[state] = { verifier, t: Date.now() };
  });
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: config.etsy.keystring,
    redirect_uri: config.etsy.redirectUri,
    scope: SCOPES,
    state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  });
  return `https://www.etsy.com/oauth/connect?${q.toString().replace(/\+/g, "%20")}`;
}

async function tokenRequest(params) {
  const r = await fetch(`${API}/public/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.etsy.keystring, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Etsy OAuth : ${j.error_description || j.error || r.status}`);
  return j;
}

function saveTokens(j) {
  update('tokens', {}, (t) => {
    t.etsy = {
      ...t.etsy,
      access: j.access_token,
      accessExp: Date.now() + j.expires_in * 1000,
      refresh: j.refresh_token,
      userId: String(j.access_token).split('.')[0],
    };
  });
}

/** Accepte l'URL complète sur laquelle Etsy a redirigé (contient code et state) */
export async function exchangePasted(input) {
  const raw = String(input || '').trim();
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Collez l'adresse complète de la page d'arrivée (elle commence par https://)");
  }
  const q = u.searchParams;
  if (q.get('error')) throw new Error(`Etsy : ${q.get('error_description') || q.get('error')}`);
  if (!q.get('code') || !q.get('state')) throw new Error("Code Etsy introuvable dans l'adresse collée");
  await handleCallback(q.get('code'), q.get('state'));
}

export async function handleCallback(code, state) {
  const entry = load(PENDING, {})[state];
  if (!entry) throw new Error('Session Etsy expirée ou inconnue : cliquez de nouveau sur « Connecter »');
  update(PENDING, {}, (p) => {
    delete p[state];
  });
  const { verifier } = entry;
  saveTokens(
    await tokenRequest({
      grant_type: 'authorization_code',
      redirect_uri: config.etsy.redirectUri,
      code,
      code_verifier: verifier,
    }),
  );
}

async function accessToken() {
  const t = load('tokens', {}).etsy;
  if (!t?.refresh) throw new Error('Etsy non connecté');
  if (t.access && t.accessExp > Date.now() + 60_000) return t.access;
  const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
  saveTokens(j);
  return j.access_token;
}

async function get(pathname) {
  const r = await fetch(`${API}${pathname}`, {
    headers: {
      'x-api-key': `${config.etsy.keystring}:${config.etsy.sharedSecret}`,
      Authorization: `Bearer ${await accessToken()}`,
    },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

async function shopId() {
  const t = load('tokens', {}).etsy;
  if (t?.shopId) return t.shopId;
  const me = await get('/application/users/me');
  if (!me.shop_id) throw new Error('Aucune boutique Etsy liée à ce compte');
  update('tokens', {}, (all) => {
    all.etsy.shopId = me.shop_id;
  });
  return me.shop_id;
}

const money = (m) => (m ? Number(m.amount) / Number(m.divisor || 100) : 0);

export async function fetchOrders() {
  const id = await shopId();
  const j = await get(
    `/application/shops/${id}/receipts?was_paid=true&was_shipped=false&was_canceled=false&limit=100`,
  );
  const orders = (j.results || []).map((r) => ({
    key: `etsy:${r.receipt_id}`,
    platform: 'etsy',
    ref: String(r.receipt_id),
    date: new Date(r.create_timestamp * 1000).toISOString(),
    buyer: r.name || '',
    address: {
      name: r.name || '',
      company: '',
      line1: r.first_line || '',
      line2: r.second_line || '',
      city: r.city || '',
      state: r.state || '',
      postalCode: r.zip || '',
      country: r.country_iso || '',
      phone: '',
      email: r.buyer_email || '',
    },
    items: (r.transactions || []).map((t) => ({
      title: t.title,
      sku: t.sku || '',
      listingId: t.listing_id,
      imageId: t.listing_image_id,
      qty: t.quantity,
      price: money(t.price) * (t.quantity || 1),
    })),
    goodsValue: money(r.subtotal) || money(r.grandtotal),
    currency: (r.subtotal || r.grandtotal)?.currency_code || 'EUR',
  }));

  // miniature : image principale de l'annonce (getListingImage → url_170x135)
  const pairs = orders.flatMap((o) => o.items.map((i) => [o.key, i])).filter(([, i]) => i.listingId && i.imageId);
  await eachLimit(pairs, 3, async ([orderKey, i]) => {
    i.image = await cachedThumb(
      `etsy:${i.listingId}:${i.imageId}`,
      async () => {
        const img = await get(`/application/listings/${i.listingId}/images/${i.imageId}`);
        return img.url_170x135 || img.url_75x75 || '';
      },
      orderKey,
    );
  });
  for (const [, i] of pairs) {
    delete i.listingId;
    delete i.imageId;
  }
  return orders;
}
