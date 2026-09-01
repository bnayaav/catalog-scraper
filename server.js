'use strict';

/*
 * ComPhone Admin — שרת פרוקסי ל-API של iStores
 * --------------------------------------------------
 * השרת מגיש את לוח הניהול, שומר על הכל מאחורי סיסמה,
 * ומעביר בקשות אל https://api.istores.co.il עם הכותרות הנדרשות
 * (x-token, Company-Id, User-Agent) — כך שהטוקן נשאר בצד השרת בלבד.
 *
 * משתני סביבה (ב-Railway → Variables):
 *  - ISTORES_API_KEY     טוקן ההתממשקות (נשלח ככותרת x-token)         [חובה]
 *  - ISTORES_COMPANY_ID  ה-Client ID שלך מ-iStores (כותרת Company-Id) [חובה]
 *  - ADMIN_PASSWORD      סיסמה להתחברות ללוח הזה                       [חובה]
 *  - SESSION_SECRET      מחרוזת אקראית לחתימת עוגיית ההתחברות          [מומלץ]
 *  - ISTORES_USER_AGENT  ברירת מחדל: comphone-admin/1.0               [אופציונלי]
 *  - PORT                נקבע אוטומטית ע"י Railway
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_BASE = process.env.ISTORES_API_BASE || 'https://api.istores.co.il';
const API_KEY = process.env.ISTORES_API_KEY || process.env.ISTORES_API_TOKEN || '';
const COMPANY_ID = process.env.ISTORES_COMPANY_ID || '';
const USER_AGENT = process.env.ISTORES_USER_AGENT || 'comphone-admin/1.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('cp-' + (ADMIN_PASSWORD || 'fallback')).digest('hex');

const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 12; // 12 שעות
const COOKIE_NAME = 'cp_session';
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ */
/* Cloudflare KV — גיבוי טיוטות + קריאת קטלוג הסוכנים                  */
/* אותו namespace שאליו כותב הסורק (catalog-scraper).                  */
/* משתני סביבה (ב-Railway → Variables):                                */
/*  - CF_ACCOUNT_ID    מזהה החשבון ב-Cloudflare                        */
/*  - CF_KV_NAMESPACE  מזהה ה-KV namespace                             */
/*  - CF_API_TOKEN     טוקן עם הרשאת Workers KV (קריאה+כתיבה)          */
/*  - CF_DRAFTS_KEY    מפתח לשמירת הטיוטות (ברירת מחדל: comphone_drafts)*/
/* בלי המשתנים האלה — הטיוטות עדיין עובדות מקומית, וייבוא הסוכנים כבוי. */
/* ------------------------------------------------------------------ */
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const CF_KV_NAMESPACE = process.env.CF_KV_NAMESPACE || '';
const CF_API_TOKEN = process.env.CF_API_TOKEN || '';
const DRAFTS_KEY = process.env.CF_DRAFTS_KEY || 'comphone_drafts';
const cfConfigured = () => !!(CF_ACCOUNT_ID && CF_KV_NAMESPACE && CF_API_TOKEN);
function kvUrl(key) {
  return `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}` +
         `/storage/kv/namespaces/${CF_KV_NAMESPACE}/values/${encodeURIComponent(key)}`;
}
async function kvGet(key) {
  if (!cfConfigured()) return null;
  const r = await fetch(kvUrl(key), { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('Cloudflare KV get ' + key + ' → ' + r.status);
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}
async function kvPut(key, value) {
  if (!cfConfigured()) return false;
  const r = await fetch(kvUrl(key), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error('Cloudflare KV put ' + key + ' → ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return true;
}

// קטלוג הסוכנים נשמר מפוצל ל-catalog_1 + catalog_2 (מערכים) ע"י הסורק.
// קאש קצר בזיכרון כדי לא לקרוא מ-KV בכל בקשה.
let _catCache = { at: 0, data: null };
async function getCatalog() {
  const now = Date.now();
  if (_catCache.data && now - _catCache.at < 60000) return _catCache.data;
  const [c1, c2, meta] = await Promise.all([kvGet('catalog_1'), kvGet('catalog_2'), kvGet('catalog_meta')]);
  const products = [...(Array.isArray(c1) ? c1 : []), ...(Array.isArray(c2) ? c2 : [])];
  const data = { products, meta: meta && typeof meta === 'object' ? meta : null };
  _catCache = { at: now, data };
  return data;
}

/* ------------------------------------------------------------------ */
/* אחסון טיוטות (מוצרים שטרם פורסמו)                                    */
/* כשמוגדר Cloudflare — KV הוא המקור הקבוע (שורד פריסות מחדש),          */
/* וקובץ מקומי משמש מראה/גיבוי. בלי Cloudflare — קובץ מקומי בלבד.       */
/* ------------------------------------------------------------------ */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DRAFTS_FILE = path.join(DATA_DIR, 'drafts.json');
function ensureDataDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
function readDrafts() {
  try { return JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf8')) || []; }
  catch { return []; }
}
function writeDrafts(arr) {
  ensureDataDir();
  fs.writeFileSync(DRAFTS_FILE, JSON.stringify(Array.isArray(arr) ? arr : [], null, 2));
}
async function getDrafts() {
  if (cfConfigured()) {
    const v = await kvGet(DRAFTS_KEY);
    if (Array.isArray(v)) { try { writeDrafts(v); } catch {} return v; }
    return readDrafts(); // KV ריק/חסר → מקומי
  }
  return readDrafts();
}
async function saveDrafts(arr) {
  const list = Array.isArray(arr) ? arr : [];
  try { writeDrafts(list); } catch {} // מראה מקומית (לא חוסם)
  if (cfConfigured()) await kvPut(DRAFTS_KEY, list); // גיבוי קבוע (חוסם — כדי שתדע אם נכשל)
}

/* ------------------------------------------------------------------ */
/* עוגיית התחברות חתומה (HMAC) — בלי תלויות חיצוניות                    */
/* ------------------------------------------------------------------ */
function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return data + '.' + mac;
}
function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [data, mac] = token.split('.');
  if (!data || !mac) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}
function isAuthed(req) { return !!verifySession(parseCookies(req)[COOKIE_NAME]); }
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ------------------------------------------------------------------ */
/* כותרות ה-API לפי התיעוד הרשמי                                        */
/* ------------------------------------------------------------------ */
function apiHeaders() {
  return {
    'x-token': API_KEY,
    'Company-Id': COMPANY_ID,
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/* ------------------------------------------------------------------ */
/* כלי עזר                                                             */
/* ------------------------------------------------------------------ */
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 8 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });
}
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const type = STATIC_TYPES[path.extname(full)] || 'application/octet-stream';
    const headers = { 'Content-Type': type };
    if (path.extname(full) === '.html') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    res.writeHead(200, headers);
    res.end(buf);
  });
}
function missingConfig() {
  const missing = [];
  if (!API_KEY) missing.push('ISTORES_API_KEY');
  if (!COMPANY_ID) missing.push('ISTORES_COMPANY_ID');
  return missing;
}

