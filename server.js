'use strict';
/* Shorts & Guns — сервер.
   Один процесс делает всё: отдаёт игру (public/index.html), хранит аккаунты и сохранения,
   ведёт рейтинг и проводит PvP-дуэли в реальном времени.
   Реальное время — Server-Sent Events (сервер → игрок) + обычные POST (игрок → сервер): работает на любом бесплатном хостинге без WebSocket.
   Хранилище: Postgres, если задан DATABASE_URL (Neon/Supabase/Render — данные переживают перезапуски), иначе файл data.json (только для локальной проверки). */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');

const PORT = +process.env.PORT || 3000;
const DB_URL = process.env.DATABASE_URL || '', BOT = process.env.BOT_TOKEN || '';
const ADMINS = new Set((process.env.ADMIN_IDS || '8927761386').split(',').map(s => 'tg' + s.trim()).filter(s => s.length > 2));
const FOREVER = 4102444800000; /* «навсегда» для авто-ящиков (2100 год) */
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
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
  winCr: 2, rewardCap: 15 /* награда за победу: ящики; наград за победы в день */
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
const stageOf = lv => { let n = 0; STAGE_LV.forEach((v, i) => { if (lv >= v) n = i }); return n };
function fighterFrom(S) {
  let d = 6, hp = 50, ar = 0; const stages = [];
  for (const k in SL) {
    const it = S.it && S.it[k]; if (!it) continue;
    const lv = Math.max(1, Math.min(400, it.lv | 0)), r = Math.max(0, Math.min(8, it.r | 0)), p = lv * RM[r], c = SL[k];
    d += p * c[0]; hp += p * c[1]; ar += p * c[2];
    const st = Math.max(stageOf(lv), r); for (let i = 0; i < (k == 'w' ? 3 : 1); i++) stages.push(st);
  }
  if (!stages.length) return null;
  stages.sort((a, b) => a - b);
  return { d: Math.round(d), hp: Math.round(hp), ar: Math.round(ar), hs: stages[stages.length >> 1], pl: Math.max(1, Math.min(150, S.pl | 0)) };
}
const power = f => Math.round(f.d * 5 + f.hp / 2 + f.ar * 3);
/* публичный ид игрока для рейтинга (настоящий id, в т.ч. Telegram, наружу не отдаём) */
const pubKey = p => crypto.createHash('sha1').update('pub:' + p.id).digest('hex').slice(0, 12);

