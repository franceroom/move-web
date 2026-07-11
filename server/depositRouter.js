/**
 * MOVE (France Room) — Dépôt de garantie / caution (lot 8 du cadrage dev).
 *
 * Remplace le process manuel (liens Stripe fixes 200/300/500 €, vérification et
 * remboursement à la main) par un circuit automatisé sur le compte Stripe
 * cautions dédié (compte séparé du flux marketplace Sharetribe) :
 *
 * 1. PAIEMENT : GET /deposit/pay/:txId
 *    Redirige le locataire vers une session Stripe Checkout dont le montant
 *    vient de l'annonce (publicData.depot_garantie, en euros). Lien affiché
 *    sur la page de transaction (bandeau côté locataire).
 *
 * 2. WEBHOOK : POST /deposit/webhook  (checkout.session.completed)
 *    Vérifie la signature Stripe, puis écrit l'état sur la transaction
 *    Sharetribe (metadata.deposit) via l'Integration API :
 *    { status: 'paye', amount, paymentIntentId, paidAt, refundDueAt }.
 *    refundDueAt = fin de réservation + DEPOSIT_REFUND_DELAY_DAYS (2 j).
 *
 * 3. REMBOURSEMENT AUTO : timer interne (+ déclencheur manuel
 *    GET /deposit/refund-run?token=<ICAL_SYNC_TOKEN>).
 *    Parcourt les transactions dont metadata.deposit.status === 'paye' et
 *    refundDueAt dépassé, crée le refund Stripe (payment_intent) et passe le
 *    statut à 'rembourse'. Un statut 'litige' (posé à la main par France Room
 *    dans la Console) bloque le remboursement automatique.
 *    NB : refund carte fiable ~6 mois → au-delà, statut 'erreur_remboursement'
 *    et traitement manuel (virement).
 *
 * 4. STATUT : GET /deposit/status/:txId → metadata.deposit (recette/support).
 *
 * SÉCURITÉ CLÉS (règle projet) :
 *   - Par défaut : mode TEST. La clé utilisée est DEPOSIT_STRIPE_TEST_KEY et
 *     toute clé "live" est REFUSÉE tant que DEPOSIT_LIVE n'est pas 'true'.
 *   - DEPOSIT_LIVE='true' (posé par Elhadji après validation) : utilise
 *     DEPOSIT_STRIPE_KEY (clé restreinte live, collée par Elhadji dans Render).
 *   - Les clés ne transitent jamais par l'agent ni par le code.
 *
 * Variables d'environnement :
 *   DEPOSIT_STRIPE_TEST_KEY  clé restreinte du compte Stripe "MOVE Test" (rk_test_/sk_test_)
 *   DEPOSIT_STRIPE_KEY       clé restreinte LIVE (compte cautions) — ignorée hors DEPOSIT_LIVE
 *   DEPOSIT_LIVE             'true' pour activer le live (défaut : test)
 *   DEPOSIT_WEBHOOK_SECRET   signing secret du webhook Stripe (whsec_...)
 *   DEPOSIT_REFUND_DELAY_DAYS    délai de remboursement après départ (défaut 2)
 *   DEPOSIT_REFUND_CHECK_HOURS   fréquence du timer (défaut 6 ; 0 = désactivé)
 *   INTEGRATION_CLIENT_ID / INTEGRATION_CLIENT_SECRET  (déjà posés pour l'iCal)
 *   ICAL_SYNC_TOKEN          réutilisé comme jeton du déclencheur manuel
 *   REACT_APP_MARKETPLACE_ROOT_URL  base des URLs de retour
 *
 * Aucune dépendance externe (fetch natif Node >= 18, crypto standard).
 */

const express = require('express');
const crypto = require('crypto');

