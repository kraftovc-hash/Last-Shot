'use strict';
/* Shorts & Guns — сервер.
   Один процесс делает всё: отдаёт игру (public/index.html), хранит аккаунты и сохранения,
   ведёт рейтинг и проводит PvP-дуэли в реальном времени.
   Реальное время — Server-Sent Events (сервер → игрок) + обычные POST (игрок → сервер): работает на любом бесплатном хостинге без WebSocket.
   Хранилище: Postgres, если задан DATABASE_URL (Neon/Supabase/Render — данные переживают перезапуски), иначе сервер не запустится (файл data.json — только при ALLOW_FILE_STORE=1, для локальной проверки).
   Валюта игроков (золото, ящики, гемы) лежит в таблице wallets, каждая операция пишется в журнал wallet_log:
   сервер — единственный источник правды о балансе. Настройки боя/экономики (CFG), изменённые админом, лежат в таблице settings. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');

const PORT = +process.env.PORT || 3000;
const DB_URL = process.env.DATABASE_URL || '', BOT = process.env.BOT_TOKEN || '';
const ADMINS = new Set((process.env.ADMIN_IDS || '8927761386').split(',').map(s => 'tg' + s.trim()).filter(s => s.length > 2));
const FOREVER = 4102444800000; /* «навсегда» для авто-ящиков (2100 год) */
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const ALLOW_FILE = process.env.ALLOW_FILE_STORE === '1';
const GAME = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(p => fs.existsSync(p));

/* ---------- настройки боя ---------- */
const CFG = {
  turnMs: 20000,      /* время на ход */
  shots: 5,           /* выстрелов за «Огонь» */
  crit: .12,          /* шанс крита (×2) */
  heals: 2,           /* сколько раз можно лечиться за бой */
  healPc: .2,         /* лечение, доля от макс. здоровья */
  guardMul: .5,       /* «Блок»: урон по тебе в следующем ходу врага × это */
  maxHalfTurns: 30,   /* потом победа по доле здоровья */
  queueMs: 90000,     /* ждать соперника в рейтинговой очереди */
  codeMs: 180000,     /* ждать друга по коду */
  k: 60,              /* сила кубков: при равных соперниках победа ≈ +k/2, поражение ≈ −k/2 */
  minWin: 15, minLoss: 10, /* минимум кубков за победу / потерь за поражение */
  winCr: 2, rewardCap: 15, /* награда за победу: ящики; наград за победы в день */
  clanMax: 30,        /* мест в клане */
  clanCdMin: 10,      /* после выхода из клана вступить/создать новый можно через N минут */
  chestPer: 3, chestMin: 5, /* недельный сундук клана: побед в рейтинге на каждого участника / минимум */
  chatMax: 60,        /* сообщений в чате клана хранится */
  warMinutes: 180,    /* длительность клановой войны, минут */
  warAtk: 3,          /* атак (дуэлей) на бойца за войну */
  warSize: 10,        /* максимум бойцов с каждой стороны (N на N) */
  warMinMembers: 2,   /* минимум бойцов с экипировкой, чтобы искать войну */
  ghostMs: 8000,      /* сколько ждать живого соперника в войне, потом выходит «тень» */
  capGold: 0, capCr: 0, capGems: 0 /* лимит прироста валюты, сообщаемого клиентом, за минуту (0 = без лимита). Админка: cfg capGold и т.д. */
};


/* ---------- кубки и ранги (41 ранг) ----------
   [название, значок, кубков для получения]. rt у игрока = кубки.
   Лиги: внутри лиги можно терять кубки, но ниже её первого ранга не упадёшь (LEAGUE_START — номера первых рангов лиг, с нуля). */
const RANKS = [
  ['Новобранец', '🪖', 0], ['Рядовой', '🎖', 100], ['Ефрейтор', '🎖', 200], ['Младший сержант', '🎖', 300], ['Сержант', '🎖', 400],
  ['Старший сержант', '🎖', 500], ['Старшина', '🎖', 600], ['Прапорщик', '🎖', 700], ['Младший лейтенант', '⭐', 800], ['Лейтенант', '⭐', 900],
  ['Старший лейтенант', '⭐', 1000], ['Капитан', '⭐', 1100], ['Майор', '🌟', 1200], ['Подполковник', '🌟', 1300], ['Полковник', '🌟', 1400],
  ['Бронза I', '🥉', 1600], ['Бронза II', '🥉', 1800], ['Бронза III', '🥉', 2000],
  ['Серебро I', '🥈', 2250], ['Серебро II', '🥈', 2500], ['Серебро III', '🥈', 2750],
  ['Золото I', '🥇', 3050], ['Золото II', '🥇', 3350], ['Золото III', '🥇', 3650],
  ['Платина I', '💠', 4000], ['Платина II', '💠', 4350], ['Платина III', '💠', 4700],
  ['Алмаз I', '💎', 5100], ['Алмаз II', '💎', 5500], ['Алмаз III', '💎', 5900],
  ['Элита I', '🔥', 6400], ['Элита II', '🔥', 6900], ['Элита III', '🔥', 7400],
  ['Легенда', '👑', 8000],
  ['Мастер I', '🏅', 8700], ['Мастер II', '🏅', 9400], ['Мастер III', '🏅', 10100],
  ['Чемпион', '🏆', 11000], ['Большой чемпион', '🏆', 12000], ['Королевский чемпион', '👑', 13200], ['Абсолютный чемпион', '🌌', 14500]
];
const LEAGUE_START = [0, 5, 10, 15, 18, 21, 24, 27, 30, 33, 34, 37, 38, 39, 40];
const rankOf = t => { let i = 0; while (i + 1 < RANKS.length && t >= RANKS[i + 1][2]) i++; return i };
const floorOf = t => { const i = rankOf(t); let s = 0; for (const x of LEAGUE_START) if (x <= i) s = x; return RANKS[s][2] };
const rankInfo = t => { const i = rankOf(t), r = RANKS[i], nx = RANKS[i + 1]; return { i: i + 1, n: r[0], e: r[1], at: r[2], nn: nx ? nx[0] : null, nat: nx ? nx[2] : null, max: RANKS.length } };
const rankReward = i => ({ cr: 5 + 2 * i, g: 50 * i, gems: i >= 10 ? Math.round((i - 9) * 1.5) : 0 });  /* за достижение ранга с номером i (с нуля) */

/* ---------- характеристики из сохранения (те же формулы, что в игре) ---------- */
const SL = { w: [1.6, 0, 0], hd: [0, 3, .5], b: [0, 5, 1], sh: [0, 2, .6], g: [.4, 1, 0], k: [0, 2, .3], p: [0, 3, 0], bt: [0, 2, .3], ms: [0, 1, .6], kn: [0, 1, .5], am: [.5, 0, 0], md: [.6, 0, .2] };
const RM = [1, 1.12, 1.25, 1.4, 1.6, 1.8, 2.05, 2.35, 2.7];
const STAGE_LV = [1, 8, 18, 30, 45, 65, 90, 120, 145];
const ADM_PW = 4 * 152 * RM[8];   /* админский предмет: в 4 раза сильнее лучшего обычного (ур.152 × «Божественный») */
const stageOf = lv => { let n = 0; STAGE_LV.forEach((v, i) => { if (lv >= v) n = i }); return n };
function fighterFrom(S, adm) {   /* adm — игрок админ: только ему засчитываются предметы с a:1 */
  let d = 6, hp = 50, ar = 0; const stages = [];
  for (const k in SL) {
    const it = S.it && S.it[k]; if (!it) continue;
    const A = adm && it.a, lv = A ? 152 : Math.max(1, Math.min(400, it.lv | 0)), r = A ? 8 : Math.max(0, Math.min(8, it.r | 0)), p = A ? ADM_PW : lv * RM[r], c = SL[k];
    d += p * c[0]; hp += p * c[1]; ar += p * c[2];
    const st = A ? 9 : Math.max(stageOf(lv), r); for (let i = 0; i < (k == 'w' ? 3 : 1); i++) stages.push(st);
  }
  if (!stages.length) return null;
  stages.sort((a, b) => a - b);
  return { d: Math.round(d), hp: Math.round(hp), ar: Math.round(ar), hs: stages[stages.length >> 1], pl: Math.max(1, Math.min(150, S.pl | 0)) };
}
const power = f => Math.round(f.d * 5 + f.hp / 2 + f.ar * 3);
/* публичный ид игрока для рейтинга (настоящий id, в т.ч. Telegram, наружу не отдаём) */
const pubKey = p => crypto.createHash('sha1').update('pub:' + p.id).digest('hex').slice(0, 12);

