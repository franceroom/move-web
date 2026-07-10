/**
 * MOVE (France Room) — Synchronisation iCal (lot 5 du cadrage dev).
 *
 * 1. EXPORT : GET /ical/:listingId.ics
 *    Flux iCalendar des reservations (pending + accepted) d'une annonce Move,
 *    a coller comme "calendrier externe" dans Airbnb / Booking / Abritel / etc.
 *
 * 2. IMPORT : GET /ical/sync?token=<ICAL_SYNC_TOKEN>
 *    Pour chaque annonce dont privateData.icalImportUrls (tableau ou chaine
 *    separee par des virgules) contient des URLs iCal externes :
 *    - telecharge chaque flux, extrait les periodes reservees (VEVENT),
 *    - cree des availability exceptions (seats 0) sur l'annonce,
 *    - supprime les exceptions creees precedemment qui ont disparu du flux
 *      (etat memorise dans privateData.icalSync — les exceptions posees a la
 *      main dans la Console ne sont jamais touchees).
 *    Un timer interne relance la sync toutes les ICAL_SYNC_INTERVAL_HOURS (3 h
 *    par defaut). NB offre Render Free : l'instance s'endort sans trafic, le
 *    timer ne tourne alors pas — prevoir un ping externe ou une instance payante
 *    pour le live.
 *
 * Variables d'environnement requises :
 *   INTEGRATION_CLIENT_ID / INTEGRATION_CLIENT_SECRET : application
 *     "Integration API" creee dans Console > Advanced > Applications.
 *   ICAL_SYNC_TOKEN : jeton secret protegeant le declencheur /ical/sync.
 *
 * Aucune dependance externe (fetch natif Node >= 18, parsing ICS minimal).
 */

const express = require('express');

// Integration API et auth OAuth2 vivent sur le host API principal
// (verifie le 10/07/2026 : flex-integration-api.sharetribe.com ne route plus l'API).
const INTEGRATION_BASE = 'https://flex-api.sharetribe.com';
const AUTH_BASE = 'https://flex-api.sharetribe.com';
const CLIENT_ID = process.env.INTEGRATION_CLIENT_ID;
const CLIENT_SECRET = process.env.INTEGRATION_CLIENT_SECRET;
const SYNC_TOKEN = process.env.ICAL_SYNC_TOKEN;
const SYNC_INTERVAL_HOURS = parseFloat(process.env.ICAL_SYNC_INTERVAL_HOURS || '3');
const HORIZON_DAYS = 364; // fenetre consideree (limite API ~366 jours)

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Client Integration API minimal (token en cache, JSON)
// ---------------------------------------------------------------------------