// חתימת HMAC לכתובת תמונה — כדי שה-proxy הציבורי לא יהיה פתוח לכל העולם
function imgSig(u) {
  return crypto.createHmac('sha256', SESSION_SECRET).update('img:' + u).digest('base64url');
}

// ── שיוך קטגוריות אמיתי לסמיקום — לפי שם הקטגוריה מהאתר (לא ניחוש סוג/מותג) ──
// כל תת-הקטגוריות שנוצרות אוטומטית מקובצות תחת קטגוריית-שורש אחת ("סמיקום"),
// כדי לא לפזר עשרות קטגוריות חדשות ישירות בתפריט הראשי של החנות.
const SEMICOM_ROOT_CATEGORY_NAME = 'לבית משרד וגינה';

function makeSemicomCategorizer(istores) {
  const createdCache = new Map(); // שם מנורמל → id, נמנע מיצירה כפולה באותה ריצה
  let rootId = null;

  async function ensureRoot(categories) {
    if (rootId) return rootId;
    const norm = SEMICOM_ROOT_CATEGORY_NAME.trim().toLowerCase();
    const existing = categories.find((c) => !c.parent && (c.name || '').trim().toLowerCase() === norm);
    if (existing) { rootId = existing.id; return rootId; }
    try {
      const created = await istores.post('/categories', {
        category_description: { 3: { name: SEMICOM_ROOT_CATEGORY_NAME } },
        parent_id: 0,
        status: 1,
      });
      const newId = Number(created?.category_id ?? created?.id ?? created?.response?.category_id ?? 0) || null;
      if (newId) {
        rootId = newId;
        categories.push({ id: rootId, name: SEMICOM_ROOT_CATEGORY_NAME, parent: 0 });
        console.log(`[semicom categorize] נוצרה קטגוריית שורש "${SEMICOM_ROOT_CATEGORY_NAME}" (id ${rootId})`);
      } else {
        console.error('[semicom categorize] יצירת קטגוריית שורש לא החזירה id:', JSON.stringify(created));
      }
    } catch (e) {
      console.error('[semicom categorize] יצירת קטגוריית שורש נכשלה:', e.message);
    }
    return rootId;
  }

  return async function categorize(categories, p) {
    const name = (p.category || '').trim();
    if (!name) return [];
    const norm = name.toLowerCase();

    // כבר קיימת קטגוריה בחנות עם השם הזה בדיוק — משתמשים בה
    const exact = categories.find((c) => (c.name || '').trim().toLowerCase() === norm);
    if (exact) return [exact.id];

    // כבר נוצרה באותה ריצה — לא יוצרים שוב
    if (createdCache.has(norm)) return [createdCache.get(norm)];

    const parentId = await ensureRoot(categories);
    try {
      const created = await istores.post('/categories', {
        category_description: { 3: { name } },
        parent_id: parentId || 0,
        status: 1,
      });
      const newId = Number(created?.category_id ?? created?.id ?? created?.response?.category_id ?? 0) || null;
      if (newId) {
        createdCache.set(norm, newId);
        categories.push({ id: newId, name, parent: parentId || 0 });
        return [newId];
      }
      console.error(`[semicom categorize] יצירת קטגוריה "${name}" לא החזירה id:`, JSON.stringify(created));
    } catch (e) {
      console.error(`[semicom categorize] יצירת קטגוריה "${name}" נכשלה:`, e.message);
    }
    return [];
  };
}