/* ---------- хранилище ---------- */
const store = { players: new Map(), dirty: new Set(), pool: null, clans: new Map(), cdirty: new Set(), wallets: new Map(), wdirty: new Set() };
async function initStore() {
  if (!DB_URL && !ALLOW_FILE) { console.error('DATABASE_URL не задан — без базы данных прогресс и валюта не сохранятся навечно. Задайте DATABASE_URL (Postgres) или, только для локальной проверки, ALLOW_FILE_STORE=1.'); process.exit(1) }
  if (DB_URL) {
    let pg; try { pg = require('pg') } catch (e) { console.error('Нужен пакет pg: выполните npm install'); process.exit(1) }
    store.pool = new pg.Pool({ connectionString: DB_URL, ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false }, max: 3 });
    await store.pool.query('create table if not exists players(id text primary key, data jsonb not null, updated timestamptz default now())');
    const r = await store.pool.query('select id, data from players');
    for (const x of r.rows) store.players.set(x.id, x.data);
    console.log('Postgres: игроков загружено', store.players.size);
    await store.pool.query('create table if not exists clans(id text primary key, data jsonb not null, updated timestamptz default now())');
    for (const x of (await store.pool.query('select id, data from clans')).rows) store.clans.set(x.id, x.data);
    /* кошельки, журнал операций, настройки */
    await store.pool.query('create table if not exists wallets(player_id text primary key, gold bigint not null default 0 check (gold >= 0), cr bigint not null default 0 check (cr >= 0), gems bigint not null default 0 check (gems >= 0), ver bigint not null default 0, updated timestamptz default now())');
    await store.pool.query('create table if not exists wallet_log(id bigserial primary key, player_id text not null, dgold bigint not null, dcr bigint not null, dgems bigint not null, gold bigint not null, cr bigint not null, gems bigint not null, why text not null, tid text, ts timestamptz default now())');
    await store.pool.query('create index if not exists wallet_log_p on wallet_log(player_id, id desc)');
    await store.pool.query('create unique index if not exists wallet_log_tid on wallet_log(player_id, tid) where tid is not null');
    await store.pool.query('create table if not exists settings(k text primary key, v jsonb not null)');
    for (const x of (await store.pool.query('select player_id, gold, cr, gems, ver from wallets')).rows) store.wallets.set(x.player_id, { g: +x.gold, c: +x.cr, m: +x.gems, v: +x.ver });
    { const r = await store.pool.query("select v from settings where k = 'cfg'"); if (r.rows[0]) for (const k in r.rows[0].v) if (k in CFG && isFinite(+r.rows[0].v[k])) CFG[k] = +r.rows[0].v[k] }
    console.log('Postgres: кошельков загружено', store.wallets.size);
  } else {
    try { const o = JSON.parse(fs.readFileSync(FILE, 'utf8')); for (const k in o) store.players.set(k, o[k]) } catch (e) { }
    try { const o = JSON.parse(fs.readFileSync(FILE + '.clans', 'utf8')); for (const k in o) store.clans.set(k, o[k]) } catch (e) { }
    try { const o = JSON.parse(fs.readFileSync(FILE + '.wallets', 'utf8')); for (const k in o) store.wallets.set(k, o[k]) } catch (e) { }
    try { const o = JSON.parse(fs.readFileSync(FILE + '.cfg', 'utf8')); for (const k in o) if (k in CFG && isFinite(+o[k])) CFG[k] = +o[k] } catch (e) { }
    console.log('Файловое хранилище', FILE, '(для постоянной работы задайте DATABASE_URL). Игроков:', store.players.size);
  }
  await migrateWallets();
  for (const c of store.clans.values()) { c.m = c.m || []; c.rq = c.rq || []; c.ch = c.ch || []; if (c.war && c.war.end < Date.now()) { c.war.end = Date.now() + 1000 } }
  console.log('Кланов:', store.clans.size);
  /* старый Эло-рейтинг (старт 1000) → кубки (старт 0), без наград за уже достигнутые ранги */
  for (const p of store.players.values()) if (!p.rv) { p.rt = Math.max(0, (p.rt | 0) - 1000); p.rv = 2; p.rk = rankOf(p.rt); touch(p) }
}
const touch = p => store.dirty.add(p.id);
let flushing = false;
async function flush() {
  if (flushing || (!store.dirty.size && !store.cdirty.size && !store.wdirty.size)) return; flushing = true;
  const ids = [...store.dirty], cids = [...store.cdirty], wf = store.wdirty.size > 0; store.dirty.clear(); store.cdirty.clear(); store.wdirty.clear();
  try {
    if (store.pool) {
      for (const id of ids) {
        try { await store.pool.query('insert into players(id, data, updated) values($1, $2, now()) on conflict(id) do update set data = $2, updated = now()', [id, JSON.stringify(store.players.get(id))]) }
        catch (e) { console.error('db:', e.message); store.dirty.add(id) }
      }
      for (const id of cids) {
        const c = store.clans.get(id);
        try { if (c) await store.pool.query('insert into clans(id, data, updated) values($1, $2, now()) on conflict(id) do update set data = $2, updated = now()', [id, JSON.stringify(c)]); else await store.pool.query('delete from clans where id = $1', [id]) }
        catch (e) { console.error('db clans:', e.message); store.cdirty.add(id) }
      }
    } else {
      if (ids.length) { fs.writeFileSync(FILE + '.tmp', JSON.stringify(Object.fromEntries(store.players))); fs.renameSync(FILE + '.tmp', FILE) }
      if (cids.length) { fs.writeFileSync(FILE + '.clans.tmp', JSON.stringify(Object.fromEntries(store.clans))); fs.renameSync(FILE + '.clans.tmp', FILE + '.clans') }
      if (wf) { fs.writeFileSync(FILE + '.wallets.tmp', JSON.stringify(Object.fromEntries(store.wallets))); fs.renameSync(FILE + '.wallets.tmp', FILE + '.wallets') }
    }
  } catch (e) { console.error('flush:', e.message); ids.forEach(i => store.dirty.add(i)); cids.forEach(i => store.cdirty.add(i)); if (wf) store.wdirty.add('*') }
  flushing = false;
}
setInterval(flush, 1000);
const bye = async () => { await flush(); process.exit(0) };
process.on('SIGTERM', bye); process.on('SIGINT', bye);

/* ---------- утилиты ---------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rnd = n => crypto.randomBytes(n).toString('hex');
const cleanName = (s, fb) => { s = String(s || '').replace(/[\u0000-\u001f<>&"'`]/g, '').trim().slice(0, 16); return s || fb };
const today = () => new Date().toISOString().slice(0, 10);
function send(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b) }
function body(req, max) {
  return new Promise((ok, no) => {
    let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > max) { no(new Error('big')); req.destroy() } else ch.push(c) });
    req.on('end', () => { try { ok(ch.length ? JSON.parse(Buffer.concat(ch).toString('utf8')) : {}) } catch (e) { no(e) } });
    req.on('error', no);
  });
}
function authOf(a) {
  if (!a) return null; const i = a.indexOf(':'); if (i < 1) return null;
  const p = store.players.get(a.slice(0, i)); if (!p) return null;
  const h = Buffer.from(sha(a.slice(i + 1))), t = Buffer.from(p.th);
  return h.length === t.length && crypto.timingSafeEqual(h, t) ? p : null;
}
const reqAuth = (req, url) => authOf((req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('a'));
const hits = new Map();
const limited = (ip, key, max, ms) => { const k = key + ip, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < ms); a.push(now); hits.set(k, a); return a.length > max };
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.length || now - a[a.length - 1] > 3600e3) hits.delete(k) }, 600e3);

/* ---------- SSE: живые соединения игроков ---------- */
const conns = new Map(); /* id -> Set<res> */
function emit(id, ev, data) { const s = conns.get(id); if (!s) return; const m = 'event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n'; for (const r of s) r.write(m) }
const online = id => (conns.get(id) || new Set()).size > 0;
setInterval(() => { for (const s of conns.values()) for (const r of s) r.write(': hb\n\n') }, 20000);

/* ---------- кошелёк: валюта игрока хранится в БД, сервер — единственный источник правды ----------
   g — золото, c — ящики, m — гемы, v — версия (растёт с каждой операцией).
   Любое изменение — транзакция Postgres (update ... where баланс не уйдёт в минус) + строка в wallet_log.
   Операции одного игрока идут строго по очереди; повтор запроса с тем же tid второй раз не применяется (уникальный индекс в БД). */
const WMAX = 1e13, WSTART = { g: 0, c: 15, m: 0 };
const wlPub = w => ({ g: w.g, c: w.c, m: w.m, v: w.v });
const wcl = x => Math.max(-WMAX, Math.min(WMAX, Math.round(+x || 0)));
const wlLocks = new Map();
function wlRun(id, fn) {
  const prev = wlLocks.get(id) || Promise.resolve(), run = prev.then(fn), tail = run.catch(() => { });
  wlLocks.set(id, tail); tail.then(() => { if (wlLocks.get(id) === tail) wlLocks.delete(id) });
  return run;
}
async function wlInsert(id, w) {
  if (store.pool) await store.pool.query('insert into wallets(player_id, gold, cr, gems, ver) values($1, $2, $3, $4, $5) on conflict(player_id) do nothing', [id, w.g, w.c, w.m, w.v]);
  else store.wdirty.add(id);
}
async function newWallet(id) { const w = { ...WSTART, v: 0 }; store.wallets.set(id, w); try { await wlInsert(id, w) } catch (e) { console.error('wallet:', e.message) } return w }
/* d — {g,c,m} изменения (можно функцию от текущего кошелька); pristineOnly — применить, только если кошелёк ещё не менялся (первичный импорт) */
function walletTx(p, d, why, tid, pristineOnly) {
  return wlRun(p.id, async () => {
    let w = store.wallets.get(p.id); if (!w) w = await newWallet(p.id);
    if (tid && w.seen && w.seen.includes(tid)) return { ok: 1, dup: 1, w: wlPub(w) };
    if (pristineOnly && w.v !== 0) return { ok: 1, skipped: 1, w: wlPub(w) };
    const q = typeof d === 'function' ? d(w) : d;
    let dg = wcl(q.g), dc = wcl(q.c), dm = wcl(q.m);
    if (w.g + dg < 0 || w.c + dc < 0 || w.m + dm < 0) return { err: 'funds', w: wlPub(w) };
    dg = Math.min(WMAX, w.g + dg) - w.g; dc = Math.min(WMAX, w.c + dc) - w.c; dm = Math.min(WMAX, w.m + dm) - w.m;
    if (!dg && !dc && !dm) return { ok: 1, w: wlPub(w) };
    let nw;
    if (store.pool) {
      const cl = await store.pool.connect();
      try {
        await cl.query('begin');
        await cl.query('insert into wallets(player_id, gold, cr, gems, ver) values($1, $2, $3, $4, $5) on conflict(player_id) do nothing', [p.id, w.g, w.c, w.m, w.v]);
        const r = await cl.query('update wallets set gold = gold + $2, cr = cr + $3, gems = gems + $4, ver = ver + 1, updated = now() where player_id = $1 and gold + $2 >= 0 and cr + $3 >= 0 and gems + $4 >= 0 returning gold, cr, gems, ver', [p.id, dg, dc, dm]);
        if (!r.rows.length) { await cl.query('rollback'); return { err: 'funds', w: wlPub(w) } }
        const x = r.rows[0];
        await cl.query('insert into wallet_log(player_id, dgold, dcr, dgems, gold, cr, gems, why, tid) values($1, $2, $3, $4, $5, $6, $7, $8, $9)', [p.id, dg, dc, dm, x.gold, x.cr, x.gems, String(why).slice(0, 40), tid || null]);
        await cl.query('commit');
        nw = { g: +x.gold, c: +x.cr, m: +x.gems, v: +x.ver };
      } catch (e) {
        try { await cl.query('rollback') } catch (_) { }
        if (e.code === '23505' && tid) return { ok: 1, dup: 1, w: wlPub(w) };   /* этот tid уже применён (например, до перезапуска сервера) */
        console.error('wallet:', e.message); return { err: 'db', w: wlPub(w) };
      } finally { cl.release() }
    } else { nw = { g: w.g + dg, c: w.c + dc, m: w.m + dm, v: w.v + 1 }; store.wdirty.add(p.id) }
    nw.seen = (w.seen || []).concat(tid ? [tid] : []).slice(-50);
    store.wallets.set(p.id, nw);
    return { ok: 1, w: wlPub(nw) };
  });
}
/* награда от сервера (бои, клан, ранги): кладётся в кошелёк на сервере и сообщается клиенту событием wallet; при сбое базы повторяется */
function credit(p, d, why) {
  if (!d.g && !d.c && !d.m) return Promise.resolve();
  const tid = 'srv:' + rnd(6);
  const go = async n => {
    const r = await walletTx(p, d, why, tid);
    if (r.err === 'db' && n < 8) { await new Promise(ok => setTimeout(ok, 1000 * (n + 1))); return go(n + 1) }
    if (r.ok && !r.dup) emit(p.id, 'wallet', { ...r.w, why });
    return r;
  };
  return go(0).catch(e => console.error('credit:', e.message));
}
/* необязательный лимит на прирост валюты, который сообщает клиент (PvE-бои идут в браузере; 0 в CFG = выключено) */
const earnWin = new Map();
function earnLimit(p, d) {
  const caps = { g: CFG.capGold, c: CFG.capCr, m: CFG.capGems }, now = Date.now();
  let e = earnWin.get(p.id); if (!e || now - e.t > 60e3) { e = { t: now, g: 0, c: 0, m: 0 }; earnWin.set(p.id, e) }
  for (const k of ['g', 'c', 'm']) if (d[k] > 0 && caps[k] > 0 && e[k] + d[k] > caps[k]) return true;
  for (const k of ['g', 'c', 'm']) if (d[k] > 0) e[k] += d[k];
  return false;
}
setInterval(() => { const now = Date.now(); for (const [k, e] of earnWin) if (now - e.t > 120e3) earnWin.delete(k) }, 300e3);
/* сохранение игрока не содержит валюту: клиент не может изменить баланс через /api/save. Наружу валюта подставляется из кошелька */
const CURKEYS = ['gold', 'cr', 'gems', 'wb', 'wp', 'wv'];
function saveOut(p) {
  if (!p.save) return p.save;
  const w = store.wallets.get(p.id); if (!w) return p.save;
  let S; try { S = JSON.parse(p.save) } catch (e) { return p.save }
  if (!S || typeof S !== 'object') return p.save;
  S.gold = w.g; S.cr = w.c; S.gems = w.m; S.wb = { g: w.g, c: w.c, m: w.m }; S.wv = w.v; delete S.wp;
  return JSON.stringify(S);
}
/* игроки, созданные до появления кошельков: стартовый баланс берётся из их последнего сохранения (один раз) */
async function migrateWallets() {
  let n = 0;
  for (const p of store.players.values()) {
    if (store.wallets.has(p.id)) continue;
    let S = null; try { S = JSON.parse(p.save || 'null') } catch (e) { }
    const t = (x, d) => Number.isFinite(+x) && x !== null && x !== '' ? Math.max(0, Math.min(1e12, Math.round(+x))) : d;
    const w = S && typeof S === 'object' ? { g: t(S.gold, 0), c: t(S.cr, WSTART.c), m: t(S.gems, 0), v: 1 } : { ...WSTART, v: 0 };
    store.wallets.set(p.id, w);
    try {
      await wlInsert(p.id, w);
      if (store.pool && w.v) await store.pool.query("insert into wallet_log(player_id, dgold, dcr, dgems, gold, cr, gems, why) values($1, $2, $3, $4, $2, $3, $4, 'migrate')", [p.id, w.g, w.c, w.m]);
    } catch (e) { console.error('migrate:', e.message) }
    n++;
  }
  if (n) console.log('Кошельков создано из старых сохранений:', n);
}
async function saveCfg() {
  try {
    if (store.pool) await store.pool.query("insert into settings(k, v) values('cfg', $1) on conflict(k) do update set v = $1", [JSON.stringify(CFG)]);
    else fs.writeFileSync(FILE + '.cfg', JSON.stringify(CFG));
  } catch (e) { console.error('cfg:', e.message) }
}