const INTEGRATION_BASE = 'https://flex-api.sharetribe.com';
const CLIENT_ID = process.env.INTEGRATION_CLIENT_ID;
const CLIENT_SECRET = process.env.INTEGRATION_CLIENT_SECRET;
const ADMIN_TOKEN = process.env.ICAL_SYNC_TOKEN;
const ROOT_URL = (process.env.REACT_APP_MARKETPLACE_ROOT_URL || '').replace(/\/$/, '');
const WEBHOOK_SECRET = process.env.DEPOSIT_WEBHOOK_SECRET;
const REFUND_DELAY_DAYS = parseFloat(process.env.DEPOSIT_REFUND_DELAY_DAYS || '2');
const REFUND_CHECK_HOURS = parseFloat(process.env.DEPOSIT_REFUND_CHECK_HOURS || '6');

const DAY_MS = 24 * 60 * 60 * 1000;

// --------------------------------------------------------------------------
// Choix de la clé Stripe — garde-fou test/live
// --------------------------------------------------------------------------

const DEPOSIT_LIVE = process.env.DEPOSIT_LIVE === 'true';
const isTestKey = k => /^(sk|rk)_test_/.test(k || '');
const rawKey = DEPOSIT_LIVE
  ? process.env.DEPOSIT_STRIPE_KEY
  : process.env.DEPOSIT_STRIPE_TEST_KEY;
// Hors mode live explicite, on refuse toute clé non-test (protection contre
// un collage accidentel de la clé live dans la variable de test).
const STRIPE_KEY = !DEPOSIT_LIVE && rawKey && !isTestKey(rawKey) ? null : rawKey;
const keyProblem = !rawKey
  ? DEPOSIT_LIVE
    ? 'DEPOSIT_STRIPE_KEY manquante (mode live)'
    : 'DEPOSIT_STRIPE_TEST_KEY manquante (mode test par défaut)'
  : !STRIPE_KEY
  ? 'Clé non-test détectée alors que DEPOSIT_LIVE n\'est pas "true" — refusée'
  : null;

// --------------------------------------------------------------------------
// Client Stripe minimal (form-encoded, fetch natif)
// --------------------------------------------------------------------------

const stripeCall = async (path, params, method = 'POST') => {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  if (method === 'POST') opts.body = new URLSearchParams(params).toString();
  const url =
    method === 'GET' && params
      ? `https://api.stripe.com${path}?${new URLSearchParams(params)}`
      : `https://api.stripe.com${path}`;
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!res.ok) {
    const msg = (json.error && json.error.message) || `HTTP ${res.status}`;
    const err = new Error(`Stripe ${path}: ${msg}`);
    err.status = res.status;
    err.stripeCode = json.error && json.error.code;
    throw err;
  }
  return json;
};

// --------------------------------------------------------------------------
// Client Integration API minimal (même logique que icalRouter)
// --------------------------------------------------------------------------

let cachedToken = null;

const getToken = async () => {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60 * 1000) {
    return cachedToken.value;
  }
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'integ',
  });
  const res = await fetch(`${INTEGRATION_BASE}/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`Auth Integration API: HTTP ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
  };
  return cachedToken.value;
};

