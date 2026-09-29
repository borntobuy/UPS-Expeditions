/* UPS Expéditions — interface */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PLAT = { ebay: 'eBay', etsy: 'Etsy', shopify: 'Shopify' };
const ZONE = { FR: 'France', EU: 'Europe', INTL: 'International' };

const state = {
  status: null,
  orders: [],
  sel: new Set(),
  rates: {},        // key -> { rates, code, rule, warning, error }
  errors: {},       // key -> message (expédition)
  sessionShipped: [],
  openAddr: new Set(),
};

const fmt = (n, cur = 'EUR') => {
  if (!Number.isFinite(Number(n))) return '—';
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: cur }).format(n);
  } catch {
    return `${Number(n).toFixed(2)} ${cur}`;
  }
};
const fdate = (d) => (d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) : '');

async function api(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Erreur ${r.status}`);
  return j;
}

function alertMsg(html, kind = 'err', ttl = 0) {
  const div = document.createElement('div');
  div.className = kind;
  div.innerHTML = html;
  $('#alerts').appendChild(div);
  if (ttl) setTimeout(() => div.remove(), ttl);
  return div;
}

// ---------------- Statut et connexions ----------------

async function loadStatus() {
  const s = (state.status = await api('/api/status'));
  $('#quitBtn').hidden = s.hosted;
  $('#logoutBtn').hidden = !s.authEnabled;
  const badge = $('#envBadge');
  badge.textContent = s.mock ? 'DÉMO' : s.upsEnv === 'production' ? 'UPS PRODUCTION' : 'UPS TEST';
  badge.className = `badge${!s.mock && s.upsEnv === 'production' ? ' prod' : ''}`;

  $('#platforms').innerHTML = Object.entries(s.platforms)
    .map(([k, p]) => {
      const on = p.connected;
      const action = !p.configured
        ? '<span class="muted">non configuré</span>'
        : on || !p.connectable ? '' : `<a href="/auth/${k}/start" ${p.paste ? 'target="_blank"' : ''}>Connecter</a>`;
      return `<span class="pchip ${on ? 'on' : ''}"><span class="dot"></span>${PLAT[k]} ${action}</span>`;
    })
    .join('');

  const tips = [];
  if (!s.mock) {
    const where = esc(s.configWhere || 'le fichier .env');
    if (!s.upsConfigured) tips.push(`Renseignez <code>UPS_CLIENT_ID</code>, <code>UPS_CLIENT_SECRET</code> et <code>UPS_ACCOUNT_NUMBER</code> dans ${where}.`);
    if (!s.shipperOk) tips.push(`Adresse ou téléphone expéditeur manquant (<code>SHIPPER_*</code> dans ${where}). UPS exige un téléphone pour l'international.`);
    for (const [k, p] of Object.entries(s.platforms)) {
      if (!p.configured) {
        const miss = (p.missing || []).map((n) => `<code>${esc(n)}</code>`).join(', ');
        tips.push(`${PLAT[k]} : ${miss ? `à renseigner dans ${where} : ${miss}` : `configuration incomplète dans ${where}`}.`);
      }
    }
  }
  for (const w of s.warnings || []) tips.push(esc(w));

  // eBay et Etsy : on accepte l'accès sur leur site, puis on colle ici l'adresse de la page d'arrivée
  const PASTE = {
    ebay: "eBay : cliquez sur « Connecter » en haut, acceptez, puis collez ici l'adresse de la page sur laquelle eBay vous renvoie (même si elle affiche une erreur).",
    etsy: "Etsy : cliquez sur « Connecter » en haut, autorisez, puis collez ici l'adresse complète de la page sur laquelle Etsy vous renvoie (même si elle affiche une erreur ou une page de l'outil SEO).",
  };
  const pastes = Object.keys(PASTE).filter((k) => s.platforms[k]?.paste && s.platforms[k]?.configured && !s.platforms[k]?.connected);
  const setup = $('#setup');
  if (tips.length || pastes.length) {
    setup.hidden = false;
    setup.innerHTML = `<h2>Configuration</h2>${tips.length ? `<ul>${tips.map((t) => `<li>${t}</li>`).join('')}</ul>` : ''}
      ${pastes.map((k) => `<div style="margin-top:10px">${esc(PASTE[k])}
        <div class="row"><input id="code-${k}" placeholder="https://…?code=…"><button class="btn" data-paste="${k}">Valider</button></div></div>`).join('')}`;
    setup.querySelectorAll('[data-paste]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const k = btn.dataset.paste;
        try {
          await api(`/auth/${k}/code`, { method: 'POST', body: { value: $(`#code-${k}`).value } });
          alertMsg(`${PLAT[k]} connecté.`, 'ok', 4000);
          await loadStatus();
          await loadOrders();
        } catch (e) {
          alertMsg(esc(e.message));
        }
      }),
    );
  } else {
    setup.hidden = true;
  }
}