/* ------------------------------------------------------------------ */
/* סנכרון אוטומטי: Atomic → iStores                                    */
/* ------------------------------------------------------------------ */
const { runSync, DEFAULT_SETTINGS, computePrice } = require('./sync');
const { fetchAtomicCatalog, atomicConfigured } = require('./atomic');
const { mapSemicomProduct, SEMICOM_SETTINGS_OVERRIDES } = require('./semicom');

// הגדרות ומפתחות KV לכל ספק בנפרד — כך שהרצת/שינוי הגדרות של אחד
// לעולם לא נוגע בשני. אטומיק שומר על אותם מפתחות כמו קודם (תאימות לאחור).
const SYNC_SOURCES = {
  atomic: {
    label: 'Atomic',
    settingsKey: 'sync_settings',
    logKey: 'sync_last_run',
    defaultsOverride: {},
    fetchCatalog: fetchAtomicCatalog,
    isConfigured: atomicConfigured,
  },
  semicom: {
    label: 'Semicom',
    settingsKey: 'sync_settings_semicom',
    logKey: 'sync_last_run_semicom',
    defaultsOverride: SEMICOM_SETTINGS_OVERRIDES,
    fetchCatalog: fetchSemicomCatalog,
    // אין API key לסמיקום — "מוגדר" כלומר יש חיבור ל-Cloudflare שממנו קוראים את הקטלוג שנסרק
    isConfigured: cfConfigured,
  },
};

let syncJobs = { atomic: null, semicom: null }; // supplier → { running, dryRun, log:[], startedAt, stats, error }

async function getSyncSettings(supplier) {
  const src = SYNC_SOURCES[supplier];
  let saved = null;
  try { if (cfConfigured()) saved = await kvGet(src.settingsKey); } catch {}
  return { ...DEFAULT_SETTINGS, ...src.defaultsOverride, ...(saved && typeof saved === 'object' ? saved : {}) };
}

// שולף את מוצרי סמיקום מתוך קטלוג הסוכנים (KV) — נכתב ע"י הסורק היומי, לא כאן.
// מסנן לפי הקטגוריות שנבחרו בהגדרות (categoryFilter) — מערך ריק = בלי סינון (הכול).
async function fetchSemicomCatalog(onProgress) {
  const settings = await getSyncSettings('semicom');
  const { products: all } = await getCatalog();
  let list = all.filter((p) => p.supplier === 'Semicom');
  if (Array.isArray(settings.categoryFilter) && settings.categoryFilter.length) {
    const allow = new Set(settings.categoryFilter);
    list = list.filter((p) => allow.has(p.category));
  }
  const mapped = list.map(mapSemicomProduct);
  if (onProgress) onProgress(mapped.length, mapped.length);
  return { products: mapped, total: mapped.length };
}