/* ---------- PvP-дуэли ---------- */
const rooms = new Map(), inRoom = new Map(), queues = new Map();
const pub = p => ({ id: p.id, nm: p.name, ...(p.f || {}), rt: p.rt, w: p.w, l: p.l });
function snap(room, i) {
  const o = 1 - i, P = room.ids.map(id => store.players.get(id));
  return {
    room: room.id, you: i, friendly: room.friendly, hp: room.hp.slice(), max: room.max.slice(), heals: room.heals.slice(), guard: room.guard.slice(),
    turn: room.turn, ms: Math.max(0, room.deadline - Date.now()), cap: CFG.turnMs,
    me: { name: P[i].name, ...room.fr[i], rt: P[i].rt, rk: rankInfo(P[i].rt) }, opp: { name: P[o].name, ...room.fr[o], rt: P[o].rt, rk: rankInfo(P[o].rt) }
  };
}
function startRoom(a, b, friendly, war, ghost) {
  ghost = ghost == null ? -1 : ghost;   /* ghost — индекс «тени»: бойца, за которого играет сервер (бои клановой войны) */
  for (const p of [a, b].filter((_, i) => i !== ghost)) { for (const q of queues.values()) for (let i = q.length - 1; i >= 0; i--) if (q[i].id === p.id) { clearTimeout(q[i].tm); q.splice(i, 1) } leaveWarQ(p.id) }
  const room = { id: rnd(6), ids: [a.id, b.id], fr: [a.f, b.f], hp: [a.f.hp, b.f.hp], max: [a.f.hp, b.f.hp], heals: [CFG.heals, CFG.heals], guard: [0, 0], turn: Math.random() < .5 ? 0 : 1, half: 0, friendly, war: war || null, ghost, over: false, timer: null, deadline: 0 };
  rooms.set(room.id, room); if (ghost !== 0) inRoom.set(a.id, room); if (ghost !== 1) inRoom.set(b.id, room);
  armTimer(room);
  if (ghost !== 0) emit(a.id, 'match', snap(room, 0)); if (ghost !== 1) emit(b.id, 'match', snap(room, 1));
}
function armTimer(room) {
  clearTimeout(room.timer); room.deadline = Date.now() + CFG.turnMs;
  if (room.ghost === room.turn) { room.timer = setTimeout(() => ghostMove(room), 1000 + Math.random() * 1400); return }
  room.timer = setTimeout(() => {
    if (room.over) return; const id = room.ids[room.turn];
    if (!online(id)) return finish(room, 1 - room.turn, 'leave');          /* ушёл из игры — поражение */
    act(room, room.turn, 'fire', true);                                    /* не успел — автоматический выстрел */
  }, CFG.turnMs + 300);
}
function ghostMove(room) {   /* ход «тени»: лечится при низком здоровье, иногда блок, иначе огонь */
  if (room.over) return; const i = room.turn, k = room.hp[i] < room.max[i] * .3 && room.heals[i] > 0 ? 'heal' : Math.random() < .15 ? 'guard' : 'fire';
  act(room, i, k, false);
}
function act(room, i, kind, auto) {
  if (room.over || room.turn !== i) return false;
  const o = 1 - i, me = room.fr[i], ev = { room: room.id, by: i, act: kind, auto: !!auto };
  if (kind === 'fire') {
    const shots = []; let tot = 0;
    for (let s = 0; s < CFG.shots; s++) { const c = Math.random() < CFG.crit, v = me.d * (.9 + Math.random() * .2) * (c ? 2 : 1); tot += v; shots.push(c ? 1 : 0) }
    let d = Math.max(1, Math.round(tot * 100 / (100 + room.fr[o].ar * 3)));
    if (room.guard[o]) { d = Math.max(1, Math.round(d * CFG.guardMul)); room.guard[o] = 0; ev.blocked = 1 }
    room.hp[o] = Math.max(0, room.hp[o] - d); ev.dmg = d; ev.crits = shots.reduce((a, b) => a + b, 0);
  } else if (kind === 'guard') { room.guard[i] = 1 }
  else if (kind === 'heal') {
    if (room.heals[i] <= 0) return false;
    const h = Math.min(room.max[i] - room.hp[i], Math.round(room.max[i] * CFG.healPc)); room.heals[i]--; room.hp[i] += h; ev.heal = h;
  } else return false;
  room.half++; room.turn = o;
  Object.assign(ev, { hp: room.hp.slice(), heals: room.heals.slice(), guard: room.guard.slice(), turn: room.turn });
  if (room.hp[o] <= 0) { ev.turn = -1; emitBoth(room, 'turn', ev); return finish(room, i, 'ko') }
  if (room.half >= CFG.maxHalfTurns) { emitBoth(room, 'turn', Object.assign(ev, { turn: -1 })); const a = room.hp[0] / room.max[0], b = room.hp[1] / room.max[1]; return finish(room, a === b ? -1 : a > b ? 0 : 1, 'time') }
  armTimer(room); ev.ms = CFG.turnMs; emitBoth(room, 'turn', ev); return true;
}
const emitBoth = (room, ev, d) => room.ids.forEach((id, i) => { if (i !== room.ghost) emit(id, ev, d) });
function finish(room, win, reason) {
  if (room.over) return true; room.over = true; clearTimeout(room.timer);
  const P = room.ids.map(id => store.players.get(id));
  const res = [0, 1].map(i => ({ room: room.id, win: win === i ? 1 : win < 0 ? -1 : 0, reason, hp: room.hp.slice(), friendly: room.friendly, rt: P[i].rt, rk: rankInfo(P[i].rt), w: P[i].w, l: P[i].l, delta: 0, reward: null }));
  if (!room.friendly && win >= 0) {
    const ra = P[0].rt, rb = P[1].rt, df = Math.max(-600, Math.min(600, rb - ra)), ea = 1 / (1 + Math.pow(10, df / 400));
    for (let i = 0; i < 2; i++) {
      const p = P[i], e = i === 0 ? ea : 1 - ea, old = p.rt, won = win === i;
      if (won) p.rt = old + Math.max(CFG.minWin, Math.round(CFG.k * (1 - e)));
      else p.rt = Math.max(floorOf(old), old - Math.max(CFG.minLoss, Math.round(CFG.k * e)));   /* защита лиги: ниже её начала не падаем */
      if (won) { p.w++; clanWin(p) } else p.l++;
      res[i].delta = p.rt - old;
      const ri = rankOf(p.rt);
      if ((p.rk | 0) < ri) {   /* новый ранг — награда за каждый впервые достигнутый */
        let cr = 0, g = 0, gems = 0;
        for (let k = (p.rk | 0) + 1; k <= ri; k++) { const w = rankReward(k); cr += w.cr; g += w.g; gems += w.gems }
        p.rk = ri; res[i].rankUp = { n: RANKS[ri][0], e: RANKS[ri][1], cr, g, gems };
      }
      if (won) {
        if (p.day !== today()) { p.day = today(); p.n = 0 }
        if (p.n < CFG.rewardCap) { p.n++; const op = room.fr[1 - i]; res[i].reward = { cr: CFG.winCr + (power(op) > power(room.fr[i]) * 1.2 ? 1 : 0), g: Math.ceil(10 + power(op) / 10) } }
      }
      res[i].rt = p.rt; res[i].w = p.w; res[i].l = p.l; res[i].rk = rankInfo(p.rt); touch(p);
      { const R = res[i].reward, U = res[i].rankUp; if (R || U) credit(p, { g: (R ? R.g : 0) + (U ? U.g : 0), c: (R ? R.cr : 0) + (U ? U.cr : 0), m: U ? U.gems : 0 }, 'pvp') }
    }
  }
  if (room.war) warDone(room, win, P, res);
  room.ids.forEach((id, i) => { if (i === room.ghost) return; emit(id, 'end', res[i]); inRoom.delete(id) });
  rooms.delete(room.id); return true;
}

