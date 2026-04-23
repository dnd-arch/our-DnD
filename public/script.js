/* ══════════════════════════════════════════════
   TAVERN TABLETOP v3 — Client Script
   ══════════════════════════════════════════════ */
'use strict';

// ── D&D Data ──────────────────────────────────────────
const DND_SKILLS = [
  {name:'Acrobatics',attr:'DEX'},{name:'Animal Handling',attr:'WIS'},{name:'Arcana',attr:'INT'},
  {name:'Athletics',attr:'STR'},{name:'Deception',attr:'CHA'},{name:'History',attr:'INT'},
  {name:'Insight',attr:'WIS'},{name:'Intimidation',attr:'CHA'},{name:'Investigation',attr:'INT'},
  {name:'Medicine',attr:'WIS'},{name:'Nature',attr:'INT'},{name:'Perception',attr:'WIS'},
  {name:'Performance',attr:'CHA'},{name:'Persuasion',attr:'CHA'},{name:'Religion',attr:'INT'},
  {name:'Sleight of Hand',attr:'DEX'},{name:'Stealth',attr:'DEX'},{name:'Survival',attr:'WIS'},
];
const SAVE_ATTRS   = ['STR','DEX','CON','INT','WIS','CHA'];
const ABILITY_FULL = {STR:'Strength',DEX:'Dexterity',CON:'Constitution',INT:'Intelligence',WIS:'Wisdom',CHA:'Charisma'};

// ── State ─────────────────────────────────────────────
let token       = null;
let myPlayer    = null;
let myRoom      = null;
let isDM        = false;
let allPlayers  = {};
let ws          = null;
let chatType    = 'ooc';
let selectedDie = 20;
let sheetTimer  = null;
let storyFD     = null;
let currentBattle = null;

// Map drawing state
let mapTool      = 'draw';
let mapDrawCtx   = null;
let mapBgCtx     = null;
let mapIsDrawing = false;
let mapStrokes   = [];    // [{color, width, points:[{x,y}]}]
let currentStroke = null;
let mapSendTimer  = null;

// ── Init ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('tt_token');
  if (saved) { token = saved; validateSession(); }
  document.getElementById('login-pass')?.addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });
  document.getElementById('reg-pass2')?.addEventListener('keydown', e => { if(e.key==='Enter') doRegister(); });
  document.getElementById('chat-input')?.addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat();} });
  document.getElementById('room-code-input')?.addEventListener('input', e => { e.target.value=e.target.value.toUpperCase(); });
});

// ── API ───────────────────────────────────────────────
async function api(method, url, body) {
  const opts = { method, headers: {'Content-Type':'application/json'} };
  if (token) opts.headers['x-session-token'] = token;
  if (body)  opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

// ── Session ───────────────────────────────────────────
async function validateSession() {
  try {
    const res = await api('GET','/api/session');
    if (!res.valid) { localStorage.removeItem('tt_token'); token=null; return; }
    myPlayer = res.player;
    if (res.roomCode && res.room) {
      myRoom = res.room; isDM = res.room.isDM;
      enterApp();
    } else {
      showLobby();
    }
  } catch(e) { localStorage.removeItem('tt_token'); token=null; }
}

// ── Auth ──────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t,i)=>t.classList.toggle('active',(i===0&&tab==='login')||(i===1&&tab==='register')));
  document.getElementById('tab-login').style.display    = tab==='login'    ? '' : 'none';
  document.getElementById('tab-register').style.display = tab==='register' ? '' : 'none';
}

async function doLogin() {
  const username = document.getElementById('login-name').value.trim();
  const password = document.getElementById('login-pass').value;
  const err      = document.getElementById('login-error');
  err.textContent = '';
  if (!username||!password) { err.textContent='Fill all fields'; return; }
  try {
    const res = await api('POST','/api/login',{username,password});
    if (res.error) { err.textContent=res.error; return; }
    token=res.token; myPlayer=res.player;
    localStorage.setItem('tt_token',token);
    showLobby();
  } catch(e) { err.textContent='Server error'; }
}

async function doRegister() {
  const username=document.getElementById('reg-name').value.trim();
  const password=document.getElementById('reg-pass').value;
  const pass2   =document.getElementById('reg-pass2').value;
  const err     =document.getElementById('reg-error');
  err.textContent='';
  if (!username||!password) { err.textContent='Fill all fields'; return; }
  if (password!==pass2) { err.textContent='Passwords do not match'; return; }
  try {
    const res=await api('POST','/api/register',{username,password});
    if (res.error) { err.textContent=res.error; return; }
    toast('Character created! Now log in.');
    switchTab('login');
    document.getElementById('login-name').value=username;
  } catch(e) { err.textContent='Server error'; }
}

async function doLogout() {
  try { await api('POST','/api/logout'); } catch(e){}
  localStorage.removeItem('tt_token');
  location.reload();
}

// ── Lobby ─────────────────────────────────────────────
function showLobby() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('lobby-screen').style.display='flex';
  document.getElementById('lobby-welcome').textContent = `Welcome, ${myPlayer?.name || 'Adventurer'}!`;
}
function showCreateRoom() {
  hideRoomForms();
  document.getElementById('create-room-form').style.display='flex';
}
function showJoinRoom() {
  hideRoomForms();
  document.getElementById('join-room-form').style.display='flex';
  document.getElementById('room-code-input').focus();
}
function hideRoomForms() {
  document.getElementById('create-room-form').style.display='none';
  document.getElementById('join-room-form').style.display='none';
  document.getElementById('lobby-error').textContent='';
}

async function doCreateRoom() {
  const name = document.getElementById('room-name-input').value.trim();
  try {
    const res = await api('POST','/api/room/create',{name});
    if (res.error) { document.getElementById('lobby-error').textContent=res.error; return; }
    myRoom=res.room; isDM=true;
    document.getElementById('lobby-screen').style.display='none';
    enterApp();
  } catch(e) { document.getElementById('lobby-error').textContent='Server error'; }
}

async function doJoinRoom() {
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (!code) { document.getElementById('lobby-error').textContent='Enter a room code'; return; }
  try {
    const res = await api('POST','/api/room/join',{code});
    if (res.error) { document.getElementById('lobby-error').textContent=res.error; return; }
    myRoom=res.room; isDM=false;
    document.getElementById('lobby-screen').style.display='none';
    enterApp();
  } catch(e) { document.getElementById('lobby-error').textContent='Server error'; }
}

async function leaveRoom() {
  if (!confirm('Leave the room?')) return;
  try { await api('POST','/api/room/leave'); } catch(e){}
  myRoom=null; isDM=false;
  showLobby();
}

