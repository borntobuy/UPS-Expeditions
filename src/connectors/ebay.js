// eBay — Sell Fulfillment API (OAuth utilisateur, jeton de rafraîchissement ~18 mois)
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { load, update, cachedThumb, eachLimit } from '../store.js';

const API = 'https://api.ebay.com';
const SCOPES = ['https://api.ebay.com/oauth/api_scope/sell.fulfillment'];

const basic = () =>
  Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString('base64');

export const configured = () =>
  Boolean(config.ebay.clientId && config.ebay.clientSecret && config.ebay.ruName);
/** Contrôles de forme des identifiants (indicatifs : formats observés, non documentés officiellement) */
export function diagnose() {
  const w = [];
  const { clientId, clientSecret, ruName } = config.ebay;
  if (clientId && /-SBX-/i.test(clientId)) w.push("EBAY_CLIENT_ID est un App ID de Sandbox : prenez celui de la colonne Production.");
  if (clientSecret && /^SBX-/i.test(clientSecret)) w.push("EBAY_CLIENT_SECRET est un Cert ID de Sandbox : prenez celui de Production.");
  if (ruName && /:\/\/|\s/.test(ruName))
    w.push("EBAY_RUNAME doit contenir le RuName (ex. Benoit_Fretel-BenoitFr-MonApp-abcde), pas une adresse http.");
  return w;
}

export const connected = () => Boolean(load('tokens', {}).ebay?.refresh);

const pendingStates = new Map(); // state -> date, contre les requêtes forgées

export function authUrl() {
  const state = randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  const q = new URLSearchParams({
    state,
    client_id: config.ebay.clientId,
    response_type: 'code',
    redirect_uri: config.ebay.ruName,
    scope: SCOPES.join(' '),
    prompt: 'login',
  });
  return `https://auth.ebay.com/oauth2/authorize?${q.toString().replace(/\+/g, "%20")}`;
}

async function tokenRequest(params) {
  const r = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic()}`,
    },
    body: new URLSearchParams(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`eBay OAuth : ${j.error_description || j.error || r.status}`);
  return j;
}

/** Retour automatique (« auth accepted URL » du RuName pointant vers /auth/ebay/callback) */
export async function handleCallback(query) {
  if (query.error) throw new Error(`eBay : ${query.error_description || query.error}`);
  const st = String(query.state || '');
  if (!pendingStates.has(st)) throw new Error('Session eBay expirée ou inconnue : cliquez de nouveau sur « Connecter »');
  pendingStates.delete(st);
  await exchangeCode(String(query.code || ''));
}

/** Accepte le code seul ou l'URL complète sur laquelle eBay a redirigé */
export async function exchangeCode(input) {
  let code = String(input || '').trim();
  if (code.startsWith('http')) code = new URL(code).searchParams.get('code') || '';
  if (!code) throw new Error('Code eBay introuvable dans ce qui a été collé');
  const j = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.ebay.ruName,
  });
  update('tokens', {}, (t) => {
    t.ebay = {
      access: j.access_token,
      accessExp: Date.now() + j.expires_in * 1000,
      refresh: j.refresh_token,
      refreshExp: Date.now() + (j.refresh_token_expires_in || 0) * 1000,
    };
  });
}

async function accessToken() {
  const t = load('tokens', {}).ebay;
  if (!t?.refresh) throw new Error('eBay non connecté');
  if (t.access && t.accessExp > Date.now() + 60_000) return t.access;
  const j = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: t.refresh,
    scope: SCOPES.join(' '),
  });
  update('tokens', {}, (all) => {
    all.ebay = { ...all.ebay, access: j.access_token, accessExp: Date.now() + j.expires_in * 1000 };
  });
  return j.access_token;
}

// Jeton « application » (client credentials) pour l'API Browse, qui fournit les photos des annonces
let appTok = null;
async function appToken() {
  if (appTok && appTok.exp > Date.now() + 60_000) return appTok.value;
  const j = await tokenRequest({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' });
  appTok = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return appTok.value;
}

/** Photo principale via Browse getItemByLegacyId (annonce encore consultable ; sinon pas de miniature) */
async function itemImage(legacyItemId, legacyVariationId) {
  const q = new URLSearchParams({ legacy_item_id: legacyItemId });
  if (legacyVariationId) q.set('legacy_variation_id', legacyVariationId);
  const r = await fetch(`${API}/buy/browse/v1/item/get_item_by_legacy_id?${q}`, {
    headers: { Authorization: `Bearer ${await appToken()}` },
  });
  if (!r.ok) return '';
  const j = await r.json().catch(() => ({}));
  return j.image?.imageUrl || j.thumbnailImages?.[0]?.imageUrl || '';
}

export async function fetchOrders() {
  const tok = await accessToken();
  const filter = encodeURIComponent('orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}');
  const r = await fetch(`${API}/sell/fulfillment/v1/order?filter=${filter}&limit=100`, {
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.errors?.[0]?.longMessage || j?.errors?.[0]?.message || `HTTP ${r.status}`);

  const orders = (j.orders || [])
    .filter((o) => o.orderPaymentStatus === 'PAID' && o.cancelStatus?.cancelState !== 'CANCELED')
    .map((o) => {
      const st = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo || {};
      const a = st.contactAddress || {};
      return {
        key: `ebay:${o.orderId}`,
        platform: 'ebay',
        ref: o.orderId,
        date: o.creationDate,
        buyer: o.buyer?.username || '',
        address: {
          name: st.fullName || '',
          company: st.companyName || '',
          line1: a.addressLine1 || '',
          line2: a.addressLine2 || '',
          city: a.city || '',
          state: a.stateOrProvince || '',
          postalCode: a.postalCode || '',
          country: a.countryCode || '',
          phone: st.primaryPhone?.phoneNumber || '',
          email: st.email || '',
        },
        items: (o.lineItems || []).map((li) => ({
          title: li.title,
          sku: li.sku || '',
          legacyItemId: li.legacyItemId,
          legacyVariationId: li.legacyVariationId,
          qty: li.quantity,
          price: Number(li.lineItemCost?.value || 0),
        })),
        // valeur des marchandises (hors port) = base de la valeur déclarée
        goodsValue: Number(
          o.pricingSummary?.priceSubtotal?.value ?? o.pricingSummary?.total?.value ?? 0,
        ),
        currency:
          o.pricingSummary?.priceSubtotal?.currency || o.pricingSummary?.total?.currency || 'EUR',
      };
    });

  const items = orders.flatMap((o) => o.items).filter((i) => i.legacyItemId);
  await eachLimit(items, 3, async (i) => {
    i.image = await cachedThumb(`ebay:${i.legacyItemId}:${i.legacyVariationId || ''}`, () =>
      itemImage(i.legacyItemId, i.legacyVariationId),
    );
  });
  for (const i of items) {
    delete i.legacyItemId;
    delete i.legacyVariationId;
  }
  return orders;
}
