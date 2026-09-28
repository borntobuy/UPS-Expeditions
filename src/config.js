import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const env = (k, d = '') => String(process.env[k] ?? d).trim();
const bool = (k, d) => env(k, d).toLowerCase() === 'true';
const demo = bool('MOCK', 'false') || process.argv.includes('--demo');
// Hébergé (Render) : RENDER=true est posé automatiquement par Render
const hosted = bool('RENDER', 'false') || bool('HOSTED', 'false');
// La démo locale tourne sur le port suivant pour ne jamais se confondre avec l'application réelle
const port = Number(env('PORT', hosted ? '10000' : '3000')) + (demo && !hosted ? 1 : 0);
// Adresse publique : RENDER_EXTERNAL_URL (fourni par Render) ou BASE_URL, sinon localhost
const baseUrl = (env('BASE_URL') || env('RENDER_EXTERNAL_URL') || `http://localhost:${port}`).replace(/\/+$/, '');

export const config = {
  port,
  mock: demo,
  hosted,
  baseUrl,
  host: hosted ? '0.0.0.0' : '127.0.0.1',
  // Dossier des données : le disque persistant sur Render (ex. /var/data)
  dataDir: env('DATA_DIR') || path.join(ROOT, 'data'),
  auth: {
    password: env('APP_PASSWORD'),
    secret: env('SESSION_SECRET') || env('APP_PASSWORD'),
  },
  ups: {
    env: env('UPS_ENV', 'test'),
    clientId: env('UPS_CLIENT_ID'),
    clientSecret: env('UPS_CLIENT_SECRET'),
    account: env('UPS_ACCOUNT_NUMBER'),
    negotiated: bool('UPS_NEGOTIATED_RATES', 'true'),
    ddp: bool('UPS_DDP', 'false'),
    labelFormat: env('UPS_LABEL_FORMAT', 'GIF').toUpperCase(),
    ratingVersion: env('UPS_RATING_VERSION', 'v2403'),
    shipVersion: env('UPS_SHIP_VERSION', 'v2409'),
  },
  shipper: {
    name: env('SHIPPER_NAME'),
    company: env('SHIPPER_COMPANY'),
    phone: env('SHIPPER_PHONE'),
    email: env('SHIPPER_EMAIL'),
    line1: env('SHIPPER_ADDRESS1'),
    line2: env('SHIPPER_ADDRESS2'),
    city: env('SHIPPER_CITY'),
    postalCode: env('SHIPPER_POSTAL_CODE'),
    country: env('SHIPPER_COUNTRY', 'FR'),
  },
  customs: {
    defaultHsCode: env('DEFAULT_HS_CODE'),
    origin: env('ORIGIN_COUNTRY', 'FR'),
  },
  ebay: {
    clientId: env('EBAY_CLIENT_ID'),
    clientSecret: env('EBAY_CLIENT_SECRET'),
    ruName: env('EBAY_RUNAME'),
  },
  etsy: {
    keystring: env('ETSY_KEYSTRING'),
    sharedSecret: env('ETSY_SHARED_SECRET'),
    // Etsy n'accepte que des adresses de rappel en https:// déclarées dans l'app :
    // on reprend celle déjà déclarée (ex. celle de l'outil SEO) et on colle l'adresse d'arrivée.
    // Vide = callback de cette application (fonctionne seulement en https, donc hébergée)
    redirectUri: env('ETSY_REDIRECT_URI') || (baseUrl.startsWith('https://') ? `${baseUrl}/auth/etsy/callback` : ''),
  },
  shopify: {
    shop: normalizeShop(env('SHOPIFY_SHOP')),
    clientId: env('SHOPIFY_CLIENT_ID'),
    clientSecret: env('SHOPIFY_CLIENT_SECRET'),
    adminToken: env('SHOPIFY_ADMIN_TOKEN'),
    apiVersion: env('SHOPIFY_API_VERSION', '2026-07'),
    // client_credentials (app Dev Dashboard de la même organisation) ou oauth (bouton « Connecter »)
    authMode: env('SHOPIFY_AUTH_MODE', 'client_credentials').toLowerCase(),
    scopes: env('SHOPIFY_SCOPES', 'read_orders'),
  },
};

function normalizeShop(s) {
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return s.includes('.') ? s : `${s}.myshopify.com`;
}