function joinQueue(p, code) {
  if (!p.f) return { err: 'Сначала надень предмет — подожди секунду, пока прогресс отправится на сервер' };
  if (inRoom.has(p.id)) return { ok: 1, state: 'room' };
  leaveQueue(p.id);
  const key = code ? 'c:' + code : 'rank', q = queues.get(key) || []; queues.set(key, q);
  let best = -1, bd = 1e9;
  q.forEach((e, i) => { if (e.id === p.id) return; const o = store.players.get(e.id); if (!o || !online(e.id)) return; const d = code ? 0 : Math.abs(o.rt - p.rt); if (d < bd) { bd = d; best = i } });
  if (best >= 0) { const o = store.players.get(q[best].id); startRoom(o, p, !!code); return { ok: 1, state: 'match' } }
  const ms = code ? CFG.codeMs : CFG.queueMs, e = { id: p.id, tm: setTimeout(() => { const j = q.indexOf(e); if (j >= 0) { q.splice(j, 1); emit(p.id, 'qtimeout', {}) } }, ms) };
  q.push(e); emit(p.id, 'queued', { key: code || '', ms });
  return { ok: 1, state: 'queued' };
}
function leaveQueue(id) { for (const q of queues.values()) for (let i = q.length - 1; i >= 0; i--) if (q[i].id === id) { clearTimeout(q[i].tm); q.splice(i, 1) } leaveWarQ(id) }

/* ---------- кланы ----------
   Клан: { id, nm, tag, e, d, open, min, m:[{id,r,j,wp}], rq:[{id,t}], ch:[сообщения], tw (опыт), ww/wl (войны), wk/cw/cwAt (недельный сундук), war, last }
   r: 0 участник, 1 старейшина, 2 глава. Золото лежит на телефоне, поэтому создание клана бесплатное, а награды выдаёт сервер «суммой» — клиент добавляет их себе (как награды за бои). */
