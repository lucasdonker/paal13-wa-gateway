/**
 * Paal 13 — WhatsApp-gateway (Baileys).
 *
 * Een kleine HTTP-dienst die zich naar het sollicitatiesysteem gedraagt als WhatsReach:
 *   POST /send     X-API-Key, JSON {to, message, type:'text', from?}  →  {success, message_id | message}
 *   GET  /devices  X-API-Key                                          →  {success, devices:[{phone_number,status,device_name}]}
 * Daardoor verandert er in de PHP-code niets: in Instellingen › Kanalen zet je de Base URL op
 * deze dienst en de API-sleutel op API_SLEUTEL.
 *
 * Verder:
 *   GET  /koppelen  Beheerpagina (wachtwoord KOPPEL_WACHTWOORD): status, QR-code, koppelcode, ontkoppelen.
 *   GET  /status    Voor monitoring: 200 als WhatsApp verbonden is, anders 503. Geen gevoelige data.
 *   GET  /health    Leeft het proces? Altijd 200 (Docker-healthcheck).
 *
 * De sessie staat in DATA_DIR/auth. Die map moet blijven bestaan (TrueNAS-dataset), anders moet je
 * na elke herstart opnieuw koppelen.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';

// ── Instellingen (omgevingsvariabelen) ──────────────────────────────────────────────────────────
const CFG = {
  poort: Number(process.env.POORT || 3000),
  dataDir: process.env.DATA_DIR || '/data',
  apiSleutel: process.env.API_SLEUTEL || '',
  koppelWachtwoord: process.env.KOPPEL_WACHTWOORD || '',
  apparaatNaam: process.env.APPARAAT_NAAM || 'Paal 13 sollicitaties',
  minIntervalMs: Number(process.env.MIN_INTERVAL_MS || 2500),
  controleerNummer: (process.env.CONTROLEER_NUMMER || '1') !== '0',
  meldingWebhook: process.env.MELDING_WEBHOOK || '', // optioneel, bijv. https://ntfy.sh/<geheim-topic>
  logNiveau: process.env.LOG_NIVEAU || 'warn',
};

// Geen API_SLEUTEL opgegeven? Dan maakt de gateway er zelf één en bewaart die in DATA_DIR.
// Je leest hem af op de koppelpagina en plakt hem in het sollicitatiesysteem.
if (!CFG.apiSleutel) {
  const bestand = path.join(CFG.dataDir, 'api-sleutel.txt');
  try {
    CFG.apiSleutel = (await fs.readFile(bestand, 'utf8')).trim();
  } catch {
    CFG.apiSleutel = crypto.randomBytes(32).toString('base64url');
    await fs.mkdir(CFG.dataDir, { recursive: true });
    await fs.writeFile(bestand, CFG.apiSleutel + '\n', { mode: 0o600 });
    console.log('[start] nieuwe API-sleutel gemaakt; zie de koppelpagina.');
  }
  CFG.sleutelZelfGemaakt = true;
}
if (CFG.apiSleutel.length < 24) {
  console.error('API_SLEUTEL is te kort (minimaal 24 tekens). Gateway stopt.');
  process.exit(1);
}
if (!CFG.koppelWachtwoord) {
  console.warn('KOPPEL_WACHTWOORD is leeg: de koppelpagina /koppelen staat uit.');
}

const authDir = path.join(CFG.dataDir, 'auth');
const logger = pino({ level: CFG.logNiveau });

// ── Toestand ────────────────────────────────────────────────────────────────────────────────────
// status: opstarten | koppelen | verbonden | verbroken | uitgelogd | geblokkeerd
const T = {
  status: 'opstarten',
  qr: null,
  koppelcode: null,
  nummer: null, // eigen nummer, +316…
  sinds: new Date().toISOString(),
  laatsteFout: null,
  verstuurd: 0,
  mislukt: 0,
};

let sock = null;
let generatie = 0; // negeert events van een oud socket na een herstart
let herverbindPogingen = 0;
let herstartTimer = null;

function zetStatus(nieuw, fout = null) {
  if (T.status === nieuw && !fout) return;
  const oud = T.status;
  T.status = nieuw;
  T.sinds = new Date().toISOString();
  if (fout) T.laatsteFout = `${T.sinds} ${fout}`;
  console.log(`[status] ${oud} → ${nieuw}${fout ? ` (${fout})` : ''}`);
  meld(oud, nieuw, fout);
}

/** Optionele pushmelding bij statuswissels die aandacht vragen (ntfy of andere webhook). */
async function meld(oud, nieuw, fout) {
  if (!CFG.meldingWebhook) return;
  const belangrijk = ['uitgelogd', 'geblokkeerd'].includes(nieuw) || (oud !== 'opstarten' && nieuw === 'verbonden');
  if (!belangrijk) return;
  const tekst = nieuw === 'verbonden'
    ? 'WhatsApp-gateway Paal 13 is weer verbonden.'
    : `WhatsApp-gateway Paal 13: ${nieuw}${fout ? ` (${fout})` : ''}. Opnieuw koppelen via /koppelen.`;
  try {
    await fetch(CFG.meldingWebhook, { method: 'POST', body: tekst, signal: AbortSignal.timeout(8000) });
  } catch (e) {
    console.warn('[melding] webhook mislukt:', e.message);
  }
}

