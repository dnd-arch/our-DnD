const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const fs      = require('fs');
const path    = require('path');
const bcrypt  = require('bcryptjs');
const multer  = require('multer');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = 3000;

const DATA_FILE   = path.join(__dirname, 'data.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const PUBLIC_DIR  = path.join(__dirname, 'public');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename:    (_, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_, f, cb) => f.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only'))
});

function loadData() {
  let d = { players: {}, sessions: {}, rooms: {} };
  if (fs.existsSync(DATA_FILE)) {
    try { d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) {}
  }
  if (!d.players)  d.players  = {};
  if (!d.sessions) d.sessions = {};
  if (!d.rooms)    d.rooms    = {};
  return d;
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

app.use(express.json({ limit: '4mb' }));
app.use(express.static(PUBLIC_DIR));

const wsClients = new Map();

function requireAuth(req, res, next) {
  const tok = req.headers['x-session-token'];
  const d   = loadData();
  if (!tok || !d.sessions[tok]) return res.status(401).json({ error: 'Unauthorized' });
  req.playerKey = d.sessions[tok].playerName;
  req.roomCode  = d.sessions[tok].roomCode || null;
  next();
}
function requireDM(req, res, next) {
  const d    = loadData();
  const room = d.rooms[req.roomCode];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.dmKey !== req.playerKey) return res.status(403).json({ error: 'DM only' });
  req.room = room;
  next();
}

function broadcast(msg, roomCode) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(c => {
    if (c.readyState !== WebSocket.OPEN) return;
    const info = wsClients.get(c);
    if (!info) return;
    if (roomCode && info.roomCode !== roomCode) return;
    c.send(str);
  });
}

// ── AUTH ───────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.trim().length < 2 || username.trim().length > 24) return res.status(400).json({ error: 'Username 2-24 chars' });
  if (password.length < 4) return res.status(400).json({ error: 'Password min 4 chars' });
  const d   = loadData();
  const key = username.toLowerCase().trim();
  if (d.players[key]) return res.status(409).json({ error: 'Name already taken' });
  const hash = await bcrypt.hash(password, 10);
  d.players[key] = {
    name: username.trim(), key, passwordHash: hash,
    characterClass: '', race: '', background: '', alignment: '',
    level: 1, xp: 0, hp: 20, maxHp: 20, ac: 10, speed: 30, initiative: 0,
    proficiencyBonus: 2, inspiration: false,
    stats: { STR:10, DEX:10, CON:10, INT:10, WIS:10, CHA:10 },
    savingThrows: { STR:false, DEX:false, CON:false, INT:false, WIS:false, CHA:false },
    skills: [], proficiencies: '', inventory: [], spells: [], features: [],
    backstory: '', avatar: '',
    drawColor: rndDrawColor(), tokenColor: rndTokenColor(),
    tokenPos: { x:300, y:280 }, tokenRow: 'front',
    online: false, createdAt: Date.now()
  };
  saveData(d);
  res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Required' });
  const d   = loadData();
  const key = username.toLowerCase().trim();
  const p   = d.players[key];
  if (!p) return res.status(404).json({ error: 'Character not found' });
  if (!await bcrypt.compare(password, p.passwordHash)) return res.status(401).json({ error: 'Wrong password' });
  const tok = uuidv4();
  d.sessions[tok] = { playerName: key, createdAt: Date.now(), roomCode: null };
  d.players[key].online = true;
  saveData(d);
  const { passwordHash, ...safe } = p;
  res.json({ success: true, token: tok, player: { ...safe, passwordHash: undefined } });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const tok = req.headers['x-session-token'];
  const d   = loadData();
  const rc  = d.sessions[tok]?.roomCode;
  delete d.sessions[tok];
  if (d.players[req.playerKey]) d.players[req.playerKey].online = false;
  saveData(d);
  if (rc) broadcast({ type: 'playerLeft', key: req.playerKey }, rc);
  res.json({ success: true });
});

