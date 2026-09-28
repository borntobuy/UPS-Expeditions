// Shopify — Admin GraphQL API
// Auth : jeton admin statique (ancienne app perso) OU client credentials (app Dev Dashboard, jeton 24 h)
// ou OAuth « authorization code » (SHOPIFY_AUTH_MODE=oauth : bouton Connecter, jeton hors ligne conservé)
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { load, update } from '../store.js';

const s = () => config.shopify;
const oauth = () => !s().adminToken && s().authMode === 'oauth';
export const configured = () => Boolean(s().shop && (s().adminToken || (s().clientId && s().clientSecret)));
export const connected = () => configured() && (!oauth() || Boolean(load('tokens', {}).shopify?.access));
export const needsConnect = () => configured() && oauth();

let cached = null;
const pendingStates = new Map();

export function authUrl() {
  const state = randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  const q = new URLSearchParams({
    client_id: s().clientId,
    scope: s().scopes,
    redirect_uri: `${config.baseUrl}/auth/shopify/callback`,
    state,
  });
  return `https://${s().shop}/admin/oauth/authorize?${q}`;
}

/** Vérifie la signature HMAC renvoyée par Shopify (clé = secret de l'app) */
function validHmac(query) {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const msg = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('&');
  const calc = createHmac('sha256', s().clientSecret).update(msg).digest('hex');
  const a = Buffer.from(calc);
  const b = Buffer.from(String(hmac));
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleCallback(query) {
  if (query.error) throw new Error(`Shopify : ${query.error_description || query.error}`);
  if (!pendingStates.has(String(query.state))) throw new Error('Session Shopify expirée : cliquez de nouveau sur « Connecter »');
  pendingStates.delete(String(query.state));
  if (!validHmac(query)) throw new Error('Signature Shopify invalide');
  if (String(query.shop) !== s().shop) throw new Error(`Boutique inattendue : ${query.shop}`);
  const r = await fetch(`https://${s().shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: s().clientId, client_secret: s().clientSecret, code: String(query.code || '') }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Shopify OAuth : ${j.error_description || j.error || r.status}`);
  if (!String(j.scope || '').split(',').some((x) => x === 'read_orders' || x === 'write_orders'))
    throw new Error(`Shopify n'a pas accordé read_orders (droits obtenus : ${j.scope || 'aucun'})`);
  update('tokens', {}, (t) => {
    t.shopify = { access: j.access_token, scope: j.scope };
  });
}

async function token() {
  if (s().adminToken) return s().adminToken;
  if (oauth()) {
    const t = load('tokens', {}).shopify?.access;
    if (!t) throw new Error('Shopify non connecté');
    return t;
  }
  if (cached && cached.exp > Date.now() + 60_000) return cached.value;
  const r = await fetch(`https://${s().shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: s().clientId,
      client_secret: s().clientSecret,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Shopify OAuth : ${j.error_description || j.error || r.status}`);
  cached = { value: j.access_token, exp: Date.now() + Number(j.expires_in || 86399) * 1000 };
  return cached.value;
}

const QUERY = `query UnshippedOrders($q: String!) {
  orders(first: 50, query: $q, sortKey: CREATED_AT, reverse: true) {
    nodes {
      id
      legacyResourceId
      name
      createdAt
      email
      phone
      shippingAddress { name company address1 address2 city provinceCode province zip countryCodeV2 phone }
      currentSubtotalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 30) {
        nodes { title sku quantity originalTotalSet { shopMoney { amount currencyCode } } }
      }
    }
  }
}`;

export async function fetchOrders() {
  const r = await fetch(`https://${s().shop}/admin/api/${s().apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await token() },
    body: JSON.stringify({
      query: QUERY,
      variables: { q: 'status:open AND financial_status:paid AND fulfillment_status:unshipped' },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) {
    const msg = Array.isArray(j.errors) ? j.errors.map((e) => e.message).join(' | ') : j.errors;
    throw new Error(msg || `HTTP ${r.status}`);
  }

  return (j.data?.orders?.nodes || [])
    .filter((o) => o.shippingAddress)
    .map((o) => {
      const a = o.shippingAddress;
      const sub = o.currentSubtotalPriceSet?.shopMoney;
      return {
        key: `shopify:${o.legacyResourceId}`,
        platform: 'shopify',
        ref: o.name,
        date: o.createdAt,
        buyer: a.name || o.email || '',
        address: {
          name: a.name || '',
          company: a.company || '',
          line1: a.address1 || '',
          line2: a.address2 || '',
          city: a.city || '',
          state: a.provinceCode || a.province || '',
          postalCode: a.zip || '',
          country: a.countryCodeV2 || '',
          phone: a.phone || o.phone || '',
          email: o.email || '',
        },
        items: (o.lineItems?.nodes || []).map((li) => ({
          title: li.title,
          sku: li.sku || '',
          qty: li.quantity,
          price: Number(li.originalTotalSet?.shopMoney?.amount || 0),
        })),
        goodsValue: Number(sub?.amount || 0),
        currency: sub?.currencyCode || 'EUR',
      };
    });
}