// ── WhatsApp-verbinding ─────────────────────────────────────────────────────────────────────────
async function start() {
  clearTimeout(herstartTimer);
  const mijnGeneratie = ++generatie;
  await fs.mkdir(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    /* geen internet naar GitHub: Baileys gebruikt dan zijn ingebouwde versie */
  }

  try { sock?.end(undefined); } catch { /* oud socket was al dicht */ }

  sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger,
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false, // anders krijgt de telefoon geen meldingen meer
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    if (mijnGeneratie !== generatie) return;
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      T.qr = qr;
      zetStatus('koppelen');
    }

    if (connection === 'open') {
      herverbindPogingen = 0;
      T.qr = null;
      T.koppelcode = null;
      T.nummer = sock.user?.id ? '+' + sock.user.id.split('@')[0].split(':')[0] : null;
      zetStatus('verbonden');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reden = `${code ?? '?'} ${lastDisconnect?.error?.message ?? ''}`.trim();

      if (code === DisconnectReason.loggedOut) {
        // Ontkoppeld op de telefoon, of 14 dagen geen telefoon-activiteit: sessie is ongeldig.
        zetStatus('uitgelogd', reden);
        await wisSessie();
        plan(3000);
      } else if (code === DisconnectReason.forbidden) {
        zetStatus('geblokkeerd', reden);
        plan(5 * 60_000);
      } else if (code === DisconnectReason.connectionReplaced) {
        // Er draait ergens een tweede gateway met dezelfde sessie. Niet om de beurt blijven vechten.
        zetStatus('verbroken', 'sessie elders in gebruik (draait de gateway twee keer?)');
        plan(60_000);
      } else {
        // restartRequired (na koppelen), netwerkstoring, timeout: gewoon opnieuw.
        if (code !== DisconnectReason.restartRequired) zetStatus('verbroken', reden);
        const wacht = code === DisconnectReason.restartRequired ? 500 : Math.min(60_000, 2000 * 2 ** herverbindPogingen++);
        plan(wacht);
      }
    }
  });
}

function plan(ms) {
  clearTimeout(herstartTimer);
  herstartTimer = setTimeout(() => start().catch((e) => {
    console.error('[start] mislukt:', e);
    plan(30_000);
  }), ms);
}

async function wisSessie() {
  T.qr = null;
  T.koppelcode = null;
  T.nummer = null;
  nummerCache.clear();
  await fs.rm(authDir, { recursive: true, force: true });
}

// ── Versturen (één voor één, met tussenpozen) ───────────────────────────────────────────────────
const nummerCache = new Map(); // '316…' → {jid, exists, tot}
let wachtrij = Promise.resolve();
let laatsteVerzending = 0;
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

function verstuur(to, tekst) {
  const taak = wachtrij.then(() => verstuurNu(to, tekst));
  wachtrij = taak.catch(() => {});
  return taak;
}