const CEMB = ['🛡', '⚔', '🐺', '🦅', '🔥', '💀', '👑', '🐉', '🦁', '⚡', '🌪', '☠'];
const warQ = new Set(), warWait = new Map();   /* warQ — кланы, ищущие войну; warWait — бойцы, ждущие дуэль в войне */
let ctopC = null;
const touchC = c => store.cdirty.add(c.id);
const weekKey = () => { const t = new Date(), d = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()); return new Date(d - ((new Date(d).getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10) };
const clanOf = p => p && p.clan ? store.clans.get(p.clan) || null : null;
const memOf = (c, id) => c.m.find(x => x.id === id);
const clanCp = c => c.m.reduce((s, x) => { const p = store.players.get(x.id); return s + (p ? p.rt : 0) }, 0);
const clanLvl = c => 1 + Math.floor(Math.sqrt((c.tw | 0) / 5));
const scale = (r, c) => { const k = 1 + (clanLvl(c) - 1) * .1; return { cr: Math.round(r.cr * k), g: Math.round(r.g * k), gems: Math.round(r.gems * k) } };
const CHEST = { cr: 3, g: 250, gems: 3 }, WARRW = { '1': { cr: 4, g: 400, gems: 5 }, '0': { cr: 2, g: 150, gems: 2 }, '-1': { cr: 1, g: 100, gems: 0 } };
const chestGoal = c => Math.max(CFG.chestMin, CFG.chestPer * c.m.length);
const cdLeft = p => p.cl ? Math.max(0, p.cl + CFG.clanCdMin * 60e3 - Date.now()) : 0;
const ctag = p => { const c = clanOf(p); return c ? c.tag : '' };
const clanBrief = p => { const c = clanOf(p); return c ? { id: c.id, nm: c.nm, tag: c.tag, e: c.e } : null };
const toClan = (c, ev, d) => { for (const x of c.m) emit(x.id, ev, d) };
const toMods = (c, ev, d) => { for (const x of c.m) if (x.r >= 1) emit(x.id, ev, d) };
const clanTop = () => {
  if (!ctopC || Date.now() - ctopC.t > 5000) ctopC = { t: Date.now(), l: [...store.clans.values()].map(c => ({ id: c.id, cp: clanCp(c), c })).sort((a, b) => b.cp - a.cp || (b.c.tw | 0) - (a.c.tw | 0) || a.c.created - b.c.created) };
  return ctopC.l;
};
const cv = c => { const l = clanTop(), i = l.findIndex(x => x.id === c.id); return { id: c.id, nm: c.nm, tag: c.tag, e: c.e, d: c.d || '', open: c.open ? 1 : 0, min: c.min | 0, lv: clanLvl(c), cp: i >= 0 ? l[i].cp : clanCp(c), mc: c.m.length, max: CFG.clanMax, tw: c.tw | 0, ww: c.ww | 0, wl: c.wl | 0, n: i + 1 } };
const memView = (x, myId) => { const p = store.players.get(x.id); return p ? { u: pubKey(p), nm: p.name, r: x.r, rt: p.rt, rk: rankInfo(p.rt), pw: p.f ? power(p.f) : 0, on: online(p.id) ? 1 : 0, wp: x.wp | 0, me: p.id === myId ? 1 : 0 } : null };
const descOf = s => String(s || '').replace(/[\u0000-\u001f<>&"'`]/g, '').trim().slice(0, 60);
function rollWeek(c) { const k = weekKey(); if (c.wk !== k) { c.wk = k; c.cw = 0; c.cwAt = 0; for (const x of c.m) x.wp = 0; touchC(c) } }
function clanWin(p) {   /* победа игрока в рейтинговом бою — очко недельного сундука клана */
  const c = clanOf(p); if (!c) return; rollWeek(c); const x = memOf(c, p.id); if (!x) return;
  x.wp = (x.wp | 0) + 1; c.tw = (c.tw | 0) + 1; c.cw++;
  if (c.cw === chestGoal(c)) { c.cwAt = Date.now(); toClan(c, 'cinfo', { text: '🎁 Недельный сундук клана собран — забирай награду!' }) }
  touchC(c);
}
function addMem(c, p, r) {
  c.m.push({ id: p.id, r: r | 0, j: Date.now(), wp: 0 }); p.clan = c.id; p.cl = Date.now(); touch(p);
  for (const o of store.clans.values()) if (o.rq.some(x => x.id === p.id)) { o.rq = o.rq.filter(x => x.id !== p.id); touchC(o) }
  touchC(c); ctopC = null;
}
function dropMem(c, id) {
  c.m = c.m.filter(x => x.id !== id); const p = store.players.get(id);
  if (p) { p.clan = ''; p.cl = Date.now(); touch(p) }
  leaveWarQ(id); touchC(c); ctopC = null;
}
function delClan(c) { warQ.delete(c.id); store.clans.delete(c.id); touchC(c); ctopC = null }
function fixLead(c) {
  if (!c.m.length) return delClan(c);
  if (!c.m.some(x => x.r === 2)) { const n = c.m.filter(x => x.r === 1).sort((a, b) => a.j - b.j)[0] || [...c.m].sort((a, b) => a.j - b.j)[0]; n.r = 2; const p = store.players.get(n.id); if (p) emit(p.id, 'cinfo', { text: '👑 Теперь ты глава клана' }) }
  touchC(c);
}

/* ---------- клановые войны: N на N, дуэли в реальном времени ----------
   Клан (глава/старейшина) встаёт в поиск → находится соперник → собирается состав N на N (сильнейшие бойцы).
   У каждого бойца CFG.warAtk атак. Атака — живая дуэль с бойцом вражеского клана, который тоже сейчас ищет бой;
   если за CFG.ghostMs никого нет — выходит «тень» врага (его снаряжение, играет сервер), чтобы война не простаивала.
   Победа в дуэли = 1 очко своему клану (если «тень» победила — очко клану врага). Через CFG.warMinutes побеждает клан с бо́льшим счётом. */
const warEligible = c => c.m.filter(x => { const p = store.players.get(x.id); return p && p.f && !p.ban }).length;
const rosterOf = (c, n) => c.m.map(x => store.players.get(x.id)).filter(p => p && p.f && !p.ban).sort((a, b) => power(b.f) - power(a.f)).slice(0, n).map(p => p.id);
function tryWar(c) {
  if (c.war || !warQ.has(c.id)) return;
  let best = null;
  for (const id of warQ) {
    if (id === c.id) continue; const o = store.clans.get(id);
    if (!o || o.war || warEligible(o) < CFG.warMinMembers) { if (!o || o.war) warQ.delete(id); continue }
    const d = Math.abs(clanCp(o) - clanCp(c)); if (!best || d < best.d) best = { o, d };
  }
  if (best) startWar(c, best.o);
}
function startWar(a, b) {
  warQ.delete(a.id); warQ.delete(b.id);
  const n = Math.max(1, Math.min(CFG.warSize, warEligible(a), warEligible(b))), id = rnd(4), end = Date.now() + CFG.warMinutes * 60e3, ra = rosterOf(a, n), rb = rosterOf(b, n);
  a.war = { id, vs: b.id, r: ra, rv: rb, p: 0, vp: 0, end, atk: {}, mp: {} };
  b.war = { id, vs: a.id, r: rb, rv: ra, p: 0, vp: 0, end, atk: {}, mp: {} };
  touchC(a); touchC(b);
  toClan(a, 'cinfo', { text: '⚔ Война против «' + b.nm + '» началась!' }); toClan(b, 'cinfo', { text: '⚔ Война против «' + a.nm + '» началась!' });
}
function endWar(c) {
  const w = c.war; if (!w) return; const o = store.clans.get(w.vs), win = !o ? 1 : w.p > w.vp ? 1 : w.p < w.vp ? -1 : 0;
  c.war = null; for (const [k, l] of warWait) if (k === w.id) { for (const e of l) clearTimeout(e.tm); warWait.delete(k) }
  c.last = { id: w.id, win, p: w.p, vp: w.vp, vs: o ? o.nm : '—', vt: o ? o.tag : '', ok: Object.keys(w.atk).filter(id => w.atk[id] > 0), t: Date.now() };
  if (win > 0) { c.ww = (c.ww | 0) + 1; c.tw = (c.tw | 0) + 10 } else if (win < 0) c.wl = (c.wl | 0) + 1; else c.tw = (c.tw | 0) + 3;
  touchC(c); ctopC = null;
  toClan(c, 'cinfo', { text: '🏁 Война окончена: ' + (win > 0 ? 'победа! ' : win < 0 ? 'поражение. ' : 'ничья. ') + w.p + ':' + w.vp + ' — забери награду в клане' });
}
function leaveWarQ(id) { for (const [k, l] of warWait) { for (let i = l.length - 1; i >= 0; i--) if (l[i].id === id) { clearTimeout(l[i].tm); l.splice(i, 1) } if (!l.length) warWait.delete(k) } }
function warFight(me, c) {
  const w = c.war;
  if (!w || Date.now() >= w.end) return { err: 'Сейчас нет войны' };
  if (!w.r.includes(me.id)) return { err: 'Тебя нет в составе этой войны' };
  if (!me.f) return { err: 'Сначала надень предмет — подожди секунду, пока прогресс отправится на сервер' };
  if ((w.atk[me.id] | 0) >= CFG.warAtk) return { err: 'Атаки закончились' };
  if (inRoom.has(me.id)) return { ok: 1, state: 'room' };
  leaveQueue(me.id);
  const list = warWait.get(w.id) || []; warWait.set(w.id, list);
  const j = list.findIndex(e => e.cl !== c.id && online(e.id) && !inRoom.has(e.id));
  if (j >= 0) { const e = list[j], o = store.players.get(e.id); clearTimeout(e.tm); list.splice(j, 1); startRoom(o, me, true, { id: w.id, cl: [o.clan, me.clan] }); return { ok: 1, state: 'match' } }
  const e = { id: me.id, cl: c.id, tm: null };
  e.tm = setTimeout(() => { const k = list.indexOf(e); if (k < 0) return; list.splice(k, 1); ghostFight(me) }, CFG.ghostMs);
  list.push(e); return { ok: 1, state: 'queued', ms: CFG.ghostMs };
}
function ghostFight(me) {
  const c = clanOf(me), w = c && c.war; if (!w || !online(me.id) || inRoom.has(me.id) || Date.now() >= w.end) return;
  const pool = w.rv.map(id => store.players.get(id)).filter(p => p && p.f && !p.ban && p.clan === w.vs), off = pool.filter(p => !online(p.id)), L = off.length ? off : pool;
  if (!L.length) return emit(me.id, 'cinfo', { text: 'Некого атаковать — попробуй позже' });
  startRoom(me, L[Math.floor(Math.random() * L.length)], true, { id: w.id, cl: [me.clan, w.vs] }, 1);
}
function warDone(room, win, P, res) {   /* вызывается из finish() для боёв войны */
  const W = room.war, cl = W.cl.map(id => store.clans.get(id)), live = cl.every(c => c && c.war && c.war.id === W.id);
  if (live) {
    [0, 1].forEach(i => { if (i !== room.ghost) { const w = cl[i].war; w.atk[P[i].id] = (w.atk[P[i].id] | 0) + 1 } });
    if (win >= 0) { const a = cl[win], b = cl[1 - win]; a.war.p++; b.war.vp++; if (win !== room.ghost) a.war.mp[P[win].id] = (a.war.mp[P[win].id] | 0) + 1 }
    cl.forEach(c => { touchC(c); toClan(c, 'cwar', {}) });
  }
  [0, 1].forEach(i => { res[i].war = live ? { p: cl[i].war.p, vp: cl[i].war.vp } : { p: 0, vp: 0 } });
}
setInterval(() => {
  const now = Date.now();
  for (const c of [...store.clans.values()]) if (c.war && (now >= c.war.end || !store.clans.has(c.war.vs))) endWar(c);
  for (const id of [...warQ]) { const c = store.clans.get(id); if (!c || c.war) warQ.delete(id) }
}, 15000);
function warView(c, me) {
  const w = c.war; if (!w) return null;
  const o = store.clans.get(w.vs), ow = o && o.war && o.war.id === w.id ? o.war : null, list = warWait.get(w.id) || [];
  const side = (ids, atk, mp) => ids.map(id => { const p = store.players.get(id); return p ? { u: pubKey(p), nm: p.name, pw: p.f ? power(p.f) : 0, on: online(id) ? 1 : 0, a: atk[id] | 0, pt: mp[id] | 0, me: id === me.id ? 1 : 0 } : null }).filter(Boolean);
  const inn = !!memOf(c, me.id) && w.r.includes(me.id);
  return { ms: Math.max(0, w.end - Date.now()), p: w.p, vp: w.vp, vs: o ? { nm: o.nm, tag: o.tag, e: o.e } : { nm: '—', tag: '', e: '🛡' }, a: side(w.r, w.atk, w.mp), b: side(w.rv, ow ? ow.atk : {}, ow ? ow.mp : {}), in: inn ? 1 : 0, left: inn ? Math.max(0, CFG.warAtk - (w.atk[me.id] | 0)) : 0, q: list.some(e => e.id === me.id) ? 1 : 0, max: CFG.warAtk };
}

/* ---------- API кланов: POST /api/clan {cmd, ...} → [код, объект] ---------- */
function clanApi(me, b, ip) {
  const bad = (m, k) => [k || 400, { err: m }], ok = o => [200, o || { ok: 1 }], cmd = String(b.cmd || '');
  const c = clanOf(me); if (c) rollWeek(c);
  const mm = c ? memOf(c, me.id) : null, role = mm ? mm.r : -1, mod = role >= 1, lead = role === 2;
  const pick = (list, u) => list.find(x => { const p = store.players.get(x.id); return p && pubKey(p) === String(u) });

  if (cmd === 'top') return ok({ rows: clanTop().slice(0, 50).map(x => cv(x.c)), me: c ? cv(c) : null });
  if (cmd === 'list') {
    const s = String(b.q || '').toLowerCase().trim();
    return ok({ rows: clanTop().filter(x => !s || x.c.nm.toLowerCase().includes(s) || x.c.tag.toLowerCase() === s).slice(0, 30).map(x => cv(x.c)) });
  }
  if (cmd === 'view') {
    const t = store.clans.get(String(b.id)); if (!t) return bad('Клан не найден', 404);
    return ok({ c: cv(t), m: t.m.map(x => memView(x, me.id)).filter(Boolean).sort((x, y) => y.r - x.r || y.rt - x.rt), mine: c && c.id === t.id ? 1 : 0, pend: t.rq.some(x => x.id === me.id) ? 1 : 0 });
  }
  if (cmd === 'create') {
    if (c) return bad('Ты уже в клане');
    if (limited(ip, 'cnew', 5, 3600e3)) return bad('Слишком часто — попробуй позже', 429);
    const cd = cdLeft(me); if (cd) return bad('Подожди ' + Math.ceil(cd / 60000) + ' мин. после выхода из клана');
    const nm = String(b.nm || '').replace(/[^\p{L}\p{N} _\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16), tag = String(b.tag || '').toUpperCase().replace(/[^A-Z0-9А-Я]/g, '').slice(0, 4);
    if (nm.length < 3) return bad('Название: от 3 до 16 символов');
    if (tag.length < 2) return bad('Тег: от 2 до 4 букв или цифр');
    for (const o of store.clans.values()) { if (o.nm.toLowerCase() === nm.toLowerCase()) return bad('Такое название уже занято'); if (o.tag === tag) return bad('Такой тег уже занят') }
    const t = { id: 'c' + rnd(4), nm, tag, e: CEMB.includes(b.e) ? b.e : CEMB[0], d: descOf(b.d), open: b.open === false || b.open === 0 ? 0 : 1, min: Math.max(0, Math.min(20000, b.min | 0)), m: [], rq: [], ch: [], tw: 0, ww: 0, wl: 0, wk: weekKey(), cw: 0, cwAt: 0, war: null, last: null, created: Date.now() };
    store.clans.set(t.id, t); addMem(t, me, 2); return ok({ id: t.id });
  }
  if (cmd === 'join') {
    const t = store.clans.get(String(b.id)); if (!t) return bad('Клан не найден', 404);
    if (c) return bad('Ты уже в клане');
    const cd = cdLeft(me); if (cd) return bad('Подожди ' + Math.ceil(cd / 60000) + ' мин. после выхода из клана');
    if (t.m.length >= CFG.clanMax) return bad('Клан заполнен');
    if (me.rt < (t.min | 0)) return bad('Нужно минимум ' + t.min + ' 🏆');
    if (t.open) { addMem(t, me, 0); toClan(t, 'cinfo', { text: '👋 В клан вступил ' + me.name }); return ok({ joined: 1 }) }
    if (t.rq.some(x => x.id === me.id)) return bad('Заявка уже отправлена');
    if (t.rq.length >= 30) return bad('У клана слишком много заявок');
    t.rq.push({ id: me.id, t: Date.now() }); touchC(t); toMods(t, 'cinfo', { text: '📨 Новая заявка в клан: ' + me.name }); return ok({ sent: 1 });
  }
  if (cmd === 'cancelreq') { const t = store.clans.get(String(b.id)); if (t) { t.rq = t.rq.filter(x => x.id !== me.id); touchC(t) } return ok() }
  if (cmd === 'state') {
    if (!c) return ok({ c: null, cd: cdLeft(me), req: [...store.clans.values()].filter(t => t.rq.some(x => x.id === me.id)).map(cv) });
    const g = chestGoal(c); if (c.cw >= g && !c.cwAt) { c.cwAt = Date.now(); touchC(c) }
    const can = c.cw >= g && mm.j <= c.cwAt && me.ck !== c.wk, L = c.last;
    return ok({
      c: cv(c), role, chest: { cw: c.cw, goal: g, ok: can ? 1 : 0, got: me.ck === c.wk ? 1 : 0, rw: scale(CHEST, c) }, war: warView(c, me), wq: warQ.has(c.id) ? 1 : 0, rq: mod ? c.rq.length : 0,
      last: L ? { win: L.win, p: L.p, vp: L.vp, vs: L.vs, vt: L.vt, ok: L.ok.includes(me.id) && me.wc !== L.id ? 1 : 0, rw: scale(WARRW[L.win], c) } : null
    });
  }
  if (!c || !mm) return bad('Ты не в клане');

  if (cmd === 'members') return ok({ role, m: c.m.map(x => memView(x, me.id)).filter(Boolean).sort((x, y) => y.r - x.r || y.rt - x.rt), rq: mod ? c.rq.map(x => { const p = store.players.get(x.id); return p ? { u: pubKey(p), nm: p.name, rt: p.rt, rk: rankInfo(p.rt), pw: p.f ? power(p.f) : 0 } : null }).filter(Boolean) : [] });
  if (cmd === 'msgs') return ok({ m: c.ch || [], me: pubKey(me) });
  if (cmd === 'chat') {
    const tx = String(b.tx || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200); if (!tx) return bad('Пусто');
    if (limited(me.id, 'cch', 6, 10e3)) return bad('Не так быстро', 429);
    const m = { t: Date.now(), u: pubKey(me), nm: me.name, r: role, tx };
    c.ch = (c.ch || []).concat([m]).slice(-CFG.chatMax); touchC(c); toClan(c, 'cchat', m); return ok();
  }
  if (cmd === 'claim') {
    const g = chestGoal(c); if (c.cw >= g && !c.cwAt) c.cwAt = Date.now();
    if (c.cw < g) return bad('Сундук ещё не собран');
    if (me.ck === c.wk) return bad('Ты уже забрал награду этой недели');
    if (mm.j > c.cwAt) return bad('Ты вступил после сбора сундука — награда в следующий раз');
    me.ck = c.wk; touch(me); touchC(c); const rw = scale(CHEST, c); credit(me, { g: rw.g, c: rw.cr, m: rw.gems }, 'clan-chest'); return ok({ rw });
  }
  if (cmd === 'warclaim') {
    const L = c.last; if (!L || !L.ok.includes(me.id) || me.wc === L.id) return bad('Награды нет');
    me.wc = L.id; touch(me); const rw = scale(WARRW[L.win], c); credit(me, { g: rw.g, c: rw.cr, m: rw.gems }, 'clan-war'); return ok({ rw });
  }
  if (cmd === 'warfind') {
    if (!mod) return bad('Искать войну может глава или старейшина');
    if (c.war) return bad('Война уже идёт');
    if (warEligible(c) < CFG.warMinMembers) return bad('Для войны нужно минимум ' + CFG.warMinMembers + ' бойцов с экипировкой');
    warQ.add(c.id); tryWar(c); return ok({ q: warQ.has(c.id) ? 1 : 0, war: c.war ? 1 : 0 });
  }
  if (cmd === 'warcancel') { if (!mod) return bad('Нет прав'); warQ.delete(c.id); return ok() }
  if (cmd === 'wardo') return ok(warFight(me, c));
  if (cmd === 'warq0') { leaveWarQ(me.id); return ok() }
  if (cmd === 'leave') {
    if (lead && c.m.length === 1 && c.war) return bad('Нельзя распустить клан во время войны');
    dropMem(c, me.id); fixLead(c); return ok();
  }
  if (cmd === 'ok' || cmd === 'no') {
    if (!mod) return bad('Нет прав'); const r = pick(c.rq, b.u); if (!r) return bad('Заявка не найдена', 404);
    c.rq = c.rq.filter(x => x !== r); touchC(c); const p = store.players.get(r.id);
    if (cmd === 'no' || !p) return ok();
    if (p.clan && store.clans.has(p.clan)) return bad('Игрок уже вступил в другой клан');
    if (c.m.length >= CFG.clanMax) return bad('Клан заполнен');
    addMem(c, p, 0); emit(p.id, 'cinfo', { text: '✅ Тебя приняли в клан «' + c.nm + '»' }); return ok();
  }
  if (cmd === 'kick' || cmd === 'promote' || cmd === 'demote' || cmd === 'lead') {
    const t = pick(c.m, b.u); if (!t || t.id === me.id) return bad('Игрок не найден', 404);
    if (cmd === 'kick') {
      if (!mod || t.r >= role) return bad('Нет прав');
      dropMem(c, t.id); emit(t.id, 'cinfo', { text: '🚫 Тебя исключили из клана «' + c.nm + '»', out: 1 }); return ok();
    }
    if (!lead) return bad('Только глава клана');
    if (cmd === 'promote') { if (t.r !== 0) return bad('Уже старейшина'); t.r = 1 }
    else if (cmd === 'demote') { if (t.r !== 1) return bad('Он не старейшина'); t.r = 0 }
    else { t.r = 2; mm.r = 1; emit(t.id, 'cinfo', { text: '👑 Теперь ты глава клана «' + c.nm + '»' }) }
    touchC(c); return ok();
  }
  if (cmd === 'set') {
    if (!lead) return bad('Только глава клана');
    c.d = descOf(b.d); c.open = b.open === false || b.open === 0 ? 0 : 1; c.min = Math.max(0, Math.min(20000, b.min | 0)); if (CEMB.includes(b.e)) c.e = b.e;
    touchC(c); ctopC = null; return ok();
  }
  return bad('Неизвестная команда');
}

/* ---------- вход через Телеграм (проверка подписи initData) ---------- */
function tgUser(init) {
  if (!BOT || typeof init !== 'string' || init.length > 4000) return null;
  const p = new URLSearchParams(init), h = p.get('hash'); if (!h) return null; p.delete('hash');
  const str = [...p.entries()].sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0).map(([k, v]) => k + '=' + v).join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest(), calc = Buffer.from(crypto.createHmac('sha256', key).update(str).digest('hex')), got = Buffer.from(h);
  if (calc.length !== got.length || !crypto.timingSafeEqual(calc, got)) return null;
  if (Date.now() / 1000 - (+p.get('auth_date') || 0) > 86400) return null;
  try { return JSON.parse(p.get('user')) } catch (e) { return null }
}
const tgToken = id => crypto.createHmac('sha256', BOT).update('sg-session:' + id).digest('hex').slice(0, 32);

/* ---------- HTTP ---------- */
let gz = null, gzEtag = '';
function serveGame(req, res) {
  if (!GAME) { res.writeHead(404); return res.end('Положите игру в public/index.html') }
  if (!gz) { const raw = fs.readFileSync(GAME); gz = zlib.gzipSync(raw, { level: 9 }); gzEtag = '"' + sha(raw).slice(0, 16) + '"' }
  if (req.headers['if-none-match'] === gzEtag) { res.writeHead(304); return res.end() }
  const h = { 'Content-Type': 'text/html; charset=utf-8', 'ETag': gzEtag, 'Cache-Control': 'no-cache' };
  if (/gzip/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); res.end(gz) } else { res.writeHead(200, h); res.end(fs.readFileSync(GAME)) }
}


/* ---------- Telegram-бот: приветствие и меню ----------
   Нужно: BOT_TOKEN и WEBAPP_URL (адрес игры, https://...). TG_WEBHOOK=1 — сервер сам включит вебхук для /start и кнопок. */
const WEBAPP = (process.env.WEBAPP_URL || '').replace(/\/+$/, ''), WH = crypto.createHmac('sha256', BOT || 'x').update('sg-webhook').digest('hex').slice(0, 24);
const tg = (m, d) => fetch('https://api.telegram.org/bot' + BOT + '/' + m, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d || {}) }).then(r => r.json()).catch(() => ({}));
const hx = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fbWait = new Map(), LINE = '━━━━━━━━━━━━━━━━━━';
const playKb = () => [{ text: '🎮 Играть', web_app: { url: WEBAPP } }];
const mainKb = () => ({ inline_keyboard: [playKb(), [{ text: '🏆 Рейтинг', callback_data: 'top' }, { text: '📖 Как играть', callback_data: 'help' }], [{ text: '💬 Обратная связь', callback_data: 'fb' }]] });
const backKb = () => ({ inline_keyboard: [playKb(), [{ text: '← В меню', callback_data: 'home' }]] });
const welcome = name => '⚔️ <b>SHORTS &amp; GUNS</b> ⚔️\n' + LINE + '\n\nПривет, <b>' + hx(name || 'боец') + '</b>! 👋\nДобро пожаловать на арену — тут стреляют, качаются и становятся легендами.\n\n' +
  '🔫 Проходи уровни и громи боссов\n📦 Открывай ящики и собирай снаряжение\n⚡ Прокачивай навыки героя\n🏆 Дерись с игроками онлайн и лезь в мировой рейтинг\n\n' + LINE + '\nЖми <b>«Играть»</b> и покажи, кто тут главный! 👇';
