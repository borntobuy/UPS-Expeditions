// Client API UPS (OAuth client credentials, Rating "Shop", Shipping, Void)
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { needsCustoms, normalizeState, serviceName } from './zones.js';

const base = () =>
  config.ups.env === 'production' ? 'https://onlinetools.ups.com' : 'https://wwwcie.ups.com';

export const upsConfigured = () =>
  Boolean(config.ups.clientId && config.ups.clientSecret && config.ups.account);

let cachedToken = null;

async function token() {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.value;
  const basic = Buffer.from(`${config.ups.clientId}:${config.ups.clientSecret}`).toString('base64');
  const r = await fetch(`${base()}/security/v1/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
      'x-merchant-id': config.ups.account,
    },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`UPS OAuth : ${upsError(j) || `HTTP ${r.status}`}`);
  cachedToken = { value: j.access_token, exp: Date.now() + Number(j.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function call(method, pathname, body, retried = false) {
  const r = await fetch(`${base()}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      'Content-Type': 'application/json',
      transId: randomUUID().replace(/-/g, ''),
      transactionSrc: 'ups-expeditions',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = upsError(j) || `UPS HTTP ${r.status}`;
    // 250002 : jeton refusé (ex. produits Rating/Shipping ajoutés à l'app après sa création) → on en redemande un
    if (!retried && /250002/.test(msg)) {
      cachedToken = null;
      return call(method, pathname, body, true);
    }
    throw new Error(
      /250002/.test(msg)
        ? `${msg} — vérifiez sur developer.ups.com que l'app a les produits Rating et Shipping et qu'elle est liée au compte ${config.ups.account}`
        : msg,
    );
  }
  return j;
}

function upsError(j) {
  const errs = j?.response?.errors;
  if (Array.isArray(errs) && errs.length) return errs.map((e) => `${e.code} : ${e.message}`).join(' | ');
  return j?.error_description || j?.message || null;
}

// ---------- Construction des blocs ----------

const cut = (s, n) => String(s ?? '').trim().slice(0, n);
const digits = (s) => String(s ?? '').replace(/[^\d+]/g, '').slice(0, 15);

/** Découpe les lignes d'adresse en 3 lignes de 35 caractères max (limite UPS) sans rien perdre si possible */
export function addressLines(a) {
  const out = [];
  for (const raw of [a.line1, a.line2]) {
    let rest = String(raw ?? '').replace(/\s+/g, ' ').trim();
    while (rest) {
      if (rest.length <= 35) { out.push(rest); break; }
      let i = rest.lastIndexOf(' ', 35);
      if (i < 10) i = 35;
      out.push(rest.slice(0, i).trim());
      rest = rest.slice(i).trim();
    }
  }
  return { lines: out.slice(0, 3), lost: out.slice(3).join(' ') };
}

function address(a) {
  const o = {
    AddressLine: addressLines(a).lines,
    City: cut(a.city, 30),
    PostalCode: cut(a.postalCode, 9),
    CountryCode: String(a.country).toUpperCase(),
  };
  const st = normalizeState(a.state, a.country);
  if (st) o.StateProvinceCode = cut(st, 5);
  return o;
}

function shipperParty(withNumber) {
  const s = config.shipper;
  const p = {
    Name: cut(s.company || s.name, 35),
    AttentionName: cut(s.name, 35),
    Phone: { Number: digits(s.phone) },
    Address: address(s),
  };
  if (s.email) p.EMailAddress = cut(s.email, 50);
  if (withNumber) p.ShipperNumber = config.ups.account;
  return p;
}

function shipToParty(o) {
  const a = o.address;
  const p = {
    Name: cut(a.company || a.name, 35),
    AttentionName: cut(a.name, 35),
    Phone: { Number: digits(a.phone || config.shipper.phone) },
    Address: { ...address(a), ResidentialAddressIndicator: '' },
  };
  if (a.email) p.EMailAddress = cut(a.email, 50);
  return p;
}

function dims(parcel) {
  const up = (n) => String(Math.max(1, Math.ceil(Number(n))));
  return {
    UnitOfMeasurement: { Code: 'CM' },
    Length: up(parcel.length),
    Width: up(parcel.width),
    Height: up(parcel.height),
  };
}
const weight = (parcel) => ({
  UnitOfMeasurement: { Code: 'KGS' },
  Weight: String(Math.max(0.1, Number(parcel.weight)).toFixed(1)),
});

const moneyVal = (v) => Number(v).toFixed(2);

// ---------- Tarifs ----------

