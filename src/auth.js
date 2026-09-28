// Protection par mot de passe (obligatoire quand l'application est hébergée)
import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { config } from './config.js';

const COOKIE = 'ups_sess';
const MAX_AGE_S = 30 * 24 * 3600; // 30 jours
const PUBLIC = new Set(['/login', '/healthz', '/style.css']);
const failures = new Map(); // ip -> { n, since }

const sign = (v) => createHmac('sha256', `${config.auth.secret}|${config.auth.password}`).update(v).digest('hex');

function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}

function validSession(req) {
  const [exp, sig] = readCookie(req).split('.');
  return Boolean(exp && sig && Number(exp) > Date.now() && safeEq(sig, sign(exp)));
}

function setCookie(res, value, maxAge) {
  const secure = config.baseUrl.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

const page = (msg = '', next = '/') => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>UPS Expéditions — connexion</title>
<link rel="stylesheet" href="/style.css"></head><body>
<form method="post" action="/login" class="login">
  <h1>UPS Expéditions</h1>
  ${msg ? `<p class="error">${msg}</p>` : ''}
  <input type="hidden" name="next" value="${String(next).replace(/[^\w/?=&.-]/g, '')}">
  <label class="f"><span>Mot de passe</span><input type="password" name="password" autofocus required autocomplete="current-password"></label>
  <button class="btn primary">Se connecter</button>
</form></body></html>`;

export function installAuth(app) {
  if (config.hosted) app.set('trust proxy', 1);
  app.get('/healthz', (req, res) => res.send('ok'));

  // Hébergée sans mot de passe : on refuse tout plutôt que d'exposer les données clients
  if (!config.auth.password) {
    if (config.hosted && !config.mock) {
      app.use((req, res) =>
        res.status(503).send('APP_PASSWORD manquant dans les variables d\'environnement Render : application verrouillée.'),
      );
    }
    return;
  }

  app.get('/login', (req, res) => res.send(page('', req.query.next || '/')));
  app.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
    const ip = req.ip;
    const f = failures.get(ip);
    if (f && f.n >= 10 && Date.now() - f.since < 15 * 60_000) {
      return res.status(429).send(page('Trop de tentatives. Réessayez dans 15 minutes.'));
    }
    if (safeEq(req.body?.password || '', config.auth.password)) {
      failures.delete(ip);
      const exp = String(Date.now() + MAX_AGE_S * 1000);
      setCookie(res, `${exp}.${sign(exp)}`, MAX_AGE_S);
      const next = String(req.body?.next || '/');
      return res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
    }
    failures.set(ip, { n: (f && Date.now() - f.since < 15 * 60_000 ? f.n : 0) + 1, since: f?.since && Date.now() - f.since < 15 * 60_000 ? f.since : Date.now() });
    await new Promise((r) => setTimeout(r, 1000));
    res.status(401).send(page('Mot de passe incorrect.', req.body?.next));
  });
  app.post('/logout', (req, res) => {
    setCookie(res, '', 0);
    res.json({ ok: true });
  });

  app.use((req, res, next) => {
    if (PUBLIC.has(req.path) || validSession(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Session expirée : rechargez la page' });
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  });
}