const helpText = '📖 <b>Как играть</b>\n' + LINE + '\n\n🎯 <b>Бой</b> — пошаговый: сначала твоя серия выстрелов, потом ход врагов. На бой даётся ограниченное время.\n\n📦 <b>Ящики</b> падают за победы. В них снаряжение: чем выше уровень предмета, тем он сильнее.\n\n⚡ <b>Навыки</b> изучай за 🪙 и ставь «в бой» — они решают сложные схватки.\n\n⚔ <b>Онлайн</b> — кнопка в игре: рейтинговые бои, бой с другом по коду, мировой рейтинг. Нажми на игрока в рейтинге — увидишь его снаряжение.\n\n🛡 <b>Кланы</b> — вступай или создай свой: чат, недельный сундук с наградами и клановые войны клан на клан.';
function topText() {
  const l = [...store.players.values()].filter(p => p.f && !p.ban && (p.w + p.l) > 0).sort((a, b) => b.rt - a.rt || b.w - a.w).slice(0, 10), md = ['🥇', '🥈', '🥉'];
  return '🏆 <b>Мировой рейтинг</b>\n' + LINE + '\n\n' + (l.length ? l.map((p, i) => (md[i] || (i + 1) + '.') + ' <b>' + hx(p.name) + '</b> — 🏆 ' + p.rt + ' · ' + rankInfo(p.rt).e + ' ' + hx(rankInfo(p.rt).n)).join('\n') : 'Пока никто не сыграл рейтинговых боёв. Будь первым! 🚀');
}
async function tgUpdate(u) {
  const opt = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  if (u.message) {
    const m = u.message, c = m.chat.id, t = (m.text || '').trim(); if (m.chat.type !== 'private') return;
    if (/^\/(start|menu)/.test(t)) { fbWait.delete(c); return tg('sendMessage', { chat_id: c, text: welcome(m.from.first_name), reply_markup: mainKb(), ...opt }) }
    if (/^\/top/.test(t)) return tg('sendMessage', { chat_id: c, text: topText(), reply_markup: backKb(), ...opt });
    if (/^\/help/.test(t)) return tg('sendMessage', { chat_id: c, text: helpText, reply_markup: backKb(), ...opt });
    if (fbWait.has(c) && t && !t.startsWith('/')) {
      fbWait.delete(c);
      for (const a of ADMINS) tg('sendMessage', { chat_id: a.slice(2), text: '💬 <b>Обратная связь</b>\nОт: ' + hx(m.from.first_name) + (m.from.username ? ' @' + hx(m.from.username) : '') + ' (' + m.from.id + ')\n\n' + hx(t.slice(0, 1500)), ...opt });
      return tg('sendMessage', { chat_id: c, text: '✅ Спасибо! Сообщение передано разработчикам.', reply_markup: backKb(), ...opt });
    }
    return tg('sendMessage', { chat_id: c, text: 'Жми «Играть» 👇 или открой меню командой /start', reply_markup: { inline_keyboard: [playKb()] } });
  }
  if (u.callback_query) {
    const q = u.callback_query; if (!q.message) return; const c = q.message.chat.id, id = q.message.message_id;
    tg('answerCallbackQuery', { callback_query_id: q.id });
    const edit = (text, kb) => tg('editMessageText', { chat_id: c, message_id: id, text, reply_markup: kb, ...opt });
    if (q.data === 'home') { fbWait.delete(c); return edit(welcome(q.from.first_name), mainKb()) }
    if (q.data === 'top') return edit(topText(), backKb());
    if (q.data === 'help') return edit(helpText, backKb());
    if (q.data === 'fb') { fbWait.set(c, 1); return edit('💬 <b>Обратная связь</b>\n' + LINE + '\n\nНапиши одним сообщением идею или проблему — я передам разработчикам.', { inline_keyboard: [[{ text: '← Отмена', callback_data: 'home' }]] }) }
  }
}
async function tgSetup() {
  if (!BOT || !WEBAPP) return;
  await tg('setMyCommands', { commands: [{ command: 'start', description: '🎮 Главное меню' }, { command: 'top', description: '🏆 Мировой рейтинг' }, { command: 'help', description: '📖 Как играть' }] });
  await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: '🎮 Играть', web_app: { url: WEBAPP } } });
  await tg('setMyShortDescription', { short_description: '⚔️ Shorts & Guns — стреляй, качайся и бейся с игроками онлайн!' });
  await tg('setMyDescription', { description: '⚔️ Shorts & Guns\n\nПроходи уровни, открывай ящики, собирай снаряжение и сражайся с игроками онлайн.\n\nНажми «Начать» и затем «Играть» 🎮' });
  if (process.env.TG_WEBHOOK === '1') await tg('setWebhook', { url: WEBAPP + '/tg/' + WH, secret_token: WH, allowed_updates: ['message', 'callback_query'] });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), P = url.pathname, ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (req.method === 'GET' && (P === '/' || P === '/index.html')) return serveGame(req, res);
    if (P === '/healthz') return send(res, 200, { ok: 1 });
    if (req.method === 'POST' && P === '/tg/' + WH) {
      if (req.headers['x-telegram-bot-api-secret-token'] !== WH) { res.writeHead(403); return res.end() }
      const u = await body(req, 100000); res.writeHead(200); res.end('ok'); tgUpdate(u).catch(() => { }); return;
    }
    if (!P.startsWith('/api/')) { res.writeHead(404); return res.end('Not found') }
    if (P === '/api/ping') return send(res, 200, { sg: 1, players: store.players.size });

    if (P === '/api/register' && req.method === 'POST') {
      if (limited(ip, 'reg', 15, 3600e3)) return send(res, 429, { err: 'Слишком много регистраций' });
      const b = await body(req, 2000), id = 'p' + rnd(5), tok = rnd(16);
      const p = { id, name: cleanName(b.name, 'Игрок' + Math.floor(1000 + Math.random() * 9000)), th: sha(tok), save: null, ts: 0, f: null, rt: 0, rv: 2, rk: 0, w: 0, l: 0, day: '', n: 0, created: Date.now() };
      store.players.set(id, p); touch(p); await newWallet(id); return send(res, 200, { id, token: tok, name: p.name });
    }
    if (P === '/api/tg' && req.method === 'POST') {
      if (!BOT) return send(res, 500, { err: 'BOT_TOKEN не задан на сервере' });
      if (limited(ip, 'tg', 60, 3600e3)) return send(res, 429, { err: 'Слишком много попыток' });
      const b = await body(req, 5000), u = tgUser(b.initData);
      if (!u || !u.id) return send(res, 401, { err: 'tg' });
      const id = 'tg' + u.id, tok = tgToken(id); let p = store.players.get(id);
      if (!p) { p = { id, name: cleanName(u.first_name || u.username, 'Игрок' + String(u.id).slice(-4)), th: sha(tok), save: null, ts: 0, f: null, rt: 0, rv: 2, rk: 0, w: 0, l: 0, day: '', n: 0, created: Date.now(), tg: 1 }; store.players.set(id, p); touch(p); await newWallet(id) }
      else if (p.th !== sha(tok)) { p.th = sha(tok); touch(p) }
      return send(res, 200, { id, token: tok, name: p.name });
    }
    const me = reqAuth(req, url);
    if (!me) return send(res, 401, { err: 'auth' });
    if (me.ban && !ADMINS.has(me.id)) return send(res, 403, { err: 'banned' });

    if (P === '/api/admin' && req.method === 'POST') {
      if (!ADMINS.has(me.id)) return send(res, 403, { err: 'Нет доступа' });
      const b = await body(req, 2000), n = x => Math.max(-1e9, Math.min(1e9, Math.round(+x || 0))), ok = msg => send(res, 200, { msg });
      const t = b.id ? store.players.get(String(b.id)) : null;
      console.log('ADMIN', me.id, b.cmd, JSON.stringify(b).slice(0, 200));
      const view = p => { let S = {}; try { S = JSON.parse(p.save || '{}') } catch (e) { } return { id: p.id, name: p.name, rt: p.rt, rkn: RANKS[rankOf(p.rt)][0], w: p.w, l: p.l, pl: S.pl | 0, gold: (store.wallets.get(p.id) || WSTART).g, cr: (store.wallets.get(p.id) || WSTART).c, gems: (store.wallets.get(p.id) || WSTART).m, ban: p.ban ? 1 : 0, on: online(p.id) ? 1 : 0, vp: S.vp && S.vp.until > Date.now() ? S.vp.until : 0 } };
      if (b.cmd === 'stats') {
        const all = [...store.players.values()];
        return send(res, 200, { clans: store.clans.size, wars: [...store.clans.values()].filter(c => c.war).length / 2, players: all.length, online: conns.size, rooms: rooms.size, queued: [...queues.values()].reduce((a, q) => a + q.length, 0), banned: all.filter(p => p.ban).length, top: all.filter(p => p.f).sort((x, y) => y.rt - x.rt).slice(0, 5).map(p => ({ name: p.name, rt: p.rt })), cfg: CFG });
      }
      if (b.cmd === 'find') {
        const s = String(b.q || '').toLowerCase().trim();
        return send(res, 200, { rows: [...store.players.values()].filter(p => !s || p.id.toLowerCase() === s || p.id.toLowerCase() === 'tg' + s || p.name.toLowerCase().includes(s)).sort((x, y) => y.rt - x.rt).slice(0, 10).map(view) });
      }
      if (b.cmd === 'notice') { const text = String(b.text || '').replace(/[\u0000-\u001f]/g, '').slice(0, 160); if (!text) return send(res, 400, { err: 'Пустой текст' }); for (const id of conns.keys()) emit(id, 'notice', { text }); return ok('Отправлено игрокам онлайн: ' + conns.size) }
      if (b.cmd === 'endrooms') { const c = rooms.size; for (const r of [...rooms.values()]) finish(r, -1, 'admin'); return ok('Завершено боёв: ' + c) }
      if (b.cmd === 'cfg') { const k = String(b.key); if (!(k in CFG) || b.val === '' || !isFinite(+b.val) || +b.val < 0 || +b.val > 1e6) return send(res, 400, { err: 'Неверное значение' }); CFG[k] = +b.val; await saveCfg(); return ok(k + ' = ' + CFG[k]) }
      if (!t) return send(res, 404, { err: 'Игрок не найден' });
      if (b.cmd === 'give') {
        const w0 = store.wallets.get(t.id) || WSTART;
        const r = await walletTx(t, { g: Math.max(-w0.g, n(b.gold)), c: Math.max(-w0.c, n(b.cr)), m: Math.max(-w0.m, n(b.gems)) }, 'admin:' + me.id);
        if (r.err) return send(res, 500, { err: 'Не удалось записать в базу, попробуй ещё раз' });
        emit(t.id, 'wallet', { ...r.w, why: 'admin' });
        return ok('Готово: золото, ящики, гемы изменены');
      }
      if (b.cmd === 'autobox') {
        /* Выдача «VIP-авто»: ящики открываются сами, лучший предмет надевается без таблички, худший продаётся.
           hours: 1..8760 — добавить часы, -1 — навсегда, 0 — снять */
        let S; try { S = JSON.parse(t.save) } catch (e) { S = null }
        if (!S || typeof S !== 'object') return send(res, 400, { err: 'У игрока нет сохранения' });
        const h = Math.round(+b.hours);
        if (b.hours === '' || b.hours == null || !isFinite(h) || h < -1 || h > 8760) return send(res, 400, { err: 'Часы: 1–8760, -1 = навсегда, 0 = снять' });
        const now = Date.now(), vp = Object.assign({ until: 0, on: 1 }, S.vp || {}), cur = vp.until > now ? vp.until : now;
        vp.until = h === 0 ? 0 : h < 0 || cur >= FOREVER ? FOREVER : cur + h * 3600e3;
        if (h !== 0) vp.on = 1;
        S.vp = vp;
        t.ts = Math.max(Date.now(), t.ts + 1); S.ts = t.ts; t.save = JSON.stringify(S); touch(t);
        const s = conns.get(t.id); if (s) for (const r of s) r.write('event: save\ndata: ' + JSON.stringify({ data: saveOut(t), ts: t.ts, dev: 'admin' }) + '\n\n');
        return ok(h === 0 ? 'Авто-ящики сняты' : h < 0 ? 'Авто-ящики выданы навсегда' : 'Авто-ящики выданы, добавлено часов: ' + h);
      }
      if (b.cmd === 'setrt') { t.rt = Math.max(0, Math.min(20000, n(b.rt))); t.rk = rankOf(t.rt); touch(t); return ok('Кубки: ' + t.rt + ' · ' + RANKS[t.rk][0]) }
      if (b.cmd === 'rename') { t.name = cleanName(b.name, t.name); touch(t); return ok('Имя: ' + t.name) }
      if (b.cmd === 'resetday') { t.n = 0; t.day = today(); touch(t); return ok('Дневной лимит наград сброшен') }
      if (b.cmd === 'ban') {
        if (ADMINS.has(t.id)) return send(res, 400, { err: 'Админа нельзя банить' });
        t.ban = b.on ? 1 : 0;
        if (t.ban) { leaveQueue(t.id); const room = inRoom.get(t.id); if (room) finish(room, 1 - room.ids.indexOf(t.id), 'leave'); const s = conns.get(t.id); if (s) for (const r of [...s]) r.end() }
        touch(t); return ok(t.ban ? 'Забанен' : 'Разбанен');
      }
      return send(res, 400, { err: 'Неизвестная команда' });
    }

    if (P === '/api/clan' && req.method === 'POST') {
      if (limited(ip, 'clan', 300, 60e3)) return send(res, 429, { err: 'Слишком часто' });
      const r = clanApi(me, await body(req, 2000), ip); return send(res, r[0], r[1]);
    }
    if (P === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n'); let s = conns.get(me.id); if (!s) conns.set(me.id, s = new Set()); s.add(res);
      res.write('event: hello\ndata: ' + JSON.stringify({ id: me.id }) + '\n\n');
      { const w = store.wallets.get(me.id); if (w) res.write('event: wallet\ndata: ' + JSON.stringify({ ...wlPub(w), why: 'hello' }) + '\n\n') }
      const room = inRoom.get(me.id); if (room) emit(me.id, 'match', snap(room, room.ids.indexOf(me.id)));
      req.on('close', () => { s.delete(res); if (!s.size) conns.delete(me.id) });
      return;
    }
    if (P === '/api/me') return send(res, 200, { id: me.id, name: me.name, admin: ADMINS.has(me.id) ? 1 : 0, rt: me.rt, rk: rankInfo(me.rt), w: me.w, l: me.l, left: Math.max(0, CFG.rewardCap - (me.day === today() ? me.n : 0)), cl: clanBrief(me), w: wlPub(store.wallets.get(me.id) || { ...WSTART, v: 0 }) });
    if (P === '/api/ranks') return send(res, 200, { rt: me.rt, rk: (me.rk | 0) + 1, rows: RANKS.map((r, i) => ({ i: i + 1, n: r[0], e: r[1], at: r[2], rw: i ? rankReward(i) : null })) });
    if (P === '/api/top') {
      /* мировой рейтинг: только игроки, сыгравшие хотя бы один рейтинговый бой; кэш 5 секунд */
      if (!store.topC || Date.now() - store.topC.t > 5000) store.topC = { t: Date.now(), list: [...store.players.values()].filter(p => p.f && !p.ban && (p.w + p.l) > 0).sort((a, b) => b.rt - a.rt || b.w - a.w || (a.created || 0) - (b.created || 0)) };
      const list = store.topC.list, i = list.findIndex(p => p.id === me.id);
      return send(res, 200, {
        total: list.length,
        rows: list.slice(0, 50).map((p, k) => ({ n: k + 1, nm: p.name, rt: p.rt, rk: rankInfo(p.rt), w: p.w, l: p.l, pw: power(p.f), pl: p.f.pl, ct: ctag(p), u: pubKey(p), me: p.id === me.id ? 1 : 0, on: online(p.id) ? 1 : 0 })),
        me: i >= 0 ? { n: i + 1, rt: me.rt, rk: rankInfo(me.rt), w: me.w, l: me.l } : null
      });
    }
    if (P === '/api/profile') {
      /* профиль игрока из рейтинга: снаряжение, навыки, статы */
      if (limited(ip, 'prof', 120, 60e3)) return send(res, 429, { err: 'Слишком часто' });
      const u = String(url.searchParams.get('u') || ''); let t = null;
      for (const p of store.players.values()) if (pubKey(p) === u) { t = p; break }
      if (!t || !t.f || t.ban) return send(res, 404, { err: 'Игрок не найден' });
      let S = null; try { S = JSON.parse(t.save || 'null') } catch (e) { }
      const it = {};
      if (S && S.it) for (const k in SL) { const x = S.it[k]; if (x) it[k] = x.a && ADMINS.has(t.id) ? { r: 8, lv: 152, a: 1 } : { r: Math.max(0, Math.min(8, x.r | 0)), lv: Math.max(1, Math.min(400, x.lv | 0)) } }
      let sk = null;
      if (S && S.sk) { sk = { e: (Array.isArray(S.sk.e) ? S.sk.e : []).filter(z => typeof z === 'string' && /^[a-z0-9_]{1,20}$/.test(z)).slice(0, 8), l: {} }; if (S.sk.l && typeof S.sk.l === 'object') for (const id of Object.keys(S.sk.l).slice(0, 30)) if (/^[a-z0-9_]{1,20}$/.test(id)) sk.l[id] = S.sk.l[id] | 0 }
      return send(res, 200, { nm: t.name, cl: clanBrief(t), rt: t.rt, rk: rankInfo(t.rt), w: t.w, l: t.l, on: online(t.id) ? 1 : 0, f: { d: t.f.d, hp: t.f.hp, ar: t.f.ar, hs: t.f.hs, pl: t.f.pl }, pw: power(t.f), it, sk, cur: S ? S.n | 0 : 0 });
    }
    if (P === '/api/name' && req.method === 'POST') { const b = await body(req, 500); me.name = cleanName(b.name, me.name); touch(me); return send(res, 200, { name: me.name }) }

    if (P === '/api/save') {
      if (req.method === 'GET') return send(res, 200, me.save ? { exists: true, data: saveOut(me), ts: me.ts } : { exists: false });
      if (req.method === 'DELETE') { me.save = null; me.ts = 0; me.f = null; me.rt = 0; me.w = 0; me.l = 0; touch(me); const w0 = store.wallets.get(me.id) || WSTART; await walletTx(me, { g: -w0.g, c: WSTART.c - w0.c, m: -w0.m }, 'reset'); return send(res, 200, { ok: 1 }) }
      if (req.method === 'PUT') {
        const b = await body(req, 600e3);
        if (typeof b.data !== 'string' || typeof b.ts !== 'number' || b.ts > Date.now() + 864e5) return send(res, 400, { err: 'bad' });
        if (me.save && b.ts < me.ts) return send(res, 409, { data: saveOut(me), ts: me.ts });
        let S; try { S = JSON.parse(b.data) } catch (e) { return send(res, 400, { err: 'json' }) }
        if (!S || typeof S !== 'object' || typeof S.pl !== 'number' || typeof S.gold !== 'number') return send(res, 400, { err: 'shape' });
        for (const k of CURKEYS) delete S[k];   /* валюту через сохранение менять нельзя — её хранит кошелёк */
        /* админский комплект (предметы с a:1) бывает только у админов: у остальных такие предметы стираются */
        const adm = ADMINS.has(me.id);
        if (S.it && typeof S.it === 'object') for (const k in S.it) { const x = S.it[k]; if (x && x.a) { if (adm) S.it[k] = { r: 8, lv: 152, a: 1 }; else delete S.it[k] } }
        me.save = JSON.stringify(S); me.ts = b.ts; me.f = fighterFrom(S, adm) || me.f; touch(me);
        const s = conns.get(me.id); if (s) for (const r of s) r.write('event: save\ndata: ' + JSON.stringify({ data: saveOut(me), ts: me.ts, dev: b.dev || '' }) + '\n\n');
        return send(res, 200, { ok: 1, ts: me.ts });
      }
    }
    if (P === '/api/wallet') {
      if (limited(ip, 'wal', 240, 60e3)) return send(res, 429, { err: 'Слишком часто' });
      const w0 = store.wallets.get(me.id) || await newWallet(me.id);
      if (req.method === 'GET') {
        if (url.searchParams.get('log') && store.pool) {
          const q = await store.pool.query('select dgold, dcr, dgems, gold, cr, gems, why, ts from wallet_log where player_id = $1 order by id desc limit 50', [me.id]);
          return send(res, 200, { w: wlPub(w0), log: q.rows });
        }
        return send(res, 200, { w: wlPub(w0), pristine: w0.v === 0 ? 1 : 0 });
      }
      if (req.method === 'POST') {
        const b = await body(req, 2000);
        if (b.init && typeof b.init === 'object') {   /* первый вход с уже накопленным локальным прогрессом: принимается один раз, пока кошелёк не менялся */
          const t = k => Math.max(0, Math.min(1e12, Math.round(+b.init[k] || 0)));
          const r = await walletTx(me, w => ({ g: t('g') - w.g, c: t('c') - w.c, m: t('m') - w.m }), 'import', null, true);
          return send(res, r.err ? 503 : 200, { w: r.w, imported: r.skipped ? 0 : 1 });
        }
        const d = b.d || {}, tid = String(b.tid || '');
        if (!/^[\w:.-]{4,40}$/.test(tid)) return send(res, 400, { err: 'tid' });
        const dd = { g: wcl(d.g), c: wcl(d.c), m: wcl(d.m) };
        if (earnLimit(me, dd)) return send(res, 403, { err: 'limit', w: wlPub(store.wallets.get(me.id) || w0) });
        const r = await walletTx(me, dd, 'client', tid);
        if (r.err === 'funds') return send(res, 409, { err: 'funds', w: r.w });
        if (r.err) return send(res, 503, { err: 'db' });
        return send(res, 200, { ok: 1, dup: r.dup ? 1 : 0, w: r.w });
      }
    }
    if (P === '/api/arena') {
      const rows = []; for (const p of store.players.values()) if (p.f && p.id !== me.id) rows.push(pub(p));
      rows.sort((a, b) => b.rt - a.rt); return send(res, 200, { rows: rows.slice(0, 200) });
    }
    if (P === '/api/queue' && req.method === 'POST') {
      const b = await body(req, 500);
      if (b.on === false) { leaveQueue(me.id); return send(res, 200, { ok: 1 }) }
      const code = b.code ? String(b.code).toUpperCase().replace(/[^A-Z0-9А-Я]/g, '').slice(0, 12) : '';
      return send(res, 200, joinQueue(me, code));
    }
    if (P === '/api/act' && req.method === 'POST') {
      const b = await body(req, 500), room = rooms.get(String(b.room));
      if (!room) return send(res, 404, { err: 'no room' });
      const i = room.ids.indexOf(me.id); if (i < 0) return send(res, 403, { err: 'not yours' });
      return send(res, 200, { ok: act(room, i, String(b.act), false) });
    }
    send(res, 404, { err: 'not found' });
  } catch (e) { if (!res.headersSent) send(res, e.message === 'big' ? 413 : 400, { err: 'bad request' }) }
});
server.keepAliveTimeout = 65000;

initStore().then(() => server.listen(PORT, () => { console.log('Shorts & Guns: http://localhost:' + PORT); tgSetup().catch(() => { }) })).catch(e => { console.error(e); process.exit(1) });
module.exports = { fighterFrom, CFG };