export async function shopRates(o) {
  const p = o.parcel;
  const shipment = {
    Shipper: shipperParty(true),
    ShipFrom: shipperParty(false),
    ShipTo: shipToParty(o),
    Package: [{ PackagingType: { Code: '02' }, Dimensions: dims(p), PackageWeight: weight(p) }],
  };
  if (config.ups.negotiated) shipment.ShipmentRatingOptions = { NegotiatedRatesIndicator: 'Y' };
  if (needsCustoms(o.address.country, o.address.postalCode)) {
    shipment.InvoiceLineTotal = { CurrencyCode: p.currency, MonetaryValue: moneyVal(p.value) };
  }

  const j = await call('POST', `/api/rating/${config.ups.ratingVersion}/Shop`, {
    RateRequest: {
      Request: { TransactionReference: { CustomerContext: cut(o.key, 50) } },
      Shipment: shipment,
    },
  });

  return [].concat(j?.RateResponse?.RatedShipment || []).map((r) => {
    const neg = r.NegotiatedRateCharges?.TotalCharge;
    const pub = r.TotalCharges;
    const chosen = neg || pub;
    return {
      code: r.Service?.Code,
      name: serviceName(r.Service?.Code),
      total: Number(chosen?.MonetaryValue),
      currency: chosen?.CurrencyCode,
      negotiated: Boolean(neg),
      publishedTotal: Number(pub?.MonetaryValue),
      days: r.GuaranteedDelivery?.BusinessDaysInTransit || null,
    };
  });
}

// ---------- Création d'expédition ----------