app.get('/api/session', (req, res) => {
  const tok = req.headers['x-session-token'];
  const d   = loadData();
  if (!tok || !d.sessions[tok]) return res.status(401).json({ valid: false });
  const key = d.sessions[tok].playerName;
  const p   = d.players[key];
  if (!p) return res.status(401).json({ valid: false });
  const { passwordHash, ...safe } = p;
  const rc   = d.sessions[tok].roomCode;
  const room = rc && d.rooms[rc] ? safeRoom(d.rooms[rc], key) : null;
  res.json({ valid: true, player: safe, roomCode: rc, room });
});

// ── ROOMS ──────────────────────────────────────────────
app.post('/api/room/create', requireAuth, (req, res) => {
  const d    = loadData();
  const code = genCode();
  const name = (req.body.name || 'The Tavern').trim().slice(0, 40);
  d.rooms[code] = {
    code, name, dmKey: req.playerKey, players: [req.playerKey],
    chat: [], diceLog: [], storyImages: [],
    mapDrawing: [], mapBackground: '', battle: null,
    createdAt: Date.now()
  };
  d.sessions[req.headers['x-session-token']].roomCode = code;
  d.players[req.playerKey].online = true;
  saveData(d);
  res.json({ success: true, code, room: safeRoom(d.rooms[code], req.playerKey) });
});

app.post('/api/room/join', requireAuth, (req, res) => {
  const code = (req.body.code || '').toUpperCase().trim();
  if (!code) return res.status(400).json({ error: 'Code required' });
  const d    = loadData();
  const room = d.rooms[code];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!room.players.includes(req.playerKey)) room.players.push(req.playerKey);
  d.sessions[req.headers['x-session-token']].roomCode = code;
  d.players[req.playerKey].online = true;
  saveData(d);
  const { passwordHash, ...safe } = d.players[req.playerKey];
  broadcast({ type: 'playerJoined', player: safe }, code);
  res.json({ success: true, room: safeRoom(room, req.playerKey) });
});

app.post('/api/room/leave', requireAuth, (req, res) => {
  const tok = req.headers['x-session-token'];
  const d   = loadData();
  const rc  = d.sessions[tok]?.roomCode;
  if (rc && d.rooms[rc]) d.rooms[rc].players = d.rooms[rc].players.filter(k => k !== req.playerKey);
  if (d.sessions[tok]) d.sessions[tok].roomCode = null;
  saveData(d);
  if (rc) broadcast({ type: 'playerLeft', key: req.playerKey }, rc);
  res.json({ success: true });
});

app.get('/api/room', requireAuth, (req, res) => {
  const d  = loadData();
  const rc = req.roomCode;
  if (!rc || !d.rooms[rc]) return res.status(404).json({ error: 'Not in a room' });
  res.json({ room: safeRoom(d.rooms[rc], req.playerKey) });
});

// ── PLAYER ─────────────────────────────────────────────
app.post('/api/player', requireAuth, (req, res) => {
  const d   = loadData();
  const upd = req.body;
  const key = req.playerKey;
  if (!d.players[key]) return res.status(404).json({ error: 'Not found' });
  ['passwordHash','name','key','createdAt'].forEach(f => delete upd[f]);
  d.players[key] = { ...d.players[key], ...upd };
  saveData(d);
  const { passwordHash, ...safe } = d.players[key];
  broadcast({ type: 'playerUpdate', player: safe }, req.roomCode);
  res.json({ success: true, player: safe });
});

app.get('/api/players', requireAuth, (req, res) => {
  const d  = loadData();
  const rc = req.roomCode;
  if (!rc || !d.rooms[rc]) return res.json({ players: [] });
  const players = d.rooms[rc].players.map(k => d.players[k]).filter(Boolean).map(({ passwordHash, ...p }) => p);
  res.json({ players });
});

app.post('/api/upload/avatar', requireAuth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const d   = loadData();
  const url = `/uploads/${req.file.filename}`;
  d.players[req.playerKey].avatar = url;
  saveData(d);
  const { passwordHash, ...safe } = d.players[req.playerKey];
  broadcast({ type: 'playerUpdate', player: safe }, req.roomCode);
  res.json({ success: true, url });
});