// ---------------- Commandes ----------------

function defaultParcel(o) {
  return {
    preset: '',
    length: '', width: '', height: '', weight: '',
    contents: o.items.map((i) => (i.qty > 1 ? `${i.qty}x ` : '') + i.title).join('; ').slice(0, 100),
    value: o.goodsValue || '',
    currency: o.currency || 'EUR',
    hsCode: state.status?.defaultHsCode || '',
  };
}

async function loadOrders() {
  $('#refreshBtn').disabled = true;
  $('#orders').innerHTML = '<p class="muted pad">Récupération des commandes…</p>';
  try {
    const { orders, errors } = await api('/api/orders');
    for (const e of errors) alertMsg(`<strong>${esc(PLAT[e.platform])}</strong> : ${esc(e.message)}`);
    const prev = new Map(state.orders.map((o) => [o.key, o]));
    state.orders = orders.map((o) => {
      const old = prev.get(o.key);
      return {
        ...o,
        address: old?.address || { ...o.address, ...(o.draft?.address || {}) },
        parcel: old?.parcel || { ...defaultParcel(o), ...(o.draft?.parcel || {}) },
      };
    });
    const keys = new Set(state.orders.map((o) => o.key));
    state.sel = new Set([...state.sel].filter((k) => keys.has(k)));
    render();
  } catch (e) {
    $('#orders').innerHTML = `<p class="error pad">${esc(e.message)}</p>`;
  } finally {
    $('#refreshBtn').disabled = false;
  }
}

const byKey = (k) => state.orders.find((o) => o.key === k);
const visible = () => state.orders.filter((o) => !($('#hideShipped').checked && o.shipment && !state.sessionShipped.includes(o.key)));

function field(key, name, label, value, attrs = '', cls = '') {
  return `<label class="f ${cls}"><span>${label}</span><input data-k="${esc(key)}" data-p="${name}" value="${esc(value)}" ${attrs}></label>`;
}