function yyyymmdd(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function chunks(s, size, max) {
  const out = [];
  let rest = String(s || '').trim();
  while (rest && out.length < max) {
    out.push(rest.slice(0, size));
    rest = rest.slice(size).trim();
  }
  return out.length ? out : ['Merchandise'];
}

/** Requête ShipmentRequest exacte (utilisée par l'aperçu ET par la création) */
export function buildShipmentRequest(o, serviceCode) {
  const p = o.parcel;
  const customs = needsCustoms(o.address.country, o.address.postalCode);
  const charges = [{ Type: '01', BillShipper: { AccountNumber: config.ups.account } }];
  if (customs && config.ups.ddp) {
    charges.push({ Type: '02', BillShipper: { AccountNumber: config.ups.account } });
  }

  const shipment = {
    Description: cut(p.contents, 50),
    Shipper: shipperParty(true),
    ShipFrom: shipperParty(false),
    ShipTo: shipToParty(o),
    PaymentInformation: { ShipmentCharge: charges },
    Service: { Code: serviceCode },
    // n° de commande de la plateforme (référence niveau envoi : autorisée hors US→US / PR→PR)
    ReferenceNumber: [{ Value: cut(String(o.ref).replace(/^#/, ''), 35) }],
    // pas de DeclaredValue : aucune valeur déclarée (assurance) sur le colis
    Package: [
      {
        Description: cut(p.contents, 35),
        Packaging: { Code: '02' },
        Dimensions: dims(p),
        PackageWeight: weight(p),
      },
    ],
  };
  if (config.ups.negotiated) shipment.ShipmentRatingOptions = { NegotiatedRatesIndicator: 'Y' };

  if (customs) {
    const soldTo = shipToParty(o);
    delete soldTo.Address.ResidentialAddressIndicator;
    shipment.ShipmentServiceOptions = {
      InternationalForms: {
        FormType: '01', // facture commerciale
        InvoiceNumber: cut(String(o.ref).replace(/^#/, ''), 35), // n° de commande de la plateforme
        InvoiceDate: yyyymmdd(),
        ReasonForExport: 'GIFT',
        CurrencyCode: p.currency,
        Contacts: { SoldTo: soldTo },
        Product: [
          {
            Description: chunks(p.contents, 35, 3),
            // une seule ligne : 1 colis, valeur = valeur en douane saisie ; pas de détail par article
            Unit: {
              Number: '1',
              Value: moneyVal(p.value),
              UnitOfMeasurement: { Code: 'PKG' }, // PKG = Package (liste UPS)
            },
            ...(p.hsCode ? { CommodityCode: String(p.hsCode).replace(/\D/g, '') } : {}),
            OriginCountryCode: config.customs.origin,
          },
        ],
      },
    };
  }

  const fmt = config.ups.labelFormat;
  const labelSpec = { LabelImageFormat: { Code: fmt } };
  if (fmt === 'ZPL' || fmt === 'EPL' || fmt === 'SPL') labelSpec.LabelStockSize = { Height: '6', Width: '4' };

  return {
    ShipmentRequest: {
      Request: { RequestOption: 'validate', TransactionReference: { CustomerContext: cut(o.key, 50) } },
      Shipment: shipment,
      LabelSpecification: labelSpec,
    },
  };
}

/** Aperçu lisible de ce qui sera envoyé à UPS, avec les points à vérifier */
export function previewShipment(o, serviceCode) {
  const req = buildShipmentRequest(o, serviceCode);
  const sh = req.ShipmentRequest.Shipment;
  const f = sh.ShipmentServiceOptions?.InternationalForms;
  const prod = f?.Product?.[0];
  const warnings = [];
  const { lost } = addressLines(o.address);
  if (lost) warnings.push(`Adresse trop longue : « ${lost} » ne tient pas sur les 3 lignes UPS`);
  if (!sh.ShipTo.Phone?.Number) warnings.push('Pas de téléphone destinataire');
  if (f && !prod?.CommodityCode) warnings.push('Aucun code SH : risque de retard en douane');
  if (o.address.company) warnings.push(`Destinataire avec société : « ${o.address.company} »`);
  return {
    key: o.key,
    shipTo: {
      name: sh.ShipTo.Name,
      attention: sh.ShipTo.AttentionName,
      lines: sh.ShipTo.Address.AddressLine,
      city: sh.ShipTo.Address.City,
      postalCode: sh.ShipTo.Address.PostalCode,
      state: sh.ShipTo.Address.StateProvinceCode || '',
      country: sh.ShipTo.Address.CountryCode,
      phone: sh.ShipTo.Phone?.Number || '',
      email: sh.ShipTo.EMailAddress || '',
      residential: 'ResidentialAddressIndicator' in sh.ShipTo.Address,
    },
    shipper: { name: sh.Shipper.Name, business: Boolean(config.shipper.company) },
    reference: sh.ReferenceNumber?.[0]?.Value || '',
    declaredValue: sh.Package[0].PackageServiceOptions?.DeclaredValue ? 'oui' : '',
    package: {
      dims: `${sh.Package[0].Dimensions.Length} × ${sh.Package[0].Dimensions.Width} × ${sh.Package[0].Dimensions.Height} cm`,
      weight: `${sh.Package[0].PackageWeight.Weight} kg`,
      description: sh.Package[0].Description,
    },
    customs: f
      ? {
          invoiceNumber: f.InvoiceNumber,
          reason: f.ReasonForExport,
          currency: f.CurrencyCode,
          description: prod.Description.join(' '),
          hsCode: prod.CommodityCode || '',
          unit: prod.Unit.UnitOfMeasurement.Code,
          quantity: prod.Unit.Number,
          unitValue: prod.Unit.Value,
          total: (Number(prod.Unit.Value) * Number(prod.Unit.Number)).toFixed(2),
          origin: prod.OriginCountryCode,
          dutiesPaidBy: config.ups.ddp ? 'expéditeur (DDP)' : 'destinataire',
        }
      : null,
    warnings,
    request: req,
  };
}

export async function createShipment(o, serviceCode) {
  const fmt = config.ups.labelFormat;
  const j = await call('POST', `/api/shipments/${config.ups.shipVersion}/ship`, buildShipmentRequest(o, serviceCode));

  const res = j?.ShipmentResponse?.ShipmentResults;
  if (!res) throw new Error('Réponse UPS inattendue (pas de ShipmentResults)');
  const pkgs = [].concat(res.PackageResults || []);
  const charge = res.NegotiatedRateCharges?.TotalCharge || res.ShipmentCharges?.TotalCharges;
  return {
    shipmentId: res.ShipmentIdentificationNumber,
    labels: pkgs.map((pk) => ({
      tracking: pk.TrackingNumber,
      format: (pk.ShippingLabel?.ImageFormat?.Code || fmt).toUpperCase(),
      base64: pk.ShippingLabel?.GraphicImage,
    })),
    invoicePdfBase64: res.Form?.Image?.GraphicImage || null,
    total: Number(charge?.MonetaryValue),
    currency: charge?.CurrencyCode,
  };
}

export async function voidShipment(shipmentId) {
  const j = await call(
    'DELETE',
    `/api/shipments/${config.ups.shipVersion}/void/cancel/${encodeURIComponent(shipmentId)}`,
  );
  const status = j?.VoidShipmentResponse?.SummaryResult?.Status;
  return { ok: status?.Code === '1', message: status?.Description || 'Annulé' };
}