// ── Enter App ─────────────────────────────────────────
async function enterApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('lobby-screen').style.display='none';
  document.getElementById('app').style.display='';

  // DM UI
  document.getElementById('dm-badge').style.display = isDM ? '' : 'none';
  document.querySelectorAll('.dm-only').forEach(el => el.classList.toggle('visible', isDM));
  document.getElementById('topbar-room-name').textContent = myRoom?.name || 'Tavern';
  document.getElementById('room-code-badge').textContent  = myRoom?.code || '';

  connectWS();
  await loadAllPlayers();
  populateSheet();
  buildAbilityGrid();
  buildSavesAndSkills();
  initMap();
  await loadChat();
  await loadStoryImages();
  await loadBattle();
  if (isDM) updateDMPanel();
  toast(`Entered ${myRoom?.name || 'the tavern'}!`);
}

// ── WebSocket ─────────────────────────────────────────
function connectWS() {
  const proto = location.protocol==='https:'?'wss':'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    setConn(true);
    ws.send(JSON.stringify({ type:'identify', playerKey: myPlayer?.key, roomCode: myRoom?.code }));
    ping();
  };
  ws.onclose = () => { setConn(false); setTimeout(connectWS, 3000); };
  ws.onerror = () => setConn(false);
  ws.onmessage = e => handleWS(JSON.parse(e.data));
}
function ping() { if(ws&&ws.readyState===1){ ws.send(JSON.stringify({type:'ping'})); setTimeout(ping,25000); } }
function setConn(on) {
  const d=document.getElementById('conn-dot');
  d.style.background = on?'#2d8b2d':'#8b2020';
  d.style.boxShadow  = on?'0 0 6px #2d8b2d':'0 0 6px #8b2020';
}

function handleWS(msg) {
  switch(msg.type) {
    case 'playerUpdate':
      allPlayers[msg.player.key]=msg.player;
      renderPlayers(); renderMapTokens(); if(isDM) updateDMPanel();
      break;
    case 'playerJoined':
      allPlayers[msg.player.key]=msg.player;
      renderPlayers(); renderMapTokens(); if(isDM) updateDMPanel();
      toast(`${msg.player.name} joined the tavern!`);
      break;
    case 'playerLeft':
      delete allPlayers[msg.key];
      renderPlayers(); renderMapTokens(); if(isDM) updateDMPanel();
      break;
    case 'chatMessage': appendChatMsg(msg.msg); break;
    case 'diceRoll':
      if (msg.roll.playerName !== myPlayer?.name) showDiceResult(msg.roll.result, msg.roll.die, msg.roll.modifier, msg.roll.total, msg.roll.playerName);
      break;
    case 'mapDrawing':
      mapStrokes = msg.strokes || [];
      redrawAllStrokes();
      break;
    case 'mapBackground': loadMapBgUrl(msg.url); break;
    case 'tokenMoved':
      if (allPlayers[msg.key]) allPlayers[msg.key].tokenPos={x:msg.x,y:msg.y};
      renderMapTokens();
      break;
    case 'storyImage': prependStoryImage(msg.image); break;
    case 'battleUpdate':
      currentBattle = msg.battle;
      if (msg.battle) renderBattleOverlay(msg.battle);
      if (isDM) updateDMBattleStatus();
      break;
    case 'battleStarted':
      showBattleSplash();
      document.getElementById('battle-overlay').style.display='flex';
      if (isDM) document.getElementById('battle-controls').style.display='flex';
      break;
    case 'battleEnded':
      currentBattle=null;
      document.getElementById('battle-overlay').style.display='none';
      if (isDM) updateDMBattleStatus();
      toast('⚔ Battle ended!');
      break;
  }
}

// ── Players ───────────────────────────────────────────
async function loadAllPlayers() {
  const res = await api('GET','/api/players');
  allPlayers = {};
  (res.players||[]).forEach(p => allPlayers[p.key]=p);
  renderPlayers(); renderMapTokens();
}
function renderPlayers() {
  const list    = document.getElementById('player-cards-list');
  const players = Object.values(allPlayers);
  document.getElementById('online-badge').textContent = players.filter(p=>p.online).length+' online';
  if (!players.length) { list.innerHTML='<div style="color:var(--gold-dim);font-size:.7rem;text-align:center;padding:12px;font-style:italic">Awaiting adventurers...</div>'; return; }
  list.innerHTML='';
  players.forEach(p=>list.appendChild(buildPlayerCard(p)));
}
function buildPlayerCard(p) {
  const isMe   = myPlayer && p.key===myPlayer.key;
  const hpPct  = Math.max(0,Math.min(100,(p.hp/Math.max(1,p.maxHp))*100));
  const hpCls  = hpPct>50?'':hpPct>25?'low':'crit';
  const div    = document.createElement('div');
  div.className= `player-card${isMe?' is-me':''}${!p.online?' offline':''}`;
  div.innerHTML= `
    <div class="pc-top">
      <div class="pc-avatar" style="border-color:${p.drawColor||'#c9922a'}">${p.avatar?`<img src="${p.avatar}"/>`:(p.name||'?')[0].toUpperCase()}</div>
      <div class="pc-info">
        <div class="pc-name">${esc(p.name)}${isMe?' ★':''}</div>
        <div class="pc-class">${esc(p.characterClass||p.race||'Adventurer')}</div>
      </div>
      ${p.online?'<div class="pc-online-dot"></div>':''}
    </div>
    <div class="pc-hp-label"><span>❤ HP</span><span>${p.hp}/${p.maxHp}</span></div>
    <div class="pc-hp-bar"><div class="pc-hp-fill ${hpCls}" style="width:${hpPct}%"></div></div>`;
  if (isMe) div.onclick=()=>switchView('sheet');
  return div;
}

// ── Views ─────────────────────────────────────────────
function switchView(name) {
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  document.getElementById(`view-${name}`)?.classList.add('active');
  if (name==='sheet') populateSheet();
  if (name==='dm' && isDM) updateDMPanel();
}

// ── SHEET ─────────────────────────────────────────────
function buildAbilityGrid() {
  const grid = document.getElementById('ability-grid');
  if (!grid) return;
  grid.innerHTML = SAVE_ATTRS.map(attr => `
    <div class="ability-card">
      <div class="ability-name">${attr}</div>
      <div class="ability-mod" id="mod-${attr}">+0</div>
      <input class="ability-score" type="number" id="s-${attr}" value="10" min="1" max="30" oninput="updateAbilityMod('${attr}');sheetChanged()"/>
      <div class="ability-label">${ABILITY_FULL[attr]}</div>
    </div>`).join('');
}