/* ---------- хранилище ---------- */
const store = { players: new Map(), dirty: new Set(), pool: null };
async function initStore() {
  if (DB_URL) {
    let pg; try { pg = require('pg') } catch (e) { console.error('Нужен пакет pg: выполните npm install'); process.exit(1) }
    store.pool = new pg.Pool({ connectionString: DB_URL, ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false }, max: 3 });
    await store.pool.query('create table if not exists players(id text primary key, data jsonb not null, updated timestamptz default now())');
    const r = await store.pool.query('select id, data from players');
    for (const x of r.rows) store.players.set(x.id, x.data);
    console.log('Postgres: игроков загружено', store.players.size);
  } else {
    try { const o = JSON.parse(fs.readFileSync(FILE, 'utf8')); for (const k in o) store.players.set(k, o[k]) } catch (e) { }
    console.log('Файловое хранилище', FILE, '(для постоянной работы задайте DATABASE_URL). Игроков:', store.players.size);
  }
  /* старый Эло-рейтинг (старт 1000) → кубки (старт 0), без наград за уже достигнутые ранги */
  for (const p of store.players.values()) if (!p.rv) { p.rt = Math.max(0, (p.rt | 0) - 1000); p.rv = 2; p.rk = rankOf(p.rt); touch(p) }
}
const touch = p => store.dirty.add(p.id);
let flushing = false;
async function flush() {
  if (flushing || !store.dirty.size) return; flushing = true;
  const ids = [...store.dirty]; store.dirty.clear();
  try {
    if (store.pool) {
      for (const id of ids) {
        try { await store.pool.query('insert into players(id, data, updated) values($1, $2, now()) on conflict(id) do update set data = $2, updated = now()', [id, JSON.stringify(store.players.get(id))]) }
        catch (e) { console.error('db:', e.message); store.dirty.add(id) }
      }
    } else {
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(Object.fromEntries(store.players))); fs.renameSync(FILE + '.tmp', FILE);
    }
  } catch (e) { console.error('flush:', e.message); ids.forEach(i => store.dirty.add(i)) }
  flushing = false;
}
setInterval(flush, 3000);
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
function startRoom(a, b, friendly) {
  for (const q of queues.values()) for (let i = q.length - 1; i >= 0; i--) if (q[i].id === a.id || q[i].id === b.id) { clearTimeout(q[i].tm); q.splice(i, 1) }
  const room = { id: rnd(6), ids: [a.id, b.id], fr: [a.f, b.f], hp: [a.f.hp, b.f.hp], max: [a.f.hp, b.f.hp], heals: [CFG.heals, CFG.heals], guard: [0, 0], turn: Math.random() < .5 ? 0 : 1, half: 0, friendly, over: false, timer: null, deadline: 0 };
  rooms.set(room.id, room); inRoom.set(a.id, room); inRoom.set(b.id, room);
  armTimer(room);
  emit(a.id, 'match', snap(room, 0)); emit(b.id, 'match', snap(room, 1));
}
function armTimer(room) {
  clearTimeout(room.timer); room.deadline = Date.now() + CFG.turnMs;
  room.timer = setTimeout(() => {
    if (room.over) return; const id = room.ids[room.turn];
    if (!online(id)) return finish(room, 1 - room.turn, 'leave');          /* ушёл из игры — поражение */
    act(room, room.turn, 'fire', true);                                    /* не успел — автоматический выстрел */
  }, CFG.turnMs + 300);
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
const emitBoth = (room, ev, d) => room.ids.forEach(id => emit(id, ev, d));
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
      if (won) p.w++; else p.l++;
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
    }
  }
  room.ids.forEach((id, i) => { emit(id, 'end', res[i]); inRoom.delete(id) });
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
function leaveQueue(id) { for (const q of queues.values()) for (let i = q.length - 1; i >= 0; i--) if (q[i].id === id) { clearTimeout(q[i].tm); q.splice(i, 1) } }

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
const helpText = '📖 <b>Как играть</b>\n' + LINE + '\n\n🎯 <b>Бой</b> — пошаговый: сначала твоя серия выстрелов, потом ход врагов. На бой даётся ограниченное время.\n\n📦 <b>Ящики</b> падают за победы. В них снаряжение: чем выше уровень предмета, тем он сильнее.\n\n⚡ <b>Навыки</b> изучай за 🪙 и ставь «в бой» — они решают сложные схватки.\n\n⚔ <b>Онлайн</b> — кнопка в игре: рейтинговые бои, бой с другом по коду, мировой рейтинг. Нажми на игрока в рейтинге — увидишь его снаряжение.';
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
      store.players.set(id, p); touch(p); return send(res, 200, { id, token: tok, name: p.name });
    }
    if (P === '/api/tg' && req.method === 'POST') {
      if (!BOT) return send(res, 500, { err: 'BOT_TOKEN не задан на сервере' });
      if (limited(ip, 'tg', 60, 3600e3)) return send(res, 429, { err: 'Слишком много попыток' });
      const b = await body(req, 5000), u = tgUser(b.initData);
      if (!u || !u.id) return send(res, 401, { err: 'tg' });
      const id = 'tg' + u.id, tok = tgToken(id); let p = store.players.get(id);
      if (!p) { p = { id, name: cleanName(u.first_name || u.username, 'Игрок' + String(u.id).slice(-4)), th: sha(tok), save: null, ts: 0, f: null, rt: 0, rv: 2, rk: 0, w: 0, l: 0, day: '', n: 0, created: Date.now(), tg: 1 }; store.players.set(id, p); touch(p) }
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
      const view = p => { let S = {}; try { S = JSON.parse(p.save || '{}') } catch (e) { } return { id: p.id, name: p.name, rt: p.rt, rkn: RANKS[rankOf(p.rt)][0], w: p.w, l: p.l, pl: S.pl | 0, gold: Math.round(S.gold || 0), cr: S.cr | 0, gems: S.gems | 0, ban: p.ban ? 1 : 0, on: online(p.id) ? 1 : 0, vp: S.vp && S.vp.until > Date.now() ? S.vp.until : 0 } };
      if (b.cmd === 'stats') {
        const all = [...store.players.values()];
        return send(res, 200, { players: all.length, online: conns.size, rooms: rooms.size, queued: [...queues.values()].reduce((a, q) => a + q.length, 0), banned: all.filter(p => p.ban).length, top: all.filter(p => p.f).sort((x, y) => y.rt - x.rt).slice(0, 5).map(p => ({ name: p.name, rt: p.rt })), cfg: CFG });
      }
      if (b.cmd === 'find') {
        const s = String(b.q || '').toLowerCase().trim();
        return send(res, 200, { rows: [...store.players.values()].filter(p => !s || p.id.toLowerCase() === s || p.id.toLowerCase() === 'tg' + s || p.name.toLowerCase().includes(s)).sort((x, y) => y.rt - x.rt).slice(0, 10).map(view) });
      }
      if (b.cmd === 'notice') { const text = String(b.text || '').replace(/[\u0000-\u001f]/g, '').slice(0, 160); if (!text) return send(res, 400, { err: 'Пустой текст' }); for (const id of conns.keys()) emit(id, 'notice', { text }); return ok('Отправлено игрокам онлайн: ' + conns.size) }
      if (b.cmd === 'endrooms') { const c = rooms.size; for (const r of [...rooms.values()]) finish(r, -1, 'admin'); return ok('Завершено боёв: ' + c) }
      if (b.cmd === 'cfg') { const k = String(b.key); if (!(k in CFG) || b.val === '' || !isFinite(+b.val) || +b.val < 0 || +b.val > 1e6) return send(res, 400, { err: 'Неверное значение' }); CFG[k] = +b.val; return ok(k + ' = ' + CFG[k]) }
      if (!t) return send(res, 404, { err: 'Игрок не найден' });
      if (b.cmd === 'give') {
        let S; try { S = JSON.parse(t.save) } catch (e) { S = null }
        if (!S || typeof S !== 'object') return send(res, 400, { err: 'У игрока нет сохранения' });
        S.gold = Math.max(0, (S.gold || 0) + n(b.gold)); S.cr = Math.max(0, (S.cr | 0) + n(b.cr)); S.gems = Math.max(0, (S.gems | 0) + n(b.gems));
        t.ts = Math.max(Date.now(), t.ts + 1); S.ts = t.ts; t.save = JSON.stringify(S); touch(t);
        const s = conns.get(t.id); if (s) for (const r of s) r.write('event: save\ndata: ' + JSON.stringify({ data: t.save, ts: t.ts, dev: 'admin' }) + '\n\n');
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
        const s = conns.get(t.id); if (s) for (const r of s) r.write('event: save\ndata: ' + JSON.stringify({ data: t.save, ts: t.ts, dev: 'admin' }) + '\n\n');
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

    if (P === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n'); let s = conns.get(me.id); if (!s) conns.set(me.id, s = new Set()); s.add(res);
      res.write('event: hello\ndata: ' + JSON.stringify({ id: me.id }) + '\n\n');
      const room = inRoom.get(me.id); if (room) emit(me.id, 'match', snap(room, room.ids.indexOf(me.id)));
      req.on('close', () => { s.delete(res); if (!s.size) conns.delete(me.id) });
      return;
    }
    if (P === '/api/me') return send(res, 200, { id: me.id, name: me.name, admin: ADMINS.has(me.id) ? 1 : 0, rt: me.rt, rk: rankInfo(me.rt), w: me.w, l: me.l, left: Math.max(0, CFG.rewardCap - (me.day === today() ? me.n : 0)) });
    if (P === '/api/ranks') return send(res, 200, { rt: me.rt, rk: (me.rk | 0) + 1, rows: RANKS.map((r, i) => ({ i: i + 1, n: r[0], e: r[1], at: r[2], rw: i ? rankReward(i) : null })) });
    if (P === '/api/top') {
      /* мировой рейтинг: только игроки, сыгравшие хотя бы один рейтинговый бой; кэш 5 секунд */
      if (!store.topC || Date.now() - store.topC.t > 5000) store.topC = { t: Date.now(), list: [...store.players.values()].filter(p => p.f && !p.ban && (p.w + p.l) > 0).sort((a, b) => b.rt - a.rt || b.w - a.w || (a.created || 0) - (b.created || 0)) };
      const list = store.topC.list, i = list.findIndex(p => p.id === me.id);
      return send(res, 200, {
        total: list.length,
        rows: list.slice(0, 50).map((p, k) => ({ n: k + 1, nm: p.name, rt: p.rt, rk: rankInfo(p.rt), w: p.w, l: p.l, pw: power(p.f), pl: p.f.pl, u: pubKey(p), me: p.id === me.id ? 1 : 0, on: online(p.id) ? 1 : 0 })),
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
      if (S && S.it) for (const k in SL) { const x = S.it[k]; if (x) it[k] = { r: Math.max(0, Math.min(8, x.r | 0)), lv: Math.max(1, Math.min(400, x.lv | 0)) } }
      let sk = null;
      if (S && S.sk) { sk = { e: (Array.isArray(S.sk.e) ? S.sk.e : []).filter(z => typeof z === 'string' && /^[a-z0-9_]{1,20}$/.test(z)).slice(0, 8), l: {} }; if (S.sk.l && typeof S.sk.l === 'object') for (const id of Object.keys(S.sk.l).slice(0, 30)) if (/^[a-z0-9_]{1,20}$/.test(id)) sk.l[id] = S.sk.l[id] | 0 }
      return send(res, 200, { nm: t.name, rt: t.rt, rk: rankInfo(t.rt), w: t.w, l: t.l, on: online(t.id) ? 1 : 0, f: { d: t.f.d, hp: t.f.hp, ar: t.f.ar, hs: t.f.hs, pl: t.f.pl }, pw: power(t.f), it, sk, cur: S ? S.n | 0 : 0 });
    }
    if (P === '/api/name' && req.method === 'POST') { const b = await body(req, 500); me.name = cleanName(b.name, me.name); touch(me); return send(res, 200, { name: me.name }) }

    if (P === '/api/save') {
      if (req.method === 'GET') return send(res, 200, me.save ? { exists: true, data: me.save, ts: me.ts } : { exists: false });
      if (req.method === 'DELETE') { me.save = null; me.ts = 0; me.f = null; me.rt = 0; me.w = 0; me.l = 0; touch(me); return send(res, 200, { ok: 1 }) }
      if (req.method === 'PUT') {
        const b = await body(req, 600e3);
        if (typeof b.data !== 'string' || typeof b.ts !== 'number' || b.ts > Date.now() + 864e5) return send(res, 400, { err: 'bad' });
        if (me.save && b.ts < me.ts) return send(res, 409, { data: me.save, ts: me.ts });
        let S; try { S = JSON.parse(b.data) } catch (e) { return send(res, 400, { err: 'json' }) }
        if (!S || typeof S !== 'object' || typeof S.pl !== 'number' || typeof S.gold !== 'number') return send(res, 400, { err: 'shape' });
        me.save = b.data; me.ts = b.ts; me.f = fighterFrom(S) || me.f; touch(me);
        const s = conns.get(me.id); if (s) for (const r of s) r.write('event: save\ndata: ' + JSON.stringify({ data: me.save, ts: me.ts, dev: b.dev || '' }) + '\n\n');
        return send(res, 200, { ok: 1, ts: me.ts });
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