async function verstuurNu(to, tekst) {
  if (T.status !== 'verbonden' || !sock) throw new Error(`WhatsApp niet verbonden (${T.status})`);

  const cijfers = to.replace(/\D/g, '');
  let jid = `${cijfers}@s.whatsapp.net`;

  if (CFG.controleerNummer) {
    let c = nummerCache.get(cijfers);
    if (!c || c.tot < Date.now()) {
      const r = await sock.onWhatsApp(cijfers);
      const hit = r?.[0];
      c = { jid: hit?.jid || jid, exists: !!hit?.exists, tot: Date.now() + 24 * 3600_000 };
      nummerCache.set(cijfers, c);
    }
    // Zonder WhatsApp: duidelijke fout, dan valt het systeem zelf terug op sms of e-mail.
    if (!c.exists) throw new Error('nummer heeft geen WhatsApp');
    jid = c.jid;
  }

  // Niet als een machinegeweer: minimale tussenpoos plus wat willekeur, en kort "typt…".
  const wacht = laatsteVerzending + CFG.minIntervalMs + Math.floor(Math.random() * 1000) - Date.now();
  if (wacht > 0) await slaap(wacht);
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await slaap(600 + Math.floor(Math.random() * 600));
    await sock.sendPresenceUpdate('paused', jid);
  } catch { /* presence is bijzaak */ }

  const res = await sock.sendMessage(jid, { text: tekst });
  laatsteVerzending = Date.now();
  return res?.key?.id ?? null;
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────
function gelijk(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function html(res, code, body, extraHeaders = {}) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'",
    ...extraHeaders,
  });
  res.end(body);
}

function leesBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (d) => {
      data += d;
      if (data.length > max) { reject(new Error('te groot')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Achter Nginx Proxy Manager komt alles binnen vanaf het IP van de proxy; het echte adres
// staat dan in X-Real-IP / X-Forwarded-For. Zonder die headers: het directe adres.
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return String(req.headers['x-real-ip'] || xff || req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?');
}

// Simpele rem op wachtwoord/sleutel raden: 10 fouten per 15 minuten per IP.
const fouten = new Map();
function geblokkeerd(ip) {
  const f = fouten.get(ip);
  return !!f && f.n >= 10 && f.tot > Date.now();
}
function telFout(ip) {
  const f = fouten.get(ip);
  if (!f || f.tot < Date.now()) fouten.set(ip, { n: 1, tot: Date.now() + 15 * 60_000 });
  else f.n++;
}

function apiToegang(req, res) {
  const ip = clientIp(req);
  if (geblokkeerd(ip)) { json(res, 429, { success: false, message: 'te veel pogingen' }); return false; }
  if (!gelijk(req.headers['x-api-key'] || '', CFG.apiSleutel)) {
    telFout(ip);
    json(res, 401, { success: false, message: 'ongeldige API-sleutel' });
    return false;
  }
  return true;
}

function koppelToegang(req, res) {
  if (!CFG.koppelWachtwoord) { html(res, 404, 'Niet gevonden'); return false; }
  const ip = clientIp(req);
  if (geblokkeerd(ip)) { html(res, 429, 'Te veel pogingen, probeer het over een kwartier opnieuw.'); return false; }
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  const ww = m ? Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':') : '';
  if (!m || !gelijk(ww, CFG.koppelWachtwoord)) {
    if (m) telFout(ip);
    html(res, 401, 'Inloggen vereist', { 'WWW-Authenticate': 'Basic realm="Paal 13 WhatsApp-gateway", charset="UTF-8"' });
    return false;
  }
  // POST alleen vanaf deze pagina zelf.
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) { html(res, 403, 'Verboden'); return false; }
  }
  return true;
}