// ── CHAT ───────────────────────────────────────────────
app.post('/api/chat', requireAuth, (req, res) => {
  const { message, type: mt } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Empty' });
  const d  = loadData();
  const rc = req.roomCode;
  if (!rc || !d.rooms[rc]) return res.status(400).json({ error: 'Not in a room' });
  const p   = d.players[req.playerKey];
  const msg = {
    id: uuidv4(), playerName: p?.name || req.playerKey, playerKey: req.playerKey,
    avatar: p?.avatar || '', message: message.trim().slice(0, 500),
    type: mt || 'ooc', timestamp: Date.now()
  };
  d.rooms[rc].chat = d.rooms[rc].chat || [];
  d.rooms[rc].chat.push(msg);
  if (d.rooms[rc].chat.length > 300) d.rooms[rc].chat = d.rooms[rc].chat.slice(-300);
  saveData(d);
  broadcast({ type: 'chatMessage', msg }, rc);
  res.json({ success: true, msg });
});

app.get('/api/chat', requireAuth, (req, res) => {
  const d  = loadData();
  const rc = req.roomCode;
  if (!rc || !d.rooms[rc]) return res.json({ messages: [] });
  res.json({ messages: (d.rooms[rc].chat || []).slice(-100) });
});

// ── DICE ───────────────────────────────────────────────
app.post('/api/dice', requireAuth, (req, res) => {
  const { result, die, modifier, total, label, monsterName } = req.body;
  const d  = loadData();
  const rc = req.roomCode;
  if (!rc || !d.rooms[rc]) return res.status(400).json({ error: 'Not in a room' });
  const p   = d.players[req.playerKey];
  const roll = {
    id: uuidv4(), playerName: monsterName || p?.name || req.playerKey,
    result, die, modifier: modifier || 0, total: total || result,
    label: label || '', timestamp: Date.now(), isMonster: !!monsterName
  };
  d.rooms[rc].diceLog = d.rooms[rc].diceLog || [];
  d.rooms[rc].diceLog.unshift(roll);
  if (d.rooms[rc].diceLog.length > 100) d.rooms[rc].diceLog = d.rooms[rc].diceLog.slice(0, 100);
  const sides  = parseInt(die.replace('d',''));
  const modStr = (modifier > 0 ? `+${modifier}` : modifier < 0 ? `${modifier}` : '');
  const natStr = result === sides ? ' 🌟 NAT MAX!' : result === 1 ? ' 💀 FUMBLE!' : '';
  const chatMsg = {
    id: uuidv4(), playerName: roll.playerName, playerKey: req.playerKey,
    avatar: p?.avatar || '',
    message: `🎲 rolled ${die}${modStr} → **${roll.total}**${label ? ` *(${label})*` : ''}${natStr}`,
    type: 'roll', timestamp: Date.now()
  };
  d.rooms[rc].chat = d.rooms[rc].chat || [];
  d.rooms[rc].chat.push(chatMsg);
  saveData(d);
  broadcast({ type: 'diceRoll', roll }, rc);
  broadcast({ type: 'chatMessage', msg: chatMsg }, rc);
  res.json({ success: true, roll });
});

// ── MAP ────────────────────────────────────────────────
app.post('/api/map/drawing', requireAuth, (req, res) => {
  const { strokes } = req.body;
  const d  = loadData();
  const rc = req.roomCode;
  if (!rc || !d.rooms[rc]) return res.status(400).json({ error: 'No room' });
  d.rooms[rc].mapDrawing = strokes || [];
  saveData(d);
  broadcast({ type: 'mapDrawing', strokes: d.rooms[rc].mapDrawing }, rc);
  res.json({ success: true });
});

app.post('/api/upload/map', requireAuth, upload.single('map'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const d  = loadData();
  const rc = req.roomCode;
  if (!rc || !d.rooms[rc]) return res.status(400).json({ error: 'No room' });
  const url = `/uploads/${req.file.filename}`;
  d.rooms[rc].mapBackground = url;
  saveData(d);
  broadcast({ type: 'mapBackground', url }, rc);
  res.json({ success: true, url });
});

app.get('/api/map', requireAuth, (req, res) => {
  const d  = loadData();
  const rc = req.roomCode;
  if (!rc || !d.rooms[rc]) return res.json({ strokes: [], background: '', players: [] });
  const room    = d.rooms[rc];
  const players = room.players.map(k => d.players[k]).filter(Boolean).map(({ passwordHash, ...p }) => p);
  res.json({ strokes: room.mapDrawing || [], background: room.mapBackground || '', players });
});