function cardHtml(o) {
  const p = o.parcel;
  const a = o.address;
  const presets = state.status?.presets || [];
  const done = Boolean(o.shipment);
  const items = o.items.map((i) => `${i.qty > 1 ? `${i.qty}× ` : ''}${esc(i.title)}`).join(' · ');
  const addrLine = [a.name, a.line1, a.line2, `${a.postalCode} ${a.city}`, a.state, a.country].filter((x) => String(x).trim()).map(esc).join(', ');
  const addrOpen = state.openAddr.has(o.key);
  const af = (n, l, cls = '') => `<label class="f ${cls}"><span>${l}</span><input data-k="${esc(o.key)}" data-a="${n}" value="${esc(a[n])}"></label>`;

  return `<article class="card ${state.sel.has(o.key) ? 'sel' : ''} ${done ? 'done' : ''}" data-card="${esc(o.key)}">
    <div class="c-head">
      <input type="checkbox" class="sel" data-k="${esc(o.key)}" ${state.sel.has(o.key) ? 'checked' : ''} ${done ? 'disabled' : ''} aria-label="Sélectionner">
      <span class="plat ${o.platform}">${PLAT[o.platform]}</span>
      <span class="ref">${esc(o.ref)}</span>
      <span class="muted">${fdate(o.date)} · ${esc(o.buyer)}</span>
      <span class="zone ${o.customs ? 'customs' : ''}">${esc(a.country)} · ${ZONE[o.zone]}${o.customs ? ' · douane' : ''}</span>
      <span class="val">${fmt(o.goodsValue, o.currency)}</span>
    </div>
    <div class="items">${items}</div>
    <div class="addr"><span>${addrLine}</span>${a.phone ? `<span class="muted">☎ ${esc(a.phone)}</span>` : ''}
      ${done ? '' : `<button class="linkbtn" data-toggle-addr="${esc(o.key)}">${addrOpen ? 'fermer' : 'modifier l\'adresse'}</button>`}</div>
    ${addrOpen && !done ? `<div class="grid addr-edit">
      ${af('name', 'Nom')}${af('company', 'Société')}${af('line1', 'Adresse 1')}${af('line2', 'Adresse 2')}
      ${af('postalCode', 'Code postal')}${af('city', 'Ville')}${af('state', 'État / région')}${af('country', 'Pays (ISO)')}
      ${af('phone', 'Téléphone')}${af('email', 'E-mail')}</div>` : ''}
    ${done ? '' : `<div class="grid">
      <label class="f mid"><span>Format</span><select data-k="${esc(o.key)}" data-preset>
        <option value="">— sur mesure —</option>
        ${presets.map((pr, i) => `<option value="${i}" ${p.preset === String(i) ? 'selected' : ''}>${esc(pr.name)} (${pr.length}×${pr.width}×${pr.height}, ${pr.weight} kg)</option>`).join('')}
      </select></label>
      ${field(o.key, 'length', 'L (cm)', p.length, 'inputmode="decimal"')}
      ${field(o.key, 'width', 'l (cm)', p.width, 'inputmode="decimal"')}
      ${field(o.key, 'height', 'H (cm)', p.height, 'inputmode="decimal"')}
      ${field(o.key, 'weight', 'Poids (kg)', p.weight, 'inputmode="decimal"')}
      ${field(o.key, 'contents', o.customs ? 'Contenu (en anglais pour la douane)' : 'Contenu', p.contents, 'maxlength="100"', 'wide')}
      ${field(o.key, 'value', 'Valeur déclarée', p.value, 'inputmode="decimal"')}
      <label class="f"><span>Devise</span><select data-k="${esc(o.key)}" data-p="currency">
        ${['EUR', 'USD', 'GBP', 'CAD', 'CHF', 'AUD'].map((c) => `<option ${p.currency === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select></label>
      ${o.customs ? field(o.key, 'hsCode', 'Code SH', p.hsCode, 'inputmode="numeric"') : ''}
    </div>`}
    <div class="result" data-result="${esc(o.key)}">${resultHtml(o)}</div>
  </article>`;
}

function resultHtml(o) {
  if (o.shipment) {
    const s = o.shipment;
    return `<div class="shipped">
      <span class="tag">Bordereau créé</span>
      <span>${esc(s.serviceName)} · ${fmt(s.total, s.currency)}</span>
      <span class="trk">${s.tracking.map(esc).join(', ')}</span>
      ${s.labels.map((l) => `<a href="${esc(l.url)}" target="_blank">Étiquette</a>`).join(' ')}
      ${s.invoiceUrl ? `<a href="${esc(s.invoiceUrl)}" target="_blank">Facture commerciale</a>` : ''}
      <button class="btn small danger" data-void="${esc(o.key)}">Annuler l'étiquette</button>
    </div>`;
  }
  const err = state.errors[o.key];
  const r = state.rates[o.key];
  if (!r) return err ? `<span class="error">${esc(err)}</span>` : '';
  if (r.error) return `<span class="error">${esc(r.error)}</span>`;
  const opts = r.rates
    .map((x) => `<option value="${esc(x.code)}" ${x.code === r.code ? 'selected' : ''}>${esc(x.name)} — ${fmt(x.total, x.currency)}${x.negotiated ? ' (négocié)' : ''}${x.days ? ` · ${x.days} j` : ''}</option>`)
    .join('');
  return `<select data-service="${esc(o.key)}" aria-label="Service UPS">${opts}</select>
    <span class="tag ${r.code !== r.defaultCode ? 'warn' : ''}">${r.code !== r.defaultCode ? 'Choix manuel' : esc(r.rule)}</span>
    ${r.warning ? `<span class="tag warn">${esc(r.warning)}</span>` : ''}
    ${err ? `<span class="error">${esc(err)}</span>` : ''}`;
}

function render() {
  const list = visible();
  $('#orders').innerHTML = list.length
    ? list.map(cardHtml).join('')
    : `<p class="muted pad">${state.orders.length ? 'Toutes les commandes affichées sont expédiées.' : 'Aucune commande à expédier.'}</p>`;
  const pending = state.orders.filter((o) => !o.shipment).length;
  $('#count').textContent = `${pending} à expédier · ${state.orders.length - pending} déjà expédiée(s)`;
  updateBar();
}

function renderResult(key) {
  const el = document.querySelector(`[data-result="${CSS.escape(key)}"]`);
  if (el) el.innerHTML = resultHtml(byKey(key));
}

function selectedPending() {
  return state.orders.filter((o) => state.sel.has(o.key) && !o.shipment);
}

function updateBar() {
  const sel = selectedPending();
  $('#selInfo').textContent = `${sel.length} sélectionnée${sel.length > 1 ? 's' : ''}`;
  const ready = sel.filter((o) => state.rates[o.key] && !state.rates[o.key].error);
  const sums = {};
  for (const o of ready) {
    const r = state.rates[o.key];
    const x = r.rates.find((y) => y.code === r.code);
    if (x) sums[x.currency] = (sums[x.currency] || 0) + x.total;
  }
  $('#totalInfo').textContent = ready.length
    ? `Estimation : ${Object.entries(sums).map(([c, v]) => fmt(v, c)).join(' + ')} (${ready.length} tarifée${ready.length > 1 ? 's' : ''})`
    : '';
  $('#ratesBtn').disabled = sel.length === 0;
  $('#shipBtn').disabled = ready.length === 0;
  $('#shipBtn').textContent = ready.length ? `Valider et générer (${ready.length})` : 'Valider et générer';
  const printable = printKeys();
  $('#printBtn').disabled = printable.length === 0;
  $('#printBtn').textContent = printable.length ? `Imprimer (${printable.length})` : 'Imprimer';
  $('#selectAll').checked = state.orders.some((o) => !o.shipment) && state.orders.filter((o) => !o.shipment).every((o) => state.sel.has(o.key));
}

function printKeys() {
  const selShipped = state.orders.filter((o) => state.sel.has(o.key) && o.shipment).map((o) => o.key);
  return selShipped.length ? selShipped : state.sessionShipped.filter((k) => byKey(k)?.shipment);
}

// ---------------- Saisie ----------------

const draftTimers = {};
function saveDraft(key) {
  clearTimeout(draftTimers[key]);
  draftTimers[key] = setTimeout(() => {
    const o = byKey(key);
    if (o) api(`/api/drafts/${encodeURIComponent(key)}`, { method: 'PUT', body: { parcel: o.parcel, address: o.address } }).catch(() => {});
  }, 600);
}

function touched(key) {
  if (!state.sel.has(key)) {
    state.sel.add(key);
    const card = document.querySelector(`[data-card="${CSS.escape(key)}"]`);
    card?.classList.add('sel');
    const cb = card?.querySelector('input.sel');
    if (cb) cb.checked = true;
  }
  if (state.rates[key]) {
    delete state.rates[key]; // les données ont changé : le tarif n'est plus valable
    renderResult(key);
  }
  delete state.errors[key];
  saveDraft(key);
  updateBar();
}

const NUM = new Set(['length', 'width', 'height', 'weight', 'value']);

$('#orders').addEventListener('input', (e) => {
  const t = e.target;
  const key = t.dataset.k;
  const o = key && byKey(key);
  if (!o) return;
  if (t.dataset.p) {
    let v = t.value;
    if (NUM.has(t.dataset.p)) v = v.replace(',', '.');
    o.parcel[t.dataset.p] = v;
    if (['length', 'width', 'height', 'weight'].includes(t.dataset.p)) {
      o.parcel.preset = '';
      const sel = t.closest('.card').querySelector('[data-preset]');
      if (sel) sel.value = '';
    }
    t.classList.remove('bad');
    touched(key);
  } else if (t.dataset.a) {
    o.address[t.dataset.a] = t.dataset.a === 'country' ? t.value.toUpperCase() : t.value;
    touched(key);
  }
});

$('#orders').addEventListener('change', (e) => {
  const t = e.target;
  if (t.classList.contains('sel')) {
    t.checked ? state.sel.add(t.dataset.k) : state.sel.delete(t.dataset.k);
    t.closest('.card').classList.toggle('sel', t.checked);
    updateBar();
  } else if (t.dataset.preset !== undefined && t.dataset.k) {
    const o = byKey(t.dataset.k);
    const pr = state.status.presets[Number(t.value)];
    o.parcel.preset = t.value;
    if (pr) {
      Object.assign(o.parcel, { length: pr.length, width: pr.width, height: pr.height, weight: pr.weight });
      const card = t.closest('.card');
      for (const k of ['length', 'width', 'height', 'weight']) card.querySelector(`[data-p="${k}"]`).value = pr[k];
    }
    touched(o.key);
  } else if (t.dataset.service) {
    state.rates[t.dataset.service].code = t.value;
    renderResult(t.dataset.service);
    updateBar();
  }
});

$('#orders').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.dataset.toggleAddr) {
    const k = t.dataset.toggleAddr;
    state.openAddr.has(k) ? state.openAddr.delete(k) : state.openAddr.add(k);
    render();
  } else if (t.dataset.void) {
    const k = t.dataset.void;
    if (!confirm('Annuler cette étiquette auprès d\'UPS ?')) return;
    t.disabled = true;
    try {
      await api(`/api/void/${encodeURIComponent(k)}`, { method: 'POST' });
      const o = byKey(k);
      o.shipment = null;
      delete state.rates[k];
      state.sessionShipped = state.sessionShipped.filter((x) => x !== k);
      alertMsg(`Étiquette ${esc(o.ref)} annulée.`, 'ok', 4000);
      render();
    } catch (err) {
      t.disabled = false;
      alertMsg(esc(err.message));
    }
  }
});

$('#selectAll').addEventListener('change', (e) => {
  for (const o of state.orders) if (!o.shipment) e.target.checked ? state.sel.add(o.key) : state.sel.delete(o.key);
  render();
});
$('#hideShipped').addEventListener('change', render);
$('#refreshBtn').addEventListener('click', loadOrders);

// ---------------- Tarifs ----------------

function markMissing(o) {
  const card = document.querySelector(`[data-card="${CSS.escape(o.key)}"]`);
  let bad = false;
  for (const k of ['length', 'width', 'height', 'weight', 'value']) {
    const inp = card?.querySelector(`[data-p="${k}"]`);
    const ok = Number(o.parcel[k]) > 0;
    inp?.classList.toggle('bad', !ok);
    if (!ok) bad = true;
  }
  const c = card?.querySelector('[data-p="contents"]');
  const okC = String(o.parcel.contents || '').trim().length > 0;
  c?.classList.toggle('bad', !okC);
  return bad || !okC;
}

const payload = (o) => ({ key: o.key, platform: o.platform, ref: o.ref, address: o.address, parcel: o.parcel });

$('#ratesBtn').addEventListener('click', async () => {
  const sel = selectedPending();
  const ready = sel.filter((o) => !markMissing(o));
  if (ready.length < sel.length) alertMsg(`${sel.length - ready.length} commande(s) incomplète(s) : champs en rouge.`, 'err', 5000);
  if (!ready.length) return;
  const btn = $('#ratesBtn');
  btn.disabled = true;
  btn.textContent = 'Interrogation UPS…';
  try {
    const { results } = await api('/api/rates', { method: 'POST', body: { orders: ready.map(payload) } });
    for (const r of results) {
      state.rates[r.key] = { ...r, defaultCode: r.code };
      delete state.errors[r.key];
      renderResult(r.key);
    }
  } catch (e) {
    alertMsg(esc(e.message));
  } finally {
    btn.textContent = 'Obtenir les tarifs';
    updateBar();
  }
});

// ---------------- Validation et génération ----------------

$('#shipBtn').addEventListener('click', async () => {
  const ready = selectedPending().filter((o) => state.rates[o.key] && !state.rates[o.key].error);
  if (!ready.length) return;
  const btn = $('#shipBtn');
  btn.disabled = true;
  let previews;
  try {
    ({ results: previews } = await api('/api/preview', {
      method: 'POST',
      body: { items: ready.map((o) => ({ order: payload(o), serviceCode: state.rates[o.key].code })) },
    }));
  } catch (e) {
    alertMsg(esc(e.message));
    return;
  } finally {
    updateBar();
  }
  const sums = {};
  $('#confirmBody').innerHTML = previews.map((pv) => {
    const o = byKey(pv.key);
    const r = state.rates[pv.key];
    const x = r.rates.find((y) => y.code === r.code);
    sums[x.currency] = (sums[x.currency] || 0) + x.total;
    return previewHtml(o, pv, x);
  }).join('');
  $('#confirmTotal').textContent = Object.entries(sums).map(([c, v]) => fmt(v, c)).join(' + ');
  const s = state.status;
  $('#confirmWarn').textContent = s.mock
    ? 'Mode démo : aucune étiquette réelle ne sera créée.'
    : s.upsEnv === 'production'
      ? `${ready.length} étiquette(s) seront créées et facturées sur votre compte UPS.`
      : 'Environnement de test UPS : étiquettes non valables pour l\'envoi.';
  const blocked = previews.filter((p) => p.error).length;
  $('#confirmOk').disabled = blocked > 0;
  const dlg = $('#confirmDlg');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    await ship(ready);
  };
});

function previewHtml(o, pv, rate) {
  const head = `<div class="pv-head"><span class="plat ${o.platform}">${PLAT[o.platform]}</span> <strong>${esc(o.ref)}</strong>
    <span>${esc(rate.name)}</span><span class="pv-price">${fmt(rate.total, rate.currency)}</span></div>`;
  if (pv.error) return `<section class="pv">${head}<p class="error">${esc(pv.error)}</p></section>`;
  const t = pv.shipTo;
  const row = (k, v, cls = '') => `<tr class="${cls}"><th>${k}</th><td>${v || '<span class="muted">—</span>'}</td></tr>`;
  const c = pv.customs;
  const masked = JSON.stringify(pv.request, null, 2).replace(/("(?:ShipperNumber|AccountNumber)":\s*")(\w*)(\w{2})"/g, (m, a, b, d) => `${a}${'•'.repeat(b.length)}${d}"`);
  return `<section class="pv">${head}
    ${pv.warnings.length ? `<ul class="pv-warn">${pv.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <div class="pv-grid">
      <table><caption>Destinataire</caption>
        ${row('Nom', esc(t.name))}
        ${t.attention !== t.name ? row('À l\'attention de', esc(t.attention)) : ''}
        ${t.lines.map((l, i) => row(`Adresse ${i + 1}`, `<code>${esc(l)}</code>`)).join('')}
        ${row('Code postal / ville', esc(`${t.postalCode} ${t.city}`))}
        ${t.state ? row('État / région', esc(t.state)) : ''}
        ${row('Pays', esc(t.country))}
        ${row('Téléphone', esc(t.phone))}
        ${row('E-mail', esc(t.email))}
        ${row('Type', t.residential ? 'Particulier (adresse résidentielle)' : 'Entreprise')}
      </table>
      <table><caption>Envoi</caption>
        ${row('Expéditeur', `${esc(pv.shipper.name)} — ${pv.shipper.business ? 'entreprise' : 'particulier'}`)}
        ${row('Référence (n° de commande)', `<code>${esc(pv.reference)}</code>`)}
        ${row('Valeur déclarée (assurance)', pv.declaredValue ? esc(pv.declaredValue) : 'aucune')}
        ${row('Colis', esc(`${pv.package.dims} · ${pv.package.weight}`))}
        ${row('Description colis', esc(pv.package.description))}
      </table>
      ${c ? `<table><caption>Documents douaniers (facture commerciale)</caption>
        ${row('N° de facture', `<code>${esc(c.invoiceNumber)}</code>`)}
        ${row('Motif', c.reason === 'SALE' ? 'Vente (SALE)' : esc(c.reason))}
        ${row('Description marchandise', esc(c.description))}
        ${row('Code SH', c.hsCode ? esc(c.hsCode) : 'aucun')}
        ${row('Unité', c.unit === 'PKG' ? 'Colis (PKG)' : esc(c.unit))}
        ${row('Quantité', esc(c.quantity))}
        ${row('Valeur unitaire', fmt(c.unitValue, c.currency))}
        ${row('Valeur totale en douane', fmt(c.total, c.currency))}
        ${row('Pays d\'origine', esc(c.origin))}
        ${row('Droits et taxes payés par', esc(c.dutiesPaidBy))}
      </table>` : ''}
    </div>
    <details><summary>Requête exacte envoyée à UPS</summary><pre>${esc(masked)}</pre></details>
  </section>`;
}

async function ship(list) {
  const btn = $('#shipBtn');
  btn.disabled = true;
  btn.textContent = 'Création des bordereaux…';
  try {
    const { results } = await api('/api/ship', {
      method: 'POST',
      body: { items: list.map((o) => ({ order: payload(o), serviceCode: state.rates[o.key].code })) },
    });
    const okKeys = [];
    for (const r of results) {
      const o = byKey(r.key);
      if (!o) continue;
      if (r.shipment && !r.error) {
        o.shipment = r.shipment;
        okKeys.push(r.key);
        state.sel.delete(r.key);
      } else {
        state.errors[r.key] = r.error;
      }
    }
    state.sessionShipped = [...new Set([...state.sessionShipped, ...okKeys])];
    const fails = results.length - okKeys.length;
    if (okKeys.length) {
      alertMsg(`${okKeys.length} bordereau(x) créé(s). <a href="/print?keys=${encodeURIComponent(okKeys.join(','))}" target="_blank">Imprimer maintenant</a>`, 'ok');
    }
    if (fails) alertMsg(`${fails} échec(s) : voir le message sous chaque commande.`);
    render();
  } catch (e) {
    alertMsg(esc(e.message));
  } finally {
    btn.textContent = 'Valider et générer';
    updateBar();
  }
}

$('#printBtn').addEventListener('click', () => {
  const keys = printKeys();
  if (keys.length) window.open(`/print?keys=${encodeURIComponent(keys.join(','))}`, '_blank');
});

$('#quitBtn').addEventListener('click', async () => {
  if (!confirm("Arrêter l'application ?")) return;
  try {
    await api('/api/shutdown', { method: 'POST' });
  } catch {}
  document.body.innerHTML = '<p style="padding:40px;font:16px system-ui">Application arrêtée. Vous pouvez fermer cet onglet.</p>';
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
});

// ---------------- Démarrage ----------------

(async () => {
  const c = new URLSearchParams(location.search).get('connected');
  if (c) {
    alertMsg(`${PLAT[c] || c} connecté.`, 'ok', 4000);
    history.replaceState(null, '', '/');
  }
  try {
    await loadStatus();
    await loadOrders();
  } catch (e) {
    alertMsg(esc(e.message));
  }
})();