function populateSheet() {
  if (!myPlayer) return;
  const p = myPlayer;
  setVal('s-name',p.name); setVal('s-class',p.characterClass||'');
  setVal('s-race',p.race||''); setVal('s-background',p.background||'');
  setVal('s-alignment',p.alignment||''); setVal('s-level',p.level||1);
  setVal('s-xp',p.xp||0); setVal('s-prof',p.proficiencyBonus||2);
  setVal('s-ac',p.ac||10); setVal('s-init',p.initiative||0);
  setVal('s-speed',p.speed||30); setVal('s-hp',p.hp||20); setVal('s-maxhp',p.maxHp||20);
  setVal('s-backstory',p.backstory||'');
  setVal('s-proficiencies',Array.isArray(p.proficiencies)?p.proficiencies.join(', '):(p.proficiencies||''));
  SAVE_ATTRS.forEach(a=>{ setVal(`s-${a}`,(p.stats&&p.stats[a])||10); updateAbilityMod(a); });
  updateHpBar(); renderInventory(); renderSpells(); renderFeatures(); buildSavesAndSkills();
  if (p.avatar) {
    document.getElementById('sheet-avatar-text').style.display='none';
    const img=document.getElementById('sheet-avatar-img'); img.src=p.avatar; img.style.display='block';
  }
}
function sheetChanged() {
  if (!myPlayer) return;
  myPlayer.characterClass=getVal('s-class'); myPlayer.race=getVal('s-race');
  myPlayer.background=getVal('s-background'); myPlayer.alignment=getVal('s-alignment');
  myPlayer.level=parseInt(getVal('s-level'))||1; myPlayer.xp=parseInt(getVal('s-xp'))||0;
  myPlayer.proficiencyBonus=parseInt(getVal('s-prof'))||2; myPlayer.ac=parseInt(getVal('s-ac'))||10;
  myPlayer.initiative=parseInt(getVal('s-init'))||0; myPlayer.speed=parseInt(getVal('s-speed'))||30;
  myPlayer.hp=parseInt(getVal('s-hp'))||0; myPlayer.maxHp=parseInt(getVal('s-maxhp'))||1;
  myPlayer.backstory=getVal('s-backstory'); myPlayer.proficiencies=getVal('s-proficiencies');
  if (!myPlayer.stats) myPlayer.stats={};
  SAVE_ATTRS.forEach(a=>{ myPlayer.stats[a]=parseInt(getVal(`s-${a}`))||10; });
  updateHpBar();
  clearTimeout(sheetTimer); sheetTimer=setTimeout(saveMyPlayer,900);
}
function updateAbilityMod(attr) {
  const s=parseInt(getVal(`s-${attr}`))||10;
  const m=Math.floor((s-10)/2);
  const el=document.getElementById(`mod-${attr}`);
  if(el) el.textContent=(m>=0?'+':'')+m;
}
function getAbilityMod(attr) { return Math.floor(((myPlayer?.stats?.[attr]||10)-10)/2); }
function updateHpBar() {
  const hp=parseInt(getVal('s-hp'))||0, mx=parseInt(getVal('s-maxhp'))||1;
  const pct=Math.max(0,Math.min(100,(hp/mx)*100));
  const bar=document.getElementById('s-hp-bar'); if(!bar) return;
  bar.style.width=pct+'%'; bar.className='hp-fill'+(pct>50?'':pct>25?' low':' crit');
}
async function saveMyPlayer() {
  if (!myPlayer||!token) return;
  const res = await api('POST','/api/player',myPlayer).catch(()=>null);
  if (res?.success) showSaveDot();
}

// Saves & Skills
function buildSavesAndSkills() {
  const p=myPlayer||{}; const prof=p.proficiencyBonus||2;
  const saves=p.savingThrows||{}; const profSkills=p.skills||[];
  const sl=document.getElementById('saves-list');
  if(sl) sl.innerHTML=SAVE_ATTRS.map(attr=>{
    const on=saves[attr]||false; const mod=getAbilityMod(attr); const bonus=on?mod+prof:mod;
    return `<div class="save-row" onclick="toggleSave('${attr}')">
      <div class="save-check${on?' on':''}">${on?'✓':''}</div>
      <span class="save-label">${ABILITY_FULL[attr]}</span>
      <span class="save-bonus">${bonus>=0?'+':''}${bonus}</span></div>`;
  }).join('');
  const skl=document.getElementById('skills-list');
  if(skl) skl.innerHTML=DND_SKILLS.map(s=>{
    const on=profSkills.includes(s.name); const mod=getAbilityMod(s.attr); const bonus=on?mod+prof:mod;
    return `<div class="skill-row" onclick="toggleSkill('${s.name}')">
      <div class="skill-check${on?' on':''}">${on?'✓':''}</div>
      <span class="skill-label">${s.name}</span><span class="skill-attr">${s.attr}</span>
      <span class="skill-bonus">${bonus>=0?'+':''}${bonus}</span></div>`;
  }).join('');
}
function toggleSave(attr) {
  if(!myPlayer) return;
  if(!myPlayer.savingThrows) myPlayer.savingThrows={};
  myPlayer.savingThrows[attr]=!myPlayer.savingThrows[attr];
  buildSavesAndSkills(); clearTimeout(sheetTimer); sheetTimer=setTimeout(saveMyPlayer,900);
}
function toggleSkill(name) {
  if(!myPlayer) return;
  if(!myPlayer.skills) myPlayer.skills=[];
  const i=myPlayer.skills.indexOf(name);
  if(i>-1) myPlayer.skills.splice(i,1); else myPlayer.skills.push(name);
  buildSavesAndSkills(); clearTimeout(sheetTimer); sheetTimer=setTimeout(saveMyPlayer,900);
}