// עוזרי iStores עבור מנוע הסנכרון
const istoresClient = {
  async get(p) {
    const r = await fetch(API_BASE + p, { headers: apiHeaders() });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 1500)); return istoresClient.get(p); }
    const t = await r.text();
    try { return JSON.parse(t); } catch { throw new Error('תשובה לא תקינה מ-iStores'); }
  },
  async put(p, body) {
    const r = await fetch(API_BASE + p, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 1500)); return istoresClient.put(p, body); }
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    if (!r.ok || (j && j.success === false)) {
      console.error(`[istores PUT ${p}] HTTP ${r.status} — תגובה מלאה (${t.length} תווים): ${t}`);
      throw new Error(`HTTP ${r.status} ${t.slice(0, 500)}`);
    }
    return j;
  },
  async post(p, body) {
    const r = await fetch(API_BASE + p, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 1500)); return istoresClient.post(p, body); }
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    if (!r.ok || (j && j.success === false)) {
      console.error(`[istores POST ${p}] HTTP ${r.status} — תגובה מלאה (${t.length} תווים): ${t}`);
      console.error(`[istores POST ${p}] payload שנשלח: ${JSON.stringify(body)}`);
      throw new Error(`HTTP ${r.status} ${t.slice(0, 500)}`);
    }
    return j;
  },
};

// קטגוריות החנות (לשיוך אוטומטי)
async function fetchStoreCategories() {
  try {
    const j = await istoresClient.get('/categories');
    const arr = Array.isArray(j.response) ? j.response : Array.isArray(j.categories) ? j.categories : null;
    if (!arr) return null;
    return arr.map((c) => {
      let name = c.name;
      const d = c.description || c.descriptions;
      if (!name && d && typeof d === 'object') { const v = d['3'] || Object.values(d)[0]; if (v) name = v.name || v; }
      return { id: Number(c.category_id ?? c.id), name: name || '', parent: Number(c.parent_id || 0),
               image: c.image || c.thumb || c.image_url || '',
               url: c.url || c.seo_url || c.keyword || c.slug || '' };
    });
  } catch { return null; }
}