app.post('/api/map/token', requireAuth, (req, res) => {
  const { x, y } = req.body;
  const d = loadData();
  if (d.players[req.playerKey]) d.players[req.playerKey].tokenPos = { x, y };
  saveData(d);
  broadcast({ type: 'tokenMoved', key: req.playerKey, x, y }, req.roomCode);
  res.json({ success: true });
});

// ── STORY ──────────────────────────────────────────────
app.post('/api/upload/story', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const d  = loadData();
  const rc = req.roomCode;
  if (!rc || !d.rooms[rc]) return res.status(400).json({ error: 'No room' });
  const image = {
    id: uuidv4(), url: `/uploads/${req.file.filename}`,
    caption: req.body.caption || '',
    uploadedBy: d.players[req.playerKey]?.name || req.playerKey,
    timestamp: Date.now()
  };
  d.rooms[rc].storyImages = d.rooms[rc].storyImages || [];
  d.rooms[rc].storyImages.unshift(image);
  if (d.rooms[rc].storyImages.length > 60) d.rooms[rc].storyImages = d.rooms[rc].storyImages.slice(0, 60);
  saveData(d);
  broadcast({ type: 'storyImage', image }, rc);
  res.json({ success: true, image });
});

app.get('/api/story-images', requireAuth, (req, res) => {
  const d  = loadData();
  const rc = req.roomCode;
  if (!rc || !d.rooms[rc]) return res.json({ images: [] });
  res.json({ images: d.rooms[rc].storyImages || [] });
});

// ══════════════════════════════════════════════════════
// ── BATTLE ────────────────────────────────────────────
// ══════════════════════════════════════════════════════

app.post('/api/battle/setup', requireAuth, requireDM, (req, res) => {
  const { monsters } = req.body;
  const d  = loadData();
  const rc = req.roomCode;
  const ms = (monsters || []).map(m => ({
    id: uuidv4(),
    name:    m.name    || 'Monster',
    image:   m.image   || '',
    hp:      parseInt(m.hp)    || 10,
    maxHp:   parseInt(m.maxHp) || parseInt(m.hp) || 10,
    ac:      parseInt(m.ac)    || 10,
    dex:     parseInt(m.dex)   || 10,
    str:     parseInt(m.str)   || 10,
    attacks: m.attacks || '',
    cr:      m.cr || '?',
    row:     m.row || 'front',
    initiative: 0, initiativeRolled: false,
    posX: m.posX || 0, posY: m.posY || 0
  }));
  d.rooms[rc].battle = { state:'setup', monsters: ms, initiativeOrder:[], currentTurn:0, round:1 };
  saveData(d);
  broadcast({ type: 'battleUpdate', battle: d.rooms[rc].battle }, rc);
  res.json({ success: true, battle: d.rooms[rc].battle });
});

app.post('/api/battle/monster-image', requireAuth, requireDM, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ success: true, url: `/uploads/${req.file.filename}` });
});

app.post('/api/battle/roll-initiative', requireAuth, requireDM, (req, res) => {
  const d      = loadData();
  const rc     = req.roomCode;
  const battle = d.rooms[rc].battle;
  if (!battle) return res.status(400).json({ error: 'No battle' });
  battle.monsters.forEach(m => {
    const dexMod = Math.floor((m.dex - 10) / 2);
    m.initiative = Math.floor(Math.random() * 20) + 1 + dexMod;
    m.initiativeRolled = true;
  });
  const room = d.rooms[rc];
  const playerInits = {};
  room.players.forEach(pk => {
    const p = d.players[pk];
    if (!p) return;
    const dexMod = Math.floor(((p.stats?.DEX || 10) - 10) / 2);
    playerInits[pk] = Math.floor(Math.random() * 20) + 1 + dexMod + (p.initiative || 0);
  });
  const combined = [];
  battle.monsters.forEach(m => combined.push({ id: m.id, name: m.name, type: 'monster', initiative: m.initiative }));
  room.players.forEach(pk => {
    const p = d.players[pk];
    if (!p) return;
    combined.push({ id: pk, name: p.name, type: 'player', initiative: playerInits[pk] });
  });
  combined.sort((a, b) => b.initiative - a.initiative);
  battle.initiativeOrder  = combined;
  battle.playerInitiatives = playerInits;
  battle.state = 'rolling';
  saveData(d);
  broadcast({ type: 'battleUpdate', battle }, rc);
  res.json({ success: true, battle });
});