function devices() {
  if (!T.nummer) return [];
  return [{
    phone_number: T.nummer,
    status: T.status === 'verbonden' ? 'connected' : 'disconnected',
    device_name: CFG.apparaatNaam,
  }];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  try {
    // Health en status: geen sleutel nodig, geen gevoelige gegevens.
    if (p === '/health') return json(res, 200, { ok: true });
    if (p === '/status') return json(res, T.status === 'verbonden' ? 200 : 503, { status: T.status, sinds: T.sinds });

    // ── WhatsReach-compatibele API (ook onder /api/v1, zodat elke Base URL-variant werkt) ──
    const api = p.replace(/^\/api\/v1/, '');
    if (api === '/send' && req.method === 'POST') {
      if (!apiToegang(req, res)) return;
      let body;
      try { body = JSON.parse(await leesBody(req)); } catch { return json(res, 400, { success: false, message: 'ongeldige JSON' }); }
      const to = String(body?.to ?? '').trim();
      const tekst = String(body?.message ?? '');
      if (!/^\+?\d{8,15}$/.test(to)) return json(res, 400, { success: false, message: 'ongeldig nummer (verwacht +31612345678)' });
      if (!tekst.trim()) return json(res, 400, { success: false, message: 'leeg bericht' });
      if (body.type && body.type !== 'text') return json(res, 400, { success: false, message: 'alleen type "text" wordt ondersteund' });
      if (tekst.length > 4096) return json(res, 400, { success: false, message: 'bericht te lang (max 4096 tekens)' });
      try {
        const id = await verstuur(to, tekst);
        T.verstuurd++;
        return json(res, 200, { success: true, message_id: id });
      } catch (e) {
        T.mislukt++;
        console.warn('[send] mislukt:', e.message);
        // 200 + success:false: dan toont het sollicitatiesysteem de reden in het log.
        return json(res, 200, { success: false, message: e.message });
      }
    }
    if (api === '/devices' && req.method === 'GET') {
      if (!apiToegang(req, res)) return;
      return json(res, 200, { success: true, devices: devices() });
    }

    // ── Koppelpagina ──
    if (p === '/koppelen' || p.startsWith('/koppelen/')) {
      if (!koppelToegang(req, res)) return;

      if (p === '/koppelen/stand.json') {
        return json(res, 200, { status: T.status, heeftQr: !!T.qr, koppelcode: T.koppelcode });
      }
      if (p === '/koppelen/qr.svg') {
        if (!T.qr) { res.writeHead(204); return res.end(); }
        const svg = await QRCode.toString(T.qr, { type: 'svg', margin: 2, width: 280 });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        return res.end(svg);
      }
      if (p === '/koppelen/code' && req.method === 'POST') {
        const form = new URLSearchParams(await leesBody(req, 4096));
        let nr = String(form.get('nummer') || '').replace(/\D/g, '');
        if (nr.startsWith('00')) nr = nr.slice(2);
        if (nr.startsWith('0')) nr = '31' + nr.slice(1);
        if (!/^\d{10,15}$/.test(nr)) return html(res, 400, pagina('Ongeldig nummer. Gebruik bijv. 0612345678 of +31612345678.'));
        if (T.status !== 'koppelen' || !sock) return html(res, 409, pagina('Koppelen kan alleen als er geen account gekoppeld is. Wacht tot de QR-code verschijnt.'));
        try {
          const code = await sock.requestPairingCode(nr);
          T.koppelcode = code.match(/.{1,4}/g).join('-');
        } catch (e) {
          return html(res, 500, pagina(`Koppelcode aanvragen mislukt: ${esc(e.message)}`));
        }
        res.writeHead(303, { Location: '/koppelen' });
        return res.end();
      }
      if (p === '/koppelen/ontkoppel' && req.method === 'POST') {
        try { await sock?.logout('ontkoppeld via gateway'); } catch { /* sessie was al ongeldig */ }
        await wisSessie();
        zetStatus('uitgelogd', 'handmatig ontkoppeld');
        plan(1000);
        res.writeHead(303, { Location: '/koppelen' });
        return res.end();
      }
      if (p === '/koppelen' && req.method === 'GET') return html(res, 200, pagina());
    }

    json(res, 404, { success: false, message: 'niet gevonden' });
  } catch (e) {
    console.error('[http]', e);
    if (!res.headersSent) json(res, 500, { success: false, message: 'interne fout' });
  }
});

// ── Koppelpagina (HTML) ─────────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUSTEKST = {
  opstarten: ['Opstarten…', '#64748b'],
  koppelen: ['Niet gekoppeld — koppel hieronder', '#d97706'],
  verbonden: ['Verbonden', '#16a34a'],
  verbroken: ['Verbinding weg — gateway probeert opnieuw', '#d97706'],
  uitgelogd: ['Uitgelogd — opnieuw koppelen nodig', '#dc2626'],
  geblokkeerd: ['Geweigerd door WhatsApp (mogelijk geblokkeerd)', '#dc2626'],
};