function signedImg(u) {
  // תמונות שכבר מאוחסנות ב-R2 (סמיקום) הן ציבוריות ויציבות מלכתחילה —
  // אין טעם לעטוף אותן ב-proxy שלנו, זה רק מוסיף עיכוב ונקודת כשל מיותרת.
  if (/^https:\/\/pub-[a-z0-9]+\.r2\.dev\//i.test(u)) return u;
  // הקישור חייב להיות מוחלט כדי ש-iStores יוכל למשוך אותו
  let base = process.env.PUBLIC_BASE_URL || '';
  // הגנה: אם מישהו הגדיר את המשתנה בלי https:// בטעות, נוסיף אוטומטית —
  // אחרת iStores דוחה את יצירת המוצר עם "מבנה קישור לא תקין".
  if (base && !/^https?:\/\//i.test(base)) base = 'https://' + base;
  const p = '/img/p.jpg?u=' + encodeURIComponent(u) + '&s=' + imgSig(u);
  return base ? base.replace(/\/+$/, '') + p : u; // בלי PUBLIC_BASE_URL — קישור ישיר
}

async function startSync(supplier, dryRun) {
  const src = SYNC_SOURCES[supplier];
  if (!src) throw new Error('ספק לא מוכר: ' + supplier);
  if (syncJobs[supplier] && syncJobs[supplier].running) throw new Error('סנכרון כבר רץ');
  const settings = await getSyncSettings(supplier);
  const job = { running: true, dryRun, log: [], startedAt: new Date().toISOString(), stats: null, error: null };
  syncJobs[supplier] = job;
  const log = (m) => {
    job.log.push(`[${new Date().toLocaleTimeString('he-IL')}] ${m}`);
    if (job.log.length > 200) job.log.shift();
    console.log(`[sync:${supplier}]`, m);
  };

  (async () => {
    try {
      const categories = settings.autoCategories ? await fetchStoreCategories() : null;
      const stats = await runSync({
        istores: istoresClient, settings, categories, imgUrl: signedImg, log,
        fetchCatalog: src.fetchCatalog, sourceLabel: src.label,
        categorize: supplier === 'semicom' ? makeSemicomCategorizer(istoresClient) : undefined,
      }, dryRun);
      job.stats = stats;
      log(`הסתיים · נוצרו ${stats.created} · עודכנו ${stats.updated} · אופסו ${stats.zeroed} · נכשלו ${stats.failed}`);
      if (!dryRun && cfConfigured()) { try { await kvPut(src.logKey, stats); } catch {} }
    } catch (e) {
      job.error = e.message;
      log('❌ שגיאה: ' + e.message);
    } finally {
      job.running = false;
    }
  })();

  return true;
}

// מתזמן יומי (בדיקה כל 10 דקות; רץ פעם ביום בשעה שנקבעה) — לכל ספק בנפרד
let lastAutoRunDay = { atomic: null, semicom: null };
setInterval(async () => {
  for (const supplier of Object.keys(SYNC_SOURCES)) {
    try {
      const src = SYNC_SOURCES[supplier];
      const s = await getSyncSettings(supplier);
      if (!s.enabled || !src.isConfigured()) continue;
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      if (lastAutoRunDay[supplier] === day) continue;
      if (now.getHours() !== Number(s.runAtHour)) continue;
      lastAutoRunDay[supplier] = day;
      console.log(`[sync:${supplier}] מפעיל סנכרון יומי מתוזמן`);
      await startSync(supplier, false);
    } catch (e) { console.error(`[sync:${supplier}] תזמון נכשל:`, e.message); }
  }
}, 10 * 60 * 1000);

/* ------------------------------------------------------------------ */
/* השרת                                                                */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/healthz') return sendJson(res, 200, { ok: true });

  // התחברות
  if (pathname === '/api/login' && method === 'POST') {
    const raw = await readBody(req);
    let pwd = '';
    try { pwd = (JSON.parse(raw || '{}').password || '').toString(); } catch {}
    if (!ADMIN_PASSWORD) return sendJson(res, 500, { success: false, error: 'לא הוגדרה סיסמת ניהול (ADMIN_PASSWORD) בשרת.' });
    if (!safeEqual(pwd, ADMIN_PASSWORD)) return sendJson(res, 401, { success: false, error: 'סיסמה שגויה.' });
    const token = signSession({ exp: Date.now() + SESSION_MAX_AGE_MS });
    const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? ' Secure;' : '';
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`);
    return sendJson(res, 200, { success: true });
  }
  if (pathname === '/api/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return sendJson(res, 200, { success: true });
  }
  if (pathname === '/login') return serveStatic(res, 'login.html');

  if (pathname === '/api/me') {
    return sendJson(res, 200, {
      authenticated: isAuthed(req),
      keyConfigured: !!API_KEY,
      companyConfigured: !!COMPANY_ID,
      cloudflareConfigured: cfConfigured(),
      missing: missingConfig(),
    });
  }

  // בדיקת חיבור עם אבחון מפורט
  if (pathname === '/api/test-connection' && method === 'POST') {
    if (!isAuthed(req)) return sendJson(res, 401, { success: false, error: 'נדרשת התחברות.' });
    const miss = missingConfig();
    if (miss.length)
      return sendJson(res, 400, { success: false, error: 'חסרים משתני סביבה ב-Railway: ' + miss.join(', ') });
    try {
      const r = await fetch(API_BASE + '/products/1/1', { headers: apiHeaders() });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch {}
      if (r.ok && body && body.success) return sendJson(res, 200, { success: true });
      return sendJson(res, 200, {
        success: false,
        status: r.status,
        error:
          r.status === 403 ? 'נדחה (403) — ככל הנראה הטוקן או ה-Company-Id שגויים.'
          : r.status === 429 ? 'יותר מדי בקשות (429). נסו שוב בעוד רגע.'
          : 'התקבלה תשובה לא צפויה מ-iStores.',
        sample: text.slice(0, 400),
      });
    } catch (e) {
      return sendJson(res, 200, { success: false, error: 'שגיאת תקשורת מול iStores: ' + e.message });
    }
  }

  // טיוטות מוצרים — גיבוי ל-Cloudflare KV (אם מוגדר), אחרת מקומי
  if (pathname === '/api/drafts') {
    if (!isAuthed(req)) return sendJson(res, 401, { success: false, error: 'נדרשת התחברות.' });
    if (method === 'GET') {
      try {
        const drafts = await getDrafts();
        return sendJson(res, 200, { success: true, drafts, source: cfConfigured() ? 'cloudflare' : 'local' });
      } catch (e) {
        // נפילה רכה: אם הקריאה מ-KV נכשלה, נחזיר מה שיש מקומית
        return sendJson(res, 200, { success: true, drafts: readDrafts(), source: 'local', warning: e.message });
      }
    }
    if (method === 'POST') {
      const raw = await readBody(req);
      let drafts = [];
      try { drafts = JSON.parse(raw || '{}').drafts || []; } catch {}
      if (!Array.isArray(drafts)) drafts = [];
      try {
        await saveDrafts(drafts);
        return sendJson(res, 200, { success: true, count: drafts.length, backedUp: cfConfigured() });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: 'גיבוי הטיוטות ל-Cloudflare נכשל: ' + e.message });
      }
    }
  }

  // רשימת מותגים בקטלוג הסוכנים (קל — לבורר הייבוא)
  if (pathname === '/api/catalog/brands' && method === 'GET') {
    if (!isAuthed(req)) return sendJson(res, 401, { success: false, error: 'נדרשת התחברות.' });
    if (!cfConfigured()) return sendJson(res, 400, { success: false, error: 'לא הוגדר חיבור ל-Cloudflare (CF_ACCOUNT_ID / CF_KV_NAMESPACE / CF_API_TOKEN).' });
    try {
      const { products, meta } = await getCatalog();
      const map = {};
      for (const p of products) {
        const b = ((p.brand || '').trim()) || 'אחר';
        (map[b] || (map[b] = { brand: b, total: 0, inStock: 0 }));
        map[b].total++;
        if (p.stock !== 'אזל') map[b].inStock++;
      }
      const brands = Object.values(map).sort((a, b) => b.total - a.total);
      return sendJson(res, 200, { success: true, count: products.length, meta, brands });
    } catch (e) {
      return sendJson(res, 502, { success: false, error: 'שגיאת קריאה מ-Cloudflare: ' + e.message });
    }
  }

  // מוצרים בקטלוג לפי מותג (לייבוא בפועל)
  if (pathname === '/api/catalog/products' && method === 'GET') {
    if (!isAuthed(req)) return sendJson(res, 401, { success: false, error: 'נדרשת התחברות.' });
    if (!cfConfigured()) return sendJson(res, 400, { success: false, error: 'לא הוגדר חיבור ל-Cloudflare.' });
    try {
      const { products } = await getCatalog();
      const brand = url.searchParams.get('brand');
      const inStockOnly = url.searchParams.get('inStock') === '1';
      let out = products;
      if (brand) out = out.filter(p => (((p.brand || '').trim()) || 'אחר') === brand);
      if (inStockOnly) out = out.filter(p => p.stock !== 'אזל');
      return sendJson(res, 200, { success: true, count: out.length, products: out });
    } catch (e) {
      return sendJson(res, 502, { success: false, error: 'שגיאת קריאה מ-Cloudflare: ' + e.message });
    }
  }

  // ── proxy לתמונות ──────────────────────────────────────────────
  // ציבורי (iStores מושך מכאן) אך חתום ב-HMAC כדי שלא יהיה proxy פתוח.
  // מושך את תמונת הספק עם כותרות דפדפן + Referer כדי לעקוף חסימת hotlink,
  // ומגיש אותה ל-iStores מהשרת שלך — שתמיד נגיש.
  if ((pathname === '/img' || pathname.startsWith('/img/')) && method === 'GET') {
    const u = url.searchParams.get('u') || '';
    const s = url.searchParams.get('s') || '';
    if (!/^https?:\/\//i.test(u)) { res.writeHead(400); return res.end('bad url'); }
    const expect = imgSig(u);
    const a = Buffer.from(s), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { res.writeHead(403); return res.end('bad signature'); }
    try {
      let origin = '';
      try { origin = new URL(u).origin; } catch {}
      const imgRes = await fetch(u, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8',
          'Referer': origin ? origin + '/' : '',
        },
      });
      if (!imgRes.ok) { res.writeHead(502); return res.end('upstream ' + imgRes.status); }
      const ct = imgRes.headers.get('content-type') || '';
      if (!/^image\//i.test(ct)) { res.writeHead(415); return res.end('not an image'); }
      const buf = Buffer.from(await imgRes.arrayBuffer());
      if (buf.length > 12 * 1024 * 1024) { res.writeHead(413); return res.end('too large'); }
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=604800', 'Content-Length': buf.length });
      return res.end(buf);
    } catch (e) {
      res.writeHead(502); return res.end('fetch failed');
    }
  }

  // מחזיר נתיב proxy חתום עבור כתובת תמונה (מאומת — נקרא מהדף לפני פרסום)
  if (pathname === '/api/img-url' && method === 'GET') {
    if (!isAuthed(req)) return sendJson(res, 401, { success: false, error: 'נדרשת התחברות.' });
    const u = (url.searchParams.get('u') || '').trim();
    if (!/^https?:\/\//i.test(u)) return sendJson(res, 400, { success: false, error: 'כתובת תמונה לא תקינה' });
    // נתיב עם סיומת .jpg קוסמטית — למקרה ש-iStores בודק סיומת קובץ
    const p = '/img/p.jpg?u=' + encodeURIComponent(u) + '&s=' + imgSig(u);
    return sendJson(res, 200, { success: true, path: p });
  }

  // רשימת קטגוריות סמיקום מתוך הקטלוג (KV) — לבחירת מה מסונכרן
  if (pathname === '/api/sync/semicom/categories' && method === 'GET') {
    if (!isAuthed(req)) return sendJson(res, 401, { success: false, error: 'נדרשת התחברות.' });
    if (!cfConfigured()) return sendJson(res, 400, { success: false, error: 'לא הוגדר חיבור ל-Cloudflare.' });
    try {
      const { products: all, meta } = await getCatalog();
      const semicom = all.filter((p) => p.supplier === 'Semicom');
      const map = new Map();
      for (const p of semicom) {
        const name = p.category || 'ללא קטגוריה';
        if (!map.has(name)) map.set(name, { category: name, count: 0, inStock: 0, sampleImg: '' });
        const c = map.get(name);
        c.count++;
        if (p.stock !== 'אזל') c.inStock++;
        if (!c.sampleImg && p.img) c.sampleImg = signedImg(p.img);
      }
      const categories = [...map.values()].sort((a, b) => b.count - a.count);
      return sendJson(res, 200, { success: true, categories, total: semicom.length, catalogUpdatedAt: meta?.lastUpdate || null });
    } catch (e) {
      return sendJson(res, 502, { success: false, error: 'שגיאת קריאה מ-Cloudflare: ' + e.message });
    }
  }

  // ── סנכרון Atomic + Semicom ────────────────────────────────────
  // נתיבים ישנים (בלי קידומת ספק) ממשיכים להתנהג כמו קודם = אטומיק,
  // כדי לא לשבור את sync.html הקיים. נתיבים חדשים תחת /semicom/ לסמיקום.
  const SYNC_ROUTE = pathname.match(/^\/api\/sync\/(semicom\/)?(settings|price-preview|run|status)$/);
  if (SYNC_ROUTE) {
    const supplier = SYNC_ROUTE[1] ? 'semicom' : 'atomic';
    const action = SYNC_ROUTE[2];
    const src = SYNC_SOURCES[supplier];

    if (action === 'settings') {
      if (!isAuthed(req)) return sendJson(res, 401, { success: false, error: 'נדרשת התחברות.' });
      if (method === 'GET') {
        const s = await getSyncSettings(supplier);
        let semicomHasData = null;
        if (supplier === 'semicom') {
          try { const { products } = await getCatalog(); semicomHasData = products.some((p) => p.supplier === 'Semicom'); }
          catch { semicomHasData = null; }
        }
        return sendJson(res, 200, {
          success: true, settings: s,
          atomicConfigured: atomicConfigured(), // נשמר לתאימות לאחור עם sync.html
          sourceConfigured: src.isConfigured(),
          semicomHasData,
          cloudflareConfigured: cfConfigured(),
          publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
        });
      }
      if (method === 'POST') {
        if (!cfConfigured()) return sendJson(res, 400, { success: false, error: 'נדרש חיבור ל-Cloudflare כדי לשמור הגדרות.' });
        const raw = await readBody(req);
        let incoming = {};
        try { incoming = JSON.parse(raw || '{}').settings || {}; } catch {}
        const merged = { ...DEFAULT_SETTINGS, ...src.defaultsOverride, ...(await getSyncSettings(supplier)), ...incoming };
        try { await kvPut(src.settingsKey, merged); return sendJson(res, 200, { success: true, settings: merged }); }
        catch (e) { return sendJson(res, 500, { success: false, error: 'שמירה נכשלה: ' + e.message }); }
      }
    }

    if (action === 'price-preview' && method === 'GET') {
      if (!isAuthed(req)) return sendJson(res, 401, { success: false, error: 'נדרשת התחברות.' });
      const supplierPrice = Number(url.searchParams.get('p') || 0);
      const s = await getSyncSettings(supplier);
      return sendJson(res, 200, { success: true, supplier: supplierPrice, sell: computePrice(supplierPrice, s) });
    }

    if (action === 'run' && method === 'POST') {
      if (!isAuthed(req)) return sendJson(res, 401, { success: false, error: 'נדרשת התחברות.' });
      if (!src.isConfigured()) {
        return sendJson(res, 400, { success: false, error: supplier === 'atomic'
          ? 'חסר ATOMIC_API_KEY במשתני הסביבה.'
          : 'לא הוגדר חיבור ל-Cloudflare — אי אפשר לקרוא את קטלוג סמיקום.' });
      }
      const miss = missingConfig();
      if (miss.length) return sendJson(res, 400, { success: false, error: 'חסרים משתני סביבה: ' + miss.join(', ') });
      const dry = url.searchParams.get('dry') === '1';
      try { await startSync(supplier, dry); return sendJson(res, 200, { success: true, started: true, dryRun: dry }); }
      catch (e) { return sendJson(res, 409, { success: false, error: e.message }); }
    }

    if (action === 'status' && method === 'GET') {
      if (!isAuthed(req)) return sendJson(res, 401, { success: false, error: 'נדרשת התחברות.' });
      let last = null;
      try { if (cfConfigured()) last = await kvGet(src.logKey); } catch {}
      return sendJson(res, 200, { success: true, job: syncJobs[supplier], lastRun: last });
    }
  }

  // ── קטגוריות ציבוריות (עבור קרוסלת הקטגוריות באתר) ──────────────
  // ציבורי בכוונה: זהו מידע שממילא גלוי בחנות. CORS פתוח כדי שהאתר יוכל למשוך.
  if (pathname === '/api/public/categories') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (method !== 'GET') { res.writeHead(405); return res.end(); }
    try {
      const now = Date.now();
      if (!global.__catCache || now - global.__catCache.at > 300000) {
        const raw = await fetchStoreCategories();
        global.__catCache = { at: now, data: raw || [] };
      }
      const all = global.__catCache.data || [];
      // ברירת מחדל: רק קטגוריות ראשיות (בלי הורה)
      const topOnly = url.searchParams.get('all') !== '1';
      const list = (topOnly ? all.filter((c) => !c.parent) : all)
        .filter((c) => c.name)
        .map((c) => ({ id: c.id, name: c.name, image: c.image || '', url: c.url || '' }));
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      });
      return res.end(JSON.stringify({ success: true, categories: list }));
    } catch (e) {
      return sendJson(res, 502, { success: false, error: e.message });
    }
  }

  // פרוקסי ל-API
  if (pathname.startsWith('/proxy/')) {
    if (!isAuthed(req)) return sendJson(res, 401, { success: false, error: 'נדרשת התחברות.' });
    const miss = missingConfig();
    if (miss.length) return sendJson(res, 400, { success: false, error: 'חסרים משתני סביבה: ' + miss.join(', ') });

    const apiPath = pathname.slice('/proxy'.length) + (url.search || '');
    const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE';
    const body = hasBody ? await readBody(req) : undefined;
    try {
      const apiRes = await fetch(API_BASE + apiPath, { method, headers: apiHeaders(), body });
      const text = await apiRes.text();
      const passHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
      const ra = apiRes.headers.get('retry-after');
      if (ra) passHeaders['Retry-After'] = ra;
      res.writeHead(apiRes.status, passHeaders);
      return res.end(text);
    } catch (e) {
      return sendJson(res, 502, { success: false, error: 'שגיאת תקשורת מול iStores: ' + e.message });
    }
  }

  // כל שאר הנתיבים — דורשים התחברות
  if (!isAuthed(req)) { res.writeHead(302, { Location: '/login' }); return res.end(); }
  if (pathname === '/' || pathname === '/index.html') return serveStatic(res, 'index.html');
  if (pathname === '/upload' || pathname === '/upload.html') return serveStatic(res, 'upload.html');
  if (pathname === '/sync' || pathname === '/sync.html') return serveStatic(res, 'sync.html');
  if (pathname === '/sync/semicom' || pathname === '/sync-semicom.html') return serveStatic(res, 'sync-semicom.html');
  return serveStatic(res, pathname.replace(/^\/+/, ''));
});

server.listen(PORT, () => {
  ensureDataDir();
  console.log('🔖 גרסת קוד: DEBUG-BUILD-2026-08-31-v3 (עם לוגי istores מפורטים)');
  console.log(`ComPhone Admin רץ על פורט ${PORT}`);
  const miss = missingConfig();
  if (miss.length) console.warn('אזהרה: חסרים משתני סביבה: ' + miss.join(', '));
  if (!ADMIN_PASSWORD) console.warn('אזהרה: ADMIN_PASSWORD לא הוגדר — ההתחברות לא תעבוד.');
  console.log(cfConfigured()
    ? `Cloudflare KV מחובר · גיבוי טיוטות במפתח "${DRAFTS_KEY}" · ייבוא סוכנים פעיל`
    : 'Cloudflare KV לא מוגדר — טיוטות נשמרות מקומית בלבד, וייבוא הסוכנים כבוי.');
});