const apiGet = async (path, params) => {
  const token = await getToken();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${INTEGRATION_BASE}/v1/integration_api${path}?${qs}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const err = new Error(`GET ${path}: HTTP ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
};

const apiPost = async (path, bodyObj) => {
  const token = await getToken();
  const res = await fetch(`${INTEGRATION_BASE}/v1/integration_api${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(bodyObj),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`POST ${path}: HTTP ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
};

// --------------------------------------------------------------------------
// Outils transaction
// --------------------------------------------------------------------------

const uuidRe = /^[0-9a-f-]{36}$/i;

// Récupère transaction + listing + booking (via included).
const fetchTx = async txId => {
  const json = await apiGet('/transactions/show', { id: txId, include: 'listing,booking' });
  const tx = json.data;
  const included = json.included || [];
  const listing = included.find(i => i.type === 'listing');
  const booking = included.find(i => i.type === 'booking');
  return { tx, listing, booking };
};

const getDepositAmount = listing => {
  const v = Number.parseFloat(listing?.attributes?.publicData?.depot_garantie);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
};

// Écrit metadata.deposit (merge au niveau de la clé "deposit").
const setDepositMetadata = (txId, deposit) =>
  apiPost('/transactions/update_metadata', { id: txId, metadata: { deposit } });

const orderPageUrl = txId => `${ROOT_URL}/order/${txId}`;

// --------------------------------------------------------------------------
// 1. PAIEMENT — GET /deposit/pay/:txId
// --------------------------------------------------------------------------

const payHandler = async (req, res) => {
  try {
    const txId = req.params.txId;
    if (!uuidRe.test(txId)) return res.status(400).send('Identifiant de transaction invalide');

    const { tx, listing, booking } = await fetchTx(txId);
    const amount = getDepositAmount(listing);
    if (!amount) {
      return res.status(404).send('Aucun dépôt de garantie n\'est prévu pour cette annonce.');
    }
    const current = tx.attributes.metadata && tx.attributes.metadata.deposit;
    if (current && ['paye', 'rembourse'].includes(current.status)) {
      return res.redirect(303, `${orderPageUrl(txId)}?caution=deja-payee`);
    }

    const title = (listing.attributes && listing.attributes.title) || 'logement Move';
    const bookingEnd = booking && booking.attributes && booking.attributes.end;

    const session = await stripeCall('/v1/checkout/sessions', {
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'eur',
      'line_items[0][price_data][unit_amount]': String(amount * 100),
      'line_items[0][price_data][product_data][name]': `Dépôt de garantie — ${title}`,
      'line_items[0][price_data][product_data][description]':
        'Caution remboursée automatiquement après votre départ (hors litige).',
      'metadata[txId]': txId,
      'metadata[bookingEnd]': bookingEnd || '',
      'payment_intent_data[metadata][txId]': txId,
      'payment_intent_data[description]': `Caution Move — transaction ${txId}`,
      success_url: `${orderPageUrl(txId)}?caution=ok`,
      cancel_url: `${orderPageUrl(txId)}?caution=annulee`,
    });
    return res.redirect(303, session.url);
  } catch (e) {
    console.error('[deposit pay]', e.message);
    return res.status(500).send('Erreur lors de la création du paiement de la caution.');
  }
};

// --------------------------------------------------------------------------
// 2. WEBHOOK — POST /deposit/webhook
// --------------------------------------------------------------------------

// Vérification de signature Stripe (header Stripe-Signature: t=...,v1=...).
const verifyStripeSignature = (rawBody, header, secret, toleranceSec = 600) => {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(',').map(kv => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1)];
    })
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  } catch (_) {
    return false;
  }
};

const webhookHandler = async (req, res) => {
  const rawBody = req.body; // Buffer (express.raw)
  const sig = req.headers['stripe-signature'];
  if (!verifyStripeSignature(rawBody, sig, WEBHOOK_SECRET)) {
    console.error('[deposit webhook] signature invalide');
    return res.status(400).send('Invalid signature');
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (_) {
    return res.status(400).send('Invalid JSON');
  }
  // Réponse rapide à Stripe, traitement ensuite.
  res.json({ received: true });

  if (event.type !== 'checkout.session.completed') return;
  const session = event.data && event.data.object;
  const txId = session && session.metadata && session.metadata.txId;
  if (!txId || !uuidRe.test(txId)) {
    console.error('[deposit webhook] txId manquant dans la session', session && session.id);
    return;
  }
  try {
    // refundDueAt = fin de réservation + délai (fallback : +60 j si pas de booking).
    let refundDueAt = new Date(Date.now() + 60 * DAY_MS);
    try {
      const { booking } = await fetchTx(txId);
      if (booking && booking.attributes && booking.attributes.end) {
        refundDueAt = new Date(
          new Date(booking.attributes.end).getTime() + REFUND_DELAY_DAYS * DAY_MS
        );
      }
    } catch (e) {
      console.error('[deposit webhook] booking introuvable:', e.message);
    }
    await setDepositMetadata(txId, {
      status: 'paye',
      amount: (session.amount_total || 0) / 100,
      currency: (session.currency || 'eur').toUpperCase(),
      sessionId: session.id,
      paymentIntentId: session.payment_intent,
      paidAt: new Date().toISOString(),
      refundDueAt: refundDueAt.toISOString(),
      live: DEPOSIT_LIVE,
    });
    console.log(`[deposit webhook] caution reçue pour tx ${txId}`);
  } catch (e) {
    console.error('[deposit webhook] échec écriture metadata:', e.message);
  }
};

// --------------------------------------------------------------------------
// 3. REMBOURSEMENT AUTO
// --------------------------------------------------------------------------

const runRefunds = async () => {
  const out = { startedAt: new Date().toISOString(), refunded: [], skipped: 0, errors: [] };
  const now = new Date();
  let page = 1;
  for (;;) {
    const json = await apiGet('/transactions/query', { perPage: 100, page });
    for (const tx of json.data || []) {
      const txId = tx.id.uuid || tx.id;
      const dep = tx.attributes.metadata && tx.attributes.metadata.deposit;
      if (!dep || dep.status !== 'paye') continue;
      if (dep.live !== DEPOSIT_LIVE) {
        // Ne jamais rembourser avec la mauvaise clé (caution test vs live).
        out.skipped++;
        continue;
      }
      if (!dep.refundDueAt || new Date(dep.refundDueAt) > now) {
        out.skipped++;
        continue;
      }
      try {
        const refund = await stripeCall('/v1/refunds', {
          payment_intent: dep.paymentIntentId,
          'metadata[txId]': txId,
        });
        await setDepositMetadata(txId, {
          ...dep,
          status: 'rembourse',
          refundId: refund.id,
          refundedAt: new Date().toISOString(),
        });
        out.refunded.push(txId);
      } catch (e) {
        out.errors.push(`${txId}: ${e.message}`);
        try {
          await setDepositMetadata(txId, {
            ...dep,
            status: 'erreur_remboursement',
            refundError: e.message,
            refundErrorAt: new Date().toISOString(),
          });
        } catch (e2) {
          out.errors.push(`${txId} (metadata): ${e2.message}`);
        }
      }
    }
    const totalPages = json.meta && json.meta.totalPages;
    if (!totalPages || page >= totalPages || page >= 20) break;
    page++;
  }
  out.finishedAt = new Date().toISOString();
  return out;
};

const refundRunHandler = async (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    res.json(await runRefunds());
  } catch (e) {
    console.error('[deposit refund-run]', e.message);
    res.status(500).json({ error: e.message });
  }
};

// --------------------------------------------------------------------------
// 4. STATUT — GET /deposit/status/:txId
// --------------------------------------------------------------------------

const statusHandler = async (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const txId = req.params.txId;
    if (!uuidRe.test(txId)) return res.status(400).json({ error: 'Invalid id' });
    const { tx, listing } = await fetchTx(txId);
    res.json({
      txId,
      depositAmountFromListing: getDepositAmount(listing),
      deposit: (tx.attributes.metadata && tx.attributes.metadata.deposit) || null,
      mode: DEPOSIT_LIVE ? 'live' : 'test',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// --------------------------------------------------------------------------
// Router + timer
// --------------------------------------------------------------------------

const router = express.Router();

if (!CLIENT_ID || !CLIENT_SECRET) {
  router.use((req, res) =>
    res.status(503).json({ error: 'INTEGRATION_CLIENT_ID/SECRET non configurés' })
  );
} else if (keyProblem) {
  router.use((req, res) => res.status(503).json({ error: `Caution non configurée : ${keyProblem}` }));
} else {
  // Le webhook a besoin du corps BRUT pour la vérification de signature.
  router.post('/webhook', express.raw({ type: '*/*' }), webhookHandler);
  router.get('/pay/:txId', payHandler);
  router.get('/refund-run', refundRunHandler);
  router.get('/status/:txId', statusHandler);

  console.log(`[deposit] module caution actif — mode ${DEPOSIT_LIVE ? 'LIVE' : 'TEST'}`);

  if (REFUND_CHECK_HOURS > 0) {
    setInterval(() => {
      runRefunds()
        .then(r => {
          if (r.refunded.length || r.errors.length) {
            console.log(
              `[deposit] auto-refund: ${r.refunded.length} remboursée(s), ${r.errors.length} erreur(s)`
            );
          }
        })
        .catch(e => console.error('[deposit] auto-refund:', e.message));
    }, REFUND_CHECK_HOURS * 60 * 60 * 1000);
  }
}

module.exports = router;