// Inventory
function renderInventory() {
  const l=document.getElementById('inventory-list'); if(!l||!myPlayer) return;
  const inv=myPlayer.inventory||[];
  if(!inv.length){l.innerHTML='<div style="color:var(--gold-dim);font-style:italic;font-size:.75rem;padding:4px">Empty pack...</div>';return;}
  l.innerHTML=inv.map((item,i)=>`<div class="item-row"><span class="item-name">⚬ ${esc(item.name||item)}</span>${item.qty?`<span class="item-qty">×${esc(item.qty)}</span>`:''} ${item.note?`<span class="item-note">${esc(item.note)}</span>`:''}<button class="item-del" onclick="removeItem(${i})">✕</button></div>`).join('');
}
function addInventoryItem(){document.getElementById('add-item-row').style.display='flex';document.getElementById('new-item-name').focus();}
function confirmAddItem(){const n=document.getElementById('new-item-name').value.trim();if(!n)return;if(!myPlayer.inventory)myPlayer.inventory=[];myPlayer.inventory.push({name:n,qty:document.getElementById('new-item-qty').value.trim(),note:document.getElementById('new-item-note').value.trim()});cancelAddItem();renderInventory();clearTimeout(sheetTimer);sheetTimer=setTimeout(saveMyPlayer,600);}
function cancelAddItem(){document.getElementById('add-item-row').style.display='none';['new-item-name','new-item-qty','new-item-note'].forEach(id=>document.getElementById(id).value='');}
function removeItem(i){myPlayer.inventory.splice(i,1);renderInventory();clearTimeout(sheetTimer);sheetTimer=setTimeout(saveMyPlayer,600);}

// Spells
function renderSpells(){const l=document.getElementById('spells-list');if(!l||!myPlayer)return;const sp=myPlayer.spells||[];if(!sp.length){l.innerHTML='<div style="color:var(--gold-dim);font-style:italic;font-size:.75rem;padding:4px">No spells...</div>';return;}l.innerHTML=sp.map((s,i)=>`<div class="item-row"><span class="item-name">✨ ${esc(s.name)}</span>${s.level?`<span class="item-level">Lvl ${esc(s.level)}</span>`:''} ${s.desc?`<span class="item-desc">${esc(s.desc)}</span>`:''}<button class="item-del" onclick="removeSpell(${i})">✕</button></div>`).join('');}
function addSpell(){document.getElementById('add-spell-row').style.display='flex';document.getElementById('new-spell-name').focus();}
function confirmAddSpell(){const n=document.getElementById('new-spell-name').value.trim();if(!n)return;if(!myPlayer.spells)myPlayer.spells=[];myPlayer.spells.push({name:n,level:document.getElementById('new-spell-level').value.trim(),desc:document.getElementById('new-spell-desc').value.trim()});cancelAddSpell();renderSpells();clearTimeout(sheetTimer);sheetTimer=setTimeout(saveMyPlayer,600);}
function cancelAddSpell(){document.getElementById('add-spell-row').style.display='none';['new-spell-name','new-spell-level','new-spell-desc'].forEach(id=>document.getElementById(id).value='');}
function removeSpell(i){myPlayer.spells.splice(i,1);renderSpells();clearTimeout(sheetTimer);sheetTimer=setTimeout(saveMyPlayer,600);}

// Features
function renderFeatures(){const l=document.getElementById('features-list');if(!l||!myPlayer)return;const f=myPlayer.features||[];if(!f.length){l.innerHTML='<div style="color:var(--gold-dim);font-style:italic;font-size:.75rem;padding:4px">No features...</div>';return;}l.innerHTML=f.map((ft,i)=>`<div class="item-row"><span class="item-name">⭐ ${esc(ft.name)}</span>${ft.desc?`<span class="item-desc">${esc(ft.desc)}</span>`:''}<button class="item-del" onclick="removeFeature(${i})">✕</button></div>`).join('');}
function addFeature(){document.getElementById('add-feature-row').style.display='flex';document.getElementById('new-feature-name').focus();}
function confirmAddFeature(){const n=document.getElementById('new-feature-name').value.trim();if(!n)return;if(!myPlayer.features)myPlayer.features=[];myPlayer.features.push({name:n,desc:document.getElementById('new-feature-desc').value.trim()});cancelAddFeature();renderFeatures();clearTimeout(sheetTimer);sheetTimer=setTimeout(saveMyPlayer,600);}
function cancelAddFeature(){document.getElementById('add-feature-row').style.display='none';['new-feature-name','new-feature-desc'].forEach(id=>document.getElementById(id).value='');}
function removeFeature(i){myPlayer.features.splice(i,1);renderFeatures();clearTimeout(sheetTimer);sheetTimer=setTimeout(saveMyPlayer,600);}

// Avatar
async function uploadAvatar(e) {
  const file=e.target.files[0]; if(!file) return;
  const fd=new FormData(); fd.append('avatar',file);
  const res=await fetch('/api/upload/avatar',{method:'POST',headers:{'x-session-token':token},body:fd}).then(r=>r.json()).catch(()=>null);
  if(res?.url){myPlayer.avatar=res.url;document.getElementById('sheet-avatar-text').style.display='none';const img=document.getElementById('sheet-avatar-img');img.src=res.url+'?t='+Date.now();img.style.display='block';toast('Portrait updated!');}
}

// ── MAP (per-player colored strokes) ──────────────────
function initMap() {
  const container=document.getElementById('map-container');
  const bgC=document.getElementById('map-bg-canvas');
  const drC=document.getElementById('map-draw-canvas');
  const W=container.offsetWidth||700, H=container.offsetHeight||350;
  [bgC,drC].forEach(c=>{c.width=W;c.height=H;});
  mapBgCtx =bgC.getContext('2d');
  mapDrawCtx=drC.getContext('2d');
  mapDrawCtx.lineCap='round'; mapDrawCtx.lineJoin='round';

  drC.addEventListener('mousedown',  mapStart);
  drC.addEventListener('mousemove',  mapMove);
  drC.addEventListener('mouseup',    mapEnd);
  drC.addEventListener('mouseleave', mapEnd);
  drC.addEventListener('touchstart', e=>{e.preventDefault();mapStart(e.touches[0]);},{passive:false});
  drC.addEventListener('touchmove',  e=>{e.preventDefault();mapMove(e.touches[0]);},{passive:false});
  drC.addEventListener('touchend',   mapEnd);

  api('GET','/api/map').then(data=>{
    if (data.strokes && data.strokes.length) { mapStrokes=data.strokes; redrawAllStrokes(); }
    if (data.background) loadMapBgUrl(data.background);
    (data.players||[]).forEach(p=>{ if(!allPlayers[p.key]) allPlayers[p.key]=p; });
    renderMapTokens();
  }).catch(()=>{});
}

function getMapPos(e) {
  const r=document.getElementById('map-draw-canvas').getBoundingClientRect();
  return {x:e.clientX-r.left, y:e.clientY-r.top};
}