let cachedToken = null; // { value, expiresAt }

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
  const res = await fetch(`${AUTH_BASE}/v1/auth/token`, {
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
    throw new Error(`GET ${path}: HTTP ${res.status} ${await res.text()}`);
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

// ---------------------------------------------------------------------------
// Outils dates / ICS
// ---------------------------------------------------------------------------

const pad = n => String(n).padStart(2, '0');

const toIcsDate = d =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

const toIcsStamp = d =>
  `${toIcsDate(d)}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

// Ramene une Date au debut de son jour UTC.
const floorDay = d => new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);
// Fin de periode : si l'heure n'est pas 00:00 UTC, on arrondit au jour suivant.
const ceilDay = d => new Date(Math.ceil(d.getTime() / DAY_MS) * DAY_MS);

// Parse une valeur DTSTART / DTEND iCal (formes courantes).
const parseIcsDate = raw => {
  if (!raw) return null;
  const v = raw.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/); // VALUE=DATE
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/); // datetime (TZID traite comme UTC — arrondi au jour ensuite)
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return null;
};

// Extrait les periodes [start,end) d'un contenu ICS (jours UTC entiers).
const parseIcsEvents = icsText => {
  // Deplie les lignes (continuation = CRLF + espace/tab)
  const unfolded = icsText.replace(/\r?\n[ \t]/g, '');
  const events = [];
  const blocks = unfolded.split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const body = block.split('END:VEVENT')[0];
    const get = prop => {
      const mm = body.match(new RegExp(`^${prop}[^:\\r\\n]*:([^\\r\\n]+)`, 'm'));
      return mm ? mm[1] : null;
    };
    const start = parseIcsDate(get('DTSTART'));
    let end = parseIcsDate(get('DTEND'));
    if (!start) continue;
    if (!end) end = new Date(start.getTime() + DAY_MS);
    const s = floorDay(start);
    const e = ceilDay(end);
    if (e > s) events.push({ start: s, end: e });
  }
  return events;
};

// ---------------------------------------------------------------------------
// EXPORT — GET /ical/:listingId.ics
// ---------------------------------------------------------------------------

const exportHandler = async (req, res) => {
  try {
    const listingId = req.params.listingId.replace(/\.ics$/, '');
    if (!/^[0-9a-f-]{36}$/i.test(listingId)) {
      return res.status(400).send('Invalid listing id');
    }
    const now = new Date();
    const horizon = new Date(now.getTime() + HORIZON_DAYS * DAY_MS);
    // On remonte 60 jours en arriere pour couvrir les sejours en cours.
    const start = new Date(now.getTime() - 60 * DAY_MS);

    const json = await apiGet('/bookings/query', {
      listingId,
      start: start.toISOString(),
      end: horizon.toISOString(),
      states: 'pending,proposed,accepted',
      perPage: 100,
    });
    const bookings = (json.data || []).filter(b =>
      ['pending', 'proposed', 'accepted'].includes(b.attributes.state)
    );

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Move by France Room//iCal export//FR',
      'CALSCALE:GREGORIAN',
    ];
    for (const b of bookings) {
      const bStart = new Date(b.attributes.start);
      const bEnd = new Date(b.attributes.end);
      lines.push(
        'BEGIN:VEVENT',
        `UID:${b.id.uuid || b.id}@move.immo`,
        `DTSTAMP:${toIcsStamp(now)}`,
        `DTSTART;VALUE=DATE:${toIcsDate(floorDay(bStart))}`,
        `DTEND;VALUE=DATE:${toIcsDate(ceilDay(bEnd))}`,
        'SUMMARY:Reserve (Move by France Room)',
        'END:VEVENT'
      );
    }
    lines.push('END:VCALENDAR');

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `inline; filename="move-${listingId}.ics"`);
    res.send(lines.join('\r\n') + '\r\n');
  } catch (e) {
    console.error('[ical export]', e.message);
    res.status(500).send('iCal export error');
  }
};

// ---------------------------------------------------------------------------
// IMPORT / SYNC — GET /ical/sync?token=...
// ---------------------------------------------------------------------------

const eventKey = ev => `${ev.start.toISOString()}_${ev.end.toISOString()}`;

const syncListing = async listing => {
  const id = listing.id.uuid || listing.id;
  const priv = listing.attributes.privateData || {};
  let urls = priv.icalImportUrls;
  if (typeof urls === 'string') urls = urls.split(',').map(u => u.trim());
  urls = (urls || []).filter(u => /^https?:\/\//.test(u));
  if (!urls.length) return null;

  const report = { listingId: id, urls: urls.length, created: 0, deleted: 0, skipped: 0, errors: [] };
  const now = new Date();
  const horizon = new Date(now.getTime() + HORIZON_DAYS * DAY_MS);

  // 1. Evenements desires (futurs, dans l'horizon)
  const desired = new Map();
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Move-iCal-Sync/1.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      for (const ev of parseIcsEvents(await r.text())) {
        if (ev.end <= now || ev.start >= horizon) continue;
        desired.set(eventKey(ev), ev);
      }
    } catch (e) {
      report.errors.push(`fetch ${url}: ${e.message}`);
    }
  }

  const prev = (priv.icalSync && priv.icalSync.exceptions) || {};
  const next = {};

  // 2. Supprime les exceptions creees par la sync et disparues du flux
  for (const [key, excId] of Object.entries(prev)) {
    if (desired.has(key)) {
      next[key] = excId;
    } else {
      try {
        await apiPost('/availability_exceptions/delete', { id: excId });
        report.deleted++;
      } catch (e) {
        if (e.status === 404 || e.status === 409) report.skipped++;
        else report.errors.push(`delete ${key}: ${e.message}`);
      }
    }
  }

  // 3. Cree les nouvelles exceptions
  for (const [key, ev] of desired.entries()) {
    if (next[key]) continue;
    try {
      const created = await apiPost('/availability_exceptions/create', {
        listingId: id,
        start: ev.start.toISOString(),
        end: ev.end.toISOString(),
        seats: 0,
      });
      const newId =
        created && created.data && created.data.id && (created.data.id.uuid || created.data.id);
      if (newId) next[key] = newId;
      report.created++;
    } catch (e) {
      // 409 = chevauchement (deja bloque par une resa ou une exception manuelle)
      if (e.status === 409) report.skipped++;
      else report.errors.push(`create ${key}: ${e.message}`);
    }
  }

  // 4. Memorise l'etat
  try {
    await apiPost('/listings/update', {
      id,
      privateData: { icalSync: { exceptions: next, updatedAt: now.toISOString() } },
    });
  } catch (e) {
    report.errors.push(`update privateData: ${e.message}`);
  }
  return report;
};

const runSync = async () => {
  const out = { startedAt: new Date().toISOString(), listings: [] };
  let page = 1;
  let listings = [];
  // Recupere toutes les annonces (parc modeste — pagination simple)
  for (;;) {
    const json = await apiGet('/listings/query', { perPage: 100, page });
    listings = listings.concat(json.data || []);
    const totalPages = json.meta && json.meta.totalPages;
    if (!totalPages || page >= totalPages) break;
    page++;
  }
  for (const listing of listings) {
    const r = await syncListing(listing);
    if (r) out.listings.push(r);
  }
  out.finishedAt = new Date().toISOString();
  return out;
};

const syncHandler = async (req, res) => {
  if (!SYNC_TOKEN || req.query.token !== SYNC_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    res.json(await runSync());
  } catch (e) {
    console.error('[ical sync]', e.message);
    res.status(500).json({ error: e.message });
  }
};

// ---------------------------------------------------------------------------
// Router + timer interne
// ---------------------------------------------------------------------------

const router = express.Router();

if (CLIENT_ID && CLIENT_SECRET) {
  router.get('/sync', syncHandler);
  router.get('/:listingId', exportHandler);

  if (SYNC_INTERVAL_HOURS > 0) {
    setInterval(() => {
      runSync()
        .then(r => {
          const n = r.listings.length;
          console.log(`[ical sync] auto: ${n} annonce(s) synchronisee(s)`);
        })
        .catch(e => console.error('[ical sync] auto:', e.message));
    }, SYNC_INTERVAL_HOURS * 60 * 60 * 1000);
  }
} else {
  router.use((req, res) =>
    res.status(503).json({ error: 'INTEGRATION_CLIENT_ID/SECRET non configures' })
  );
}

module.exports = router;