function pagina(melding = '') {
  const [stTekst, stKleur] = STATUSTEKST[T.status] || [T.status, '#64748b'];
  const verbonden = T.status === 'verbonden';
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp-gateway Paal 13</title>
<style>
 body{font:16px/1.5 system-ui,-apple-system,sans-serif;margin:0;background:#f1f5f9;color:#0f172a}
 main{max-width:480px;margin:0 auto;padding:20px}
 .kaart{background:#fff;border-radius:14px;padding:18px;margin:0 0 14px;box-shadow:0 1px 3px #0001}
 h1{font-size:20px;margin:4px 0 14px} h2{font-size:16px;margin:0 0 8px}
 .st{display:inline-block;padding:4px 10px;border-radius:99px;color:#fff;background:${stKleur};font-weight:600}
 .qr{display:block;margin:10px auto;width:280px;max-width:100%;background:#fff}
 .code{font:700 30px/1.2 ui-monospace,monospace;letter-spacing:3px;text-align:center;padding:12px;background:#f8fafc;border-radius:10px}
 input,button{font:inherit;padding:11px 12px;border-radius:10px;border:1px solid #cbd5e1;width:100%;box-sizing:border-box}
 button{background:#0f172a;color:#fff;border:0;margin-top:8px;font-weight:600}
 button.gevaar{background:#dc2626}
 .klein{font-size:13px;color:#475569} .melding{background:#fef3c7;padding:10px 12px;border-radius:10px}
 dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0} dt{color:#475569}
</style></head><body><main>
<h1>WhatsApp-gateway Paal 13</h1>
${melding ? `<p class="melding">${melding}</p>` : ''}
<div class="kaart">
  <span class="st">${esc(stTekst)}</span>
  <dl style="margin-top:12px">
    ${T.nummer ? `<dt>Nummer</dt><dd>${esc(T.nummer)}</dd>` : ''}
    <dt>Sinds</dt><dd>${esc(new Date(T.sinds).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }))}</dd>
    <dt>Verstuurd</dt><dd>${T.verstuurd} (mislukt: ${T.mislukt}) sinds herstart</dd>
    ${T.laatsteFout ? `<dt>Laatste fout</dt><dd class="klein">${esc(T.laatsteFout)}</dd>` : ''}
  </dl>
</div>
${CFG.sleutelZelfGemaakt ? `
<div class="kaart">
  <h2>API-sleutel voor het sollicitatiesysteem</h2>
  <input id="sleutel" readonly value="${esc(CFG.apiSleutel)}" onclick="this.select()">
  <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('sleutel').value).then(()=>this.textContent='Gekopieerd')">Kopiëren</button>
  <p class="klein">Plak deze in het beheer bij Instellingen › Kanalen › WhatsApp › API-sleutel.</p>
</div>` : ''}
${T.status === 'koppelen' ? `
<div class="kaart">
  <h2>Koppelen met code (handig op je telefoon)</h2>
  ${T.koppelcode ? `<div class="code">${esc(T.koppelcode)}</div>
  <p class="klein">Op de gateway-telefoon: WhatsApp › Instellingen › Gekoppelde apparaten › Apparaat koppelen › <b>Koppelen met telefoonnummer</b>, en voer deze code in.</p>` : `
  <form method="post" action="/koppelen/code">
    <input name="nummer" inputmode="tel" placeholder="Nummer van de gateway-telefoon, bijv. 0612345678" required>
    <button>Koppelcode aanvragen</button>
  </form>`}
</div>
<div class="kaart">
  <h2>Of scan de QR-code</h2>
  <img class="qr" id="qr" src="/koppelen/qr.svg" alt="QR-code">
  <p class="klein">WhatsApp › Instellingen › Gekoppelde apparaten › Apparaat koppelen. De code ververst vanzelf.</p>
</div>` : ''}
${verbonden ? `
<div class="kaart">
  <h2>Ontkoppelen</h2>
  <p class="klein">Alleen nodig om een ander nummer te gebruiken. Daarna gaan WhatsApp-berichten via sms/e-mail tot je opnieuw koppelt.</p>
  <form method="post" action="/koppelen/ontkoppel" onsubmit="return confirm('Echt ontkoppelen?')">
    <button class="gevaar">Ontkoppelen</button>
  </form>
</div>` : ''}
<p class="klein">Houd de gateway-telefoon aan en open WhatsApp daarop minstens eens per week; na 14 dagen zonder telefoon-activiteit logt WhatsApp de gateway uit.</p>
</main>
<script>
 let stand = ${JSON.stringify(T.status)}, code = ${JSON.stringify(T.koppelcode)};
 setInterval(async () => {
   try {
     const r = await fetch('/koppelen/stand.json', { cache: 'no-store' });
     const s = await r.json();
     if (s.status !== stand || s.koppelcode !== code) return location.reload();
     const img = document.getElementById('qr');
     if (img && s.heeftQr && !document.querySelector('input:focus')) img.src = '/koppelen/qr.svg?t=' + Date.now();
   } catch (e) {}
 }, 5000);
</script>
</body></html>`;
}

// ── Starten en netjes stoppen ───────────────────────────────────────────────────────────────────
server.listen(CFG.poort, () => console.log(`[http] luistert op poort ${CFG.poort}`));
start().catch((e) => { console.error('[start] mislukt:', e); plan(30_000); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[stop] ${sig}`);
    clearTimeout(herstartTimer);
    try { sock?.end(undefined); } catch { /* al dicht */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