app.post('/api/battle/start', requireAuth, requireDM, (req, res) => {
  const d      = loadData();
  const rc     = req.roomCode;
  const battle = d.rooms[rc].battle;
  if (!battle) return res.status(400).json({ error: 'No battle' });
  battle.state = 'active'; battle.currentTurn = 0; battle.round = 1;
  saveData(d);
  broadcast({ type: 'battleUpdate', battle }, rc);
  broadcast({ type: 'battleStarted' }, rc);
  res.json({ success: true });
});

app.post('/api/battle/next-turn', requireAuth, requireDM, (req, res) => {
  const d      = loadData();
  const rc     = req.roomCode;
  const battle = d.rooms[rc].battle;
  if (!battle || battle.state !== 'active') return res.status(400).json({ error: 'No active battle' });
  battle.currentTurn++;
  if (battle.currentTurn >= battle.initiativeOrder.length) { battle.currentTurn = 0; battle.round++; }
  saveData(d);
  broadcast({ type: 'battleUpdate', battle }, rc);
  res.json({ success: true, battle });
});

app.post('/api/battle/monster-hp', requireAuth, requireDM, (req, res) => {
  const { monsterId, hp } = req.body;
  const d  = loadData();
  const rc = req.roomCode;
  const b  = d.rooms[rc]?.battle;
  if (!b) return res.status(400).json({ error: 'No battle' });
  const m = b.monsters.find(x => x.id === monsterId);
  if (m) m.hp = Math.max(0, parseInt(hp) || 0);
  saveData(d);
  broadcast({ type: 'battleUpdate', battle: b }, rc);
  res.json({ success: true });
});

app.post('/api/battle/monster-move', requireAuth, requireDM, (req, res) => {
  const { monsterId, row, posX, posY } = req.body;
  const d  = loadData();
  const rc = req.roomCode;
  const b  = d.rooms[rc]?.battle;
  if (!b) return res.status(400).json({ error: 'No battle' });
  const m = b.monsters.find(x => x.id === monsterId);
  if (m) {
    if (row !== undefined) m.row = row;
    if (posX !== undefined) m.posX = posX;
    if (posY !== undefined) m.posY = posY;
  }
  saveData(d);
  broadcast({ type: 'battleUpdate', battle: b }, rc);
  res.json({ success: true });
});

app.post('/api/battle/end', requireAuth, requireDM, (req, res) => {
  const d  = loadData();
  const rc = req.roomCode;
  if (d.rooms[rc]) d.rooms[rc].battle = null;
  saveData(d);
  broadcast({ type: 'battleEnded' }, rc);
  res.json({ success: true });
});

app.get('/api/battle', requireAuth, (req, res) => {
  const d  = loadData();
  const rc = req.roomCode;
  if (!rc || !d.rooms[rc]) return res.json({ battle: null });
  res.json({ battle: d.rooms[rc].battle || null });
});

// ── WS ────────────────────────────────────────────────
wss.on('connection', ws => {
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (msg.type === 'identify') { wsClients.set(ws, { playerKey: msg.playerKey, roomCode: msg.roomCode }); }
    } catch(e) {}
  });
  ws.on('close', () => wsClients.delete(ws));
});

function safeRoom(room, playerKey) {
  if (!room) return null;
  return { code: room.code, name: room.name, dmKey: room.dmKey, isDM: room.dmKey === playerKey, playerCount: room.players.length, battle: room.battle || null };
}
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function rndDrawColor()  { return ['#e74c3c','#3498db','#2ecc71','#f1c40f','#9b59b6','#1abc9c','#e67e22','#e91e63','#00bcd4','#ff5722'][Math.floor(Math.random()*10)]; }
function rndTokenColor() { return ['#c0392b','#2980b9','#27ae60','#d35400','#8e44ad','#16a085','#f39c12','#0097a7'][Math.floor(Math.random()*8)]; }

server.listen(PORT, () => console.log(`\n⚔️  Tavern → http://localhost:${PORT}\n`));