function mapStart(e) {
  if (mapTool==='move') return;
  mapIsDrawing=true;
  const pos=getMapPos(e);
  currentStroke={ color: myPlayer?.drawColor||'#c9922a', width:2, points:[pos] };
}
function mapMove(e) {
  if (!mapIsDrawing||!currentStroke) return;
  const pos=getMapPos(e);
  if (mapTool==='erase') {
    // Erase nearby points from all strokes
    mapStrokes.forEach(s=>{ s.points=s.points.filter(p=>Math.hypot(p.x-pos.x,p.y-pos.y)>16); });
    redrawAllStrokes();
    scheduleSendStrokes();
    return;
  }
  currentStroke.points.push(pos);
  // Draw incremental
  const pts=currentStroke.points;
  if (pts.length>=2) {
    const last=pts[pts.length-2], cur=pts[pts.length-1];
    mapDrawCtx.beginPath();
    mapDrawCtx.strokeStyle=currentStroke.color;
    mapDrawCtx.lineWidth=currentStroke.width;
    mapDrawCtx.moveTo(last.x,last.y);
    mapDrawCtx.lineTo(cur.x,cur.y);
    mapDrawCtx.stroke();
  }
}
function mapEnd() {
  if (!mapIsDrawing||!currentStroke) return;
  mapIsDrawing=false;
  if (mapTool!=='erase' && currentStroke.points.length>1) {
    mapStrokes.push(currentStroke);
  }
  currentStroke=null;
  scheduleSendStrokes();
}
function scheduleSendStrokes() {
  clearTimeout(mapSendTimer);
  mapSendTimer=setTimeout(()=>{ api('POST','/api/map/drawing',{strokes:mapStrokes}).catch(()=>{}); }, 400);
}
function redrawAllStrokes() {
  const c=document.getElementById('map-draw-canvas');
  mapDrawCtx.clearRect(0,0,c.width,c.height);
  mapStrokes.forEach(stroke=>{
    if (!stroke.points||stroke.points.length<2) return;
    mapDrawCtx.beginPath();
    mapDrawCtx.strokeStyle=stroke.color||'#c9922a';
    mapDrawCtx.lineWidth=stroke.width||2;
    mapDrawCtx.lineCap='round'; mapDrawCtx.lineJoin='round';
    mapDrawCtx.moveTo(stroke.points[0].x,stroke.points[0].y);
    stroke.points.slice(1).forEach(p=>mapDrawCtx.lineTo(p.x,p.y));
    mapDrawCtx.stroke();
  });
}
function clearMapDraw() {
  mapStrokes=[];
  const c=document.getElementById('map-draw-canvas');
  mapDrawCtx.clearRect(0,0,c.width,c.height);
  api('POST','/api/map/drawing',{strokes:[]}).catch(()=>{});
}
function setTool(tool) {
  mapTool=tool;
  document.querySelectorAll('.map-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById(`tool-${tool}`)?.classList.add('active');
  const layer=document.getElementById('map-tokens-layer');
  layer.style.pointerEvents=tool==='move'?'all':'none';
}
function loadMapBgUrl(url) {
  const c=document.getElementById('map-bg-canvas');
  const img=new Image();
  img.onload=()=>{mapBgCtx.clearRect(0,0,c.width,c.height);mapBgCtx.drawImage(img,0,0,c.width,c.height);};
  img.src=url;
}
async function uploadMapBg(e) {
  const file=e.target.files[0]; if(!file) return;
  const fd=new FormData(); fd.append('map',file);
  const res=await fetch('/api/upload/map',{method:'POST',headers:{'x-session-token':token},body:fd}).then(r=>r.json()).catch(()=>null);
  if(res?.url){loadMapBgUrl(res.url);toast('Map background updated!');}
}

// Tokens
function renderMapTokens() {
  const layer=document.getElementById('map-tokens-layer'); if(!layer) return;
  layer.innerHTML='';
  Object.values(allPlayers).forEach(p=>{
    if(!p.online&&p.key!==myPlayer?.key) return;
    const pos=p.tokenPos||{x:200,y:150};
    const el=document.createElement('div');
    el.className='map-token';
    el.style.left=pos.x+'px'; el.style.top=pos.y+'px';
    el.style.borderColor=p.tokenColor||'#c9922a';
    el.style.boxShadow=`0 0 8px ${p.tokenColor||'#c9922a'}`;
    el.title=p.name;
    if(p.avatar) { const img=document.createElement('img'); img.src=p.avatar; el.appendChild(img); }
    else el.textContent=(p.name||'?')[0].toUpperCase();
    if(myPlayer&&p.key===myPlayer.key) makeDraggable(el,p.key);
    else el.style.pointerEvents='none';
    layer.appendChild(el);
  });
}
function makeDraggable(el,key) {
  let drag=false,ox=0,oy=0;
  const start=e=>{drag=true;const p=getEvtPos(e);ox=p.x-parseFloat(el.style.left);oy=p.y-parseFloat(el.style.top);el.style.cursor='grabbing';e.preventDefault&&e.preventDefault();};
  const move=e=>{if(!drag)return;const p=getEvtPos(e);el.style.left=(p.x-ox)+'px';el.style.top=(p.y-oy)+'px';};
  const end=()=>{if(!drag)return;drag=false;el.style.cursor='grab';const x=parseFloat(el.style.left),y=parseFloat(el.style.top);if(myPlayer)myPlayer.tokenPos={x,y};api('POST','/api/map/token',{x,y}).catch(()=>{});};
  el.addEventListener('mousedown',start);
  document.addEventListener('mousemove',move); document.addEventListener('mouseup',end);
  el.addEventListener('touchstart',e=>start(e.touches[0]),{passive:false});
  document.addEventListener('touchmove',e=>move(e.touches[0]),{passive:false});
  document.addEventListener('touchend',end);
}
function getEvtPos(e) {
  const r=document.getElementById('map-tokens-layer').getBoundingClientRect();
  return{x:(e.clientX||0)-r.left,y:(e.clientY||0)-r.top};
}

// ── DICE ──────────────────────────────────────────────
const DICE_SHAPES={
  4:{p:'50,8 92,78 8,78',i:'50,22 80,68 20,68'},
  6:{p:'15,15 85,15 95,50 85,85 15,85 5,50',i:'22,22 78,22 88,50 78,78 22,78 12,50'},
  8:{p:'50,5 95,50 50,95 5,50',i:'50,18 82,50 50,82 18,50'},
  10:{p:'50,5 90,30 90,70 50,95 10,70 10,30',i:'50,16 82,36 82,64 50,84 18,64 18,36'},
  12:{p:'50,5 80,15 96,47 80,82 50,95 20,82 4,47 20,15',i:'50,16 74,26 88,50 74,76 50,86 26,76 12,50 26,26'},
  20:{p:'50,5 95,28 95,72 50,95 5,72 5,28',i:'50,16 84,34 84,66 50,84 16,66 16,34'}
};
function selectDie(sides,btn) {
  selectedDie=sides;
  document.querySelectorAll('.die-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  const s=DICE_SHAPES[sides]||DICE_SHAPES[20];
  document.getElementById('dice-shape').setAttribute('points',s.p);
  document.getElementById('dice-inner').setAttribute('points',s.i);
  document.getElementById('dice-num').textContent=sides;
}
async function rollDice() {
  if (!myPlayer) { toast('Log in first!'); return; }
  const result=Math.floor(Math.random()*selectedDie)+1;
  const die=`d${selectedDie}`;
  const modifier=parseInt(document.getElementById('dice-modifier').value)||0;
  const label=document.getElementById('dice-label-input').value.trim();
  const total=result+modifier;
  const svg=document.getElementById('dice-svg');
  svg.classList.remove('dice-rolling'); void svg.offsetWidth; svg.classList.add('dice-rolling');
  diceSound();
  let t=setInterval(()=>{document.getElementById('dice-num').textContent=Math.floor(Math.random()*selectedDie)+1;},55);
  setTimeout(()=>{clearInterval(t);svg.classList.remove('dice-rolling');document.getElementById('dice-num').textContent=result;showDiceResult(result,die,modifier,total,myPlayer.name);},620);
  await api('POST','/api/dice',{result,die,modifier,total,label}).catch(()=>{});
}
function showDiceResult(result,die,modifier,total,playerName) {
  const sides=parseInt(die.replace('d',''));
  let cls='',label='';
  if(result===sides&&sides===20){cls='crit';label='✦ NATURAL 20! ✦';}
  else if(result===1){cls='fumble';label='☠ FUMBLE! ☠';}
  else if(result>=Math.floor(sides*.8)) label='Excellent!';
  else if(result<=Math.ceil(sides*.2))  label='Poor fortune...';
  else label=`${die} Roll`;
  const numEl=document.getElementById('roll-num');
  numEl.className='roll-num '+cls; numEl.textContent=total;
  const modStr=modifier?(` (${result}${modifier>0?`+${modifier}`:modifier})`):'';
  document.getElementById('roll-label').textContent=label+modStr;
  document.getElementById('roll-by').textContent=playerName?`— ${playerName} —`:'';
}
function diceSound(){try{const ctx=new(window.AudioContext||window.webkitAudioContext)();[[400,80,0,.4,'sawtooth'],[200,120,.44,.65,'triangle']].forEach(([f1,f2,start,end,type])=>{const o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.type=type;o.frequency.setValueAtTime(f1,ctx.currentTime+start);o.frequency.exponentialRampToValueAtTime(f2,ctx.currentTime+end);g.gain.setValueAtTime(.15,ctx.currentTime+start);g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+end+.05);o.start(ctx.currentTime+start);o.stop(ctx.currentTime+end+.1);});}catch(e){}}

// ── CHAT ──────────────────────────────────────────────
function setChatType(t){chatType=t;document.querySelectorAll('.chat-tab').forEach(b=>b.classList.toggle('active',b.dataset.type===t));}
async function sendChat(){const el=document.getElementById('chat-input');const msg=el.value.trim();if(!msg)return;el.value='';await api('POST','/api/chat',{message:msg,type:chatType}).catch(()=>{});}
async function loadChat(){const res=await api('GET','/api/chat').catch(()=>({messages:[]}));const box=document.getElementById('chat-messages');box.innerHTML='';(res.messages||[]).forEach(m=>appendChatMsg(m,false));box.scrollTop=box.scrollHeight;}
function appendChatMsg(msg,scroll=true){
  const box=document.getElementById('chat-messages');if(!box)return;
  const div=document.createElement('div');div.className=`chat-msg type-${msg.type||'ooc'}`;
  const av=msg.avatar?`<img src="${msg.avatar}"/>`:(msg.playerName||'?')[0].toUpperCase();
  const text=esc(msg.message).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  div.innerHTML=`<div class="msg-avatar">${av}</div><div class="msg-body"><div class="msg-name">${esc(msg.playerName||'?')}${msg.type==='ic'?' <em style="color:var(--gold-dim);font-size:.58rem">[IC]</em>':''}</div><div class="msg-text">${text}</div></div>`;
  box.appendChild(div);if(scroll)box.scrollTop=box.scrollHeight;
}

// ── STORY ─────────────────────────────────────────────
async function loadStoryImages(){const res=await api('GET','/api/story-images').catch(()=>({images:[]}));const g=document.getElementById('story-gallery');if(g)g.innerHTML='';(res.images||[]).forEach(img=>prependStoryImage(img,false));}
function uploadStoryImage(e){const file=e.target.files[0];if(!file)return;storyFD=new FormData();storyFD.append('image',file);document.getElementById('story-caption-row').style.display='flex';document.getElementById('story-caption').focus();}
async function confirmStoryUpload(){if(!storyFD)return;storyFD.append('caption',document.getElementById('story-caption').value.trim());await fetch('/api/upload/story',{method:'POST',headers:{'x-session-token':token},body:storyFD}).then(r=>r.json()).catch(()=>{});cancelStoryUpload();}
function cancelStoryUpload(){storyFD=null;document.getElementById('story-caption-row').style.display='none';document.getElementById('story-caption').value='';}
function prependStoryImage(img,prepend=true){const g=document.getElementById('story-gallery');if(!g)return;const card=document.createElement('div');card.className='story-card';card.innerHTML=`<img src="${img.url}" alt="${esc(img.caption||'')}" loading="lazy"/><div class="story-card-info">${img.caption?`<div class="story-caption">${esc(img.caption)}</div>`:''}<div class="story-meta">${esc(img.uploadedBy)} · ${new Date(img.timestamp).toLocaleString()}</div></div>`;if(prepend&&g.firstChild)g.insertBefore(card,g.firstChild);else g.appendChild(card);}

// ══════════════════════════════════════════════════════
// ── BATTLE SYSTEM ─────────────────────────────────────
// ══════════════════════════════════════════════════════

async function loadBattle() {
  const res = await api('GET','/api/battle').catch(()=>({battle:null}));
  if (res.battle) {
    currentBattle=res.battle;
    if (res.battle.state==='active'||res.battle.state==='rolling') {
      renderBattleOverlay(res.battle);
      document.getElementById('battle-overlay').style.display='flex';
      if (isDM) document.getElementById('battle-controls').style.display='flex';
    }
  }
  if (isDM) updateDMBattleStatus();
}

// DM Panel
function updateDMPanel() {
  // Players list in DM panel
  const list=document.getElementById('dm-players-list');
  if (!list) return;
  const players=Object.values(allPlayers);
  if (!players.length){list.innerHTML='<div style="color:var(--gold-dim);font-size:.7rem;font-style:italic">No players yet...</div>';return;}
  list.innerHTML=players.map(p=>`
    <div class="dm-player-row">
      <div class="dm-player-name">${esc(p.name)} ${p.online?'🟢':''} ${isDM&&p.key===myPlayer?.key?'(DM)':''}</div>
      <div class="dm-player-hp">❤ ${p.hp}/${p.maxHp}</div>
    </div>`).join('');
  updateDMBattleStatus();
}

function updateDMBattleStatus() {
  const box=document.getElementById('dm-battle-status'); if(!box) return;
  if (!currentBattle) {
    box.innerHTML='<div style="color:var(--gold-dim);font-size:.72rem;font-style:italic">No active encounter</div>';
    return;
  }
  const st=currentBattle.state;
  box.innerHTML=`<div class="battle-status-box${st==='active'?' battle-status-active':''}">
    <div style="font-family:var(--fn-head);font-size:.72rem;color:var(--gold2)">
      ${st==='setup'?'⚙ Setup':st==='rolling'?'🎲 Rolling Initiative':st==='active'?`⚔ Round ${currentBattle.round}`:st==='ended'?'✓ Ended':''}
    </div>
    ${st==='setup'?`<button class="btn btn-sm" style="margin-top:6px" onclick="rollInitiative()">🎲 Roll Initiative</button>`:''}
    ${st==='rolling'?`<button class="btn btn-primary" style="margin-top:6px" onclick="startBattle()">⚔ Start Battle!</button>`:''}
    ${st==='active'?`<div style="font-size:.65rem;color:var(--parch2);margin-top:4px">Turn: ${currentBattle.initiativeOrder[currentBattle.currentTurn]?.name||'?'}</div>`:''}
  </div>`;
}

// ── Battle Setup ──────────────────────────────────────
let monsterSlots = [];

function openBattleSetup() {
  monsterSlots=[];
  document.getElementById('monster-list-editor').innerHTML='';
  addMonsterSlot();
  document.getElementById('battle-setup-modal').style.display='flex';
}
function closeBattleSetup() { document.getElementById('battle-setup-modal').style.display='none'; }

function addMonsterSlot() {
  const id=`ms_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  monsterSlots.push({id,image:'',row:'front'});
  const div=document.createElement('div');
  div.className='monster-slot'; div.id=`slot_${id}`;
  div.innerHTML=`
    <button class="monster-del" onclick="removeMonsterSlot('${id}')">✕</button>
    <div class="monster-slot-header">
      <div class="monster-preview" id="preview_${id}" onclick="triggerMonsterImg('${id}')">🐉
        <input type="file" id="img_${id}" accept="image/*" style="display:none" onchange="uploadMonsterImg('${id}',this)"/>
      </div>
      <div class="monster-slot-fields">
        <div class="m-field"><div class="m-label">Name</div><input class="m-input" id="mn_${id}" placeholder="Dragon, Goblin..." maxlength="40"/></div>
        <div class="m-field"><div class="m-label">CR</div><input class="m-input" id="mcr_${id}" placeholder="1/2, 5..." maxlength="6"/></div>
      </div>
    </div>
    <div class="monster-row-3">
      <div class="m-field"><div class="m-label">HP</div><input class="m-input" type="number" id="mhp_${id}" placeholder="30" min="1"/></div>
      <div class="m-field"><div class="m-label">AC</div><input class="m-input" type="number" id="mac_${id}" placeholder="13" min="1"/></div>
      <div class="m-field"><div class="m-label">DEX (init)</div><input class="m-input" type="number" id="mdex_${id}" placeholder="10" min="1" max="30"/></div>
    </div>
    <div class="m-field" style="margin-top:6px"><div class="m-label">Attacks / Notes</div><input class="m-input" id="matk_${id}" placeholder="Bite +5 (1d8+3), Claw +5..." maxlength="120"/></div>
    <div class="row-select">
      <div class="row-btn active" id="rbf_${id}" onclick="setMonsterRow('${id}','front')">Front Row</div>
      <div class="row-btn" id="rbb_${id}" onclick="setMonsterRow('${id}','back')">Back Row</div>
    </div>
    <div class="monster-count-row">
      <label>Count:</label>
      <input type="number" id="mcount_${id}" value="1" min="1" max="10"/>
      <span style="font-size:.65rem;color:var(--gold-dim);font-style:italic">monsters of this type</span>
    </div>`;
  document.getElementById('monster-list-editor').appendChild(div);
}

function removeMonsterSlot(id) {
  monsterSlots=monsterSlots.filter(s=>s.id!==id);
  document.getElementById(`slot_${id}`)?.remove();
}
function setMonsterRow(id,row) {
  const slot=monsterSlots.find(s=>s.id===id); if(slot) slot.row=row;
  document.getElementById(`rbf_${id}`)?.classList.toggle('active',row==='front');
  document.getElementById(`rbb_${id}`)?.classList.toggle('active',row==='back');
}
function triggerMonsterImg(id) { document.getElementById(`img_${id}`)?.click(); }
async function uploadMonsterImg(id,input) {
  const file=input.files[0]; if(!file) return;
  const fd=new FormData(); fd.append('image',file);
  const res=await fetch('/api/battle/monster-image',{method:'POST',headers:{'x-session-token':token},body:fd}).then(r=>r.json()).catch(()=>null);
  if(res?.url){
    const slot=monsterSlots.find(s=>s.id===id); if(slot) slot.image=res.url;
    const prev=document.getElementById(`preview_${id}`);
    if(prev){prev.innerHTML=`<img src="${res.url}"/><input type="file" id="img_${id}" accept="image/*" style="display:none" onchange="uploadMonsterImg('${id}',this)"/>`;}
  }
}

async function launchBattle() {
  const monsters=[];
  for (const slot of monsterSlots) {
    const name=document.getElementById(`mn_${slot.id}`)?.value.trim()||'Monster';
    const hp=parseInt(document.getElementById(`mhp_${slot.id}`)?.value)||10;
    const ac=parseInt(document.getElementById(`mac_${slot.id}`)?.value)||10;
    const dex=parseInt(document.getElementById(`mdex_${slot.id}`)?.value)||10;
    const attacks=document.getElementById(`matk_${slot.id}`)?.value.trim()||'';
    const cr=document.getElementById(`mcr_${slot.id}`)?.value.trim()||'?';
    const count=parseInt(document.getElementById(`mcount_${slot.id}`)?.value)||1;
    const row=slot.row||'front';
    const image=slot.image||'';
    for (let i=0;i<Math.min(count,10);i++) {
      monsters.push({name:count>1?`${name} ${i+1}`:name,hp,maxHp:hp,ac,dex,attacks,cr,row,image});
    }
  }
  if (!monsters.length){toast('Add at least one monster!');return;}
  const res=await api('POST','/api/battle/setup',{monsters}).catch(()=>null);
  if(res?.success){closeBattleSetup();updateDMBattleStatus();toast('Encounter ready! Roll initiative to begin.');}
}

async function rollInitiative() { await api('POST','/api/battle/roll-initiative').catch(()=>{}); }
async function startBattle()    { await api('POST','/api/battle/start').catch(()=>{}); }
async function nextTurn()       { await api('POST','/api/battle/next-turn').catch(()=>{}); }
async function endBattle() {
  if (!confirm('End the battle?')) return;
  await api('POST','/api/battle/end').catch(()=>{});
}

// ── Battle Overlay Render ─────────────────────────────
function renderBattleOverlay(battle) {
  if (!battle) return;
  document.getElementById('battle-round-info').textContent = `Round ${battle.round||1}`;

  // Initiative bar
  const bar=document.getElementById('initiative-bar');
  if (bar && battle.initiativeOrder?.length) {
    bar.innerHTML=battle.initiativeOrder.map((c,i)=>`
      <div class="init-chip${i===battle.currentTurn?' active':''}${c.type==='monster'?' monster-chip':''}">
        ${c.type==='monster'?'☠':'⚔'} ${esc(c.name)} <span class="init-num">${c.initiative}</span>
      </div>`).join('');
  }

  // Monsters
  const mFront=document.getElementById('battle-monsters-front');
  const mBack =document.getElementById('battle-monsters-back');
  if(mFront) mFront.innerHTML='';
  if(mBack)  mBack.innerHTML='';
  (battle.monsters||[]).forEach(m=>{
    const card=buildCombatantCard(m,'monster',battle);
    const target=m.row==='back'?mBack:mFront;
    if(target) target.appendChild(card);
  });

  // Players
  const pFront=document.getElementById('battle-players-front');
  const pBack =document.getElementById('battle-players-back');
  if(pFront) pFront.innerHTML='';
  if(pBack)  pBack.innerHTML='';
  // Use initiativeOrder for player row assignment
  const playerRows={};
  Object.values(allPlayers).forEach(p=>{playerRows[p.key]=p.tokenRow||'front';});
  Object.values(allPlayers).forEach(p=>{
    const card=buildCombatantCard(p,'player',battle);
    const target=playerRows[p.key]==='back'?pBack:pFront;
    if(target) target.appendChild(card);
  });

  // DM controls
  if(isDM) {
    document.getElementById('battle-controls').style.display=battle.state==='active'?'flex':'none';
  }
}

function buildCombatantCard(entity, type, battle) {
  const div=document.createElement('div');
  const isMonster=type==='monster';
  let isActive=false;
  if(battle.initiativeOrder&&battle.state==='active') {
    const cur=battle.initiativeOrder[battle.currentTurn];
    isActive=cur&&(isMonster?cur.id===entity.id:cur.id===entity.key);
  }
  const isDead=(entity.hp||0)<=0;
  div.className=`combatant-card${isMonster?' monster-card':''}${isActive?' active-turn':''}${isDead?' dead':''}`;

  const hpPct=Math.max(0,Math.min(100,((entity.hp||0)/Math.max(1,entity.maxHp||entity.maxHp||20))*100));
  const hpCls=hpPct>50?'':hpPct>25?' low':' crit';
  const avatarHtml=entity.image||entity.avatar
    ?`<img src="${entity.image||entity.avatar}"/>`
    :(entity.name||'?')[0].toUpperCase();
  const color=isMonster?'var(--red)':'var(--gold)';

  div.innerHTML=`
    <div class="cc-avatar" style="color:${color};border-color:${color}">${avatarHtml}</div>
    <div class="cc-name" title="${esc(entity.name||entity.name||'?')}">${esc((entity.name||entity.name||'?').slice(0,12))}</div>
    <div class="cc-hp-bar"><div class="cc-hp-fill${hpCls}" style="width:${hpPct}%"></div></div>
    <div class="cc-hp-text">${entity.hp||0}/${entity.maxHp||entity.maxHp||20}</div>
    ${isMonster&&isDM?`<div class="cc-hp-edit"><input type="number" value="${entity.hp||0}" min="0" id="mhp_live_${entity.id}" style="width:44px"/><button onclick="setMonsterHp('${entity.id}')">✓</button></div>`:''}
    ${isMonster&&isDM&&entity.attacks?`<div style="font-size:.54rem;color:var(--parch2);margin-top:2px;font-style:italic">${esc(entity.attacks.slice(0,40))}</div>`:''}
  `;
  return div;
}

async function setMonsterHp(monsterId) {
  const input=document.getElementById(`mhp_live_${monsterId}`);
  if (!input) return;
  const hp=parseInt(input.value)||0;
  await api('POST','/api/battle/monster-hp',{monsterId,hp}).catch(()=>{});
}

// Battle splash animation
function showBattleSplash() {
  const splash=document.getElementById('battle-splash');
  splash.style.display='flex';
  setTimeout(()=>{splash.style.display='none';},2700);
}

// ── DM Monster Dice Roll ──────────────────────────────
// DM can roll for each monster in turn
window.rollForMonster = async function(monsterName) {
  const result=Math.floor(Math.random()*20)+1;
  await api('POST','/api/dice',{result,die:'d20',modifier:0,total:result,label:'Attack',monsterName}).catch(()=>{});
};

// ── Helpers ───────────────────────────────────────────
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function setVal(id,v){const el=document.getElementById(id);if(el)el.value=v;}
function getVal(id){const el=document.getElementById(id);return el?el.value:'';}
function toast(msg,dur=2600){const el=document.getElementById('toast');el.textContent=msg;el.classList.add('on');setTimeout(()=>el.classList.remove('on'),dur);}
function showSaveDot(){const el=document.getElementById('save-dot');el.classList.add('on');setTimeout(()=>el.classList.remove('on'),1800);}

document.addEventListener('keydown',e=>{
  if(e.key===' '&&document.activeElement.tagName==='BODY'){e.preventDefault();rollDice();}
});
