/* خط‌خطی — server.js
 * Zero external dependencies: plain Node http + a minimal hand-rolled WebSocket
 * server (RFC 6455) plus authoritative game-room logic. Just `node server.js`.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADVANCE_DELAY = process.env.FAST_TEST === '1' ? 300 : 4500;

/* ============================= static file ============================= */
const indexPath = path.join(__dirname, 'public', 'index.html');
function loadIndex(){ return fs.readFileSync(indexPath); }
let indexHtml = loadIndex();

/* ============================= WebSocket (RFC 6455) ============================= */
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function acceptKey(key){
  return crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
}
function encodeFrame(opcode, payload){
  const len = payload.length;
  let header;
  if(len < 126){
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if(len < 65536){
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}
function sendText(socket, str){
  try{ socket.write(encodeFrame(0x1, Buffer.from(str, 'utf8'))); }catch(e){}
}
function sendPing(socket){ try{ socket.write(encodeFrame(0x9, Buffer.alloc(0))); }catch(e){} }
function sendPong(socket, payload){ try{ socket.write(encodeFrame(0xA, payload)); }catch(e){} }

function makeFrameParser(onFrame){
  let buf = Buffer.alloc(0);
  return function feed(chunk){
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while(true){
      if(buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if(len === 126){
        if(buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if(len === 127){
        if(buf.length < 10) return;
        len = buf.readUInt32BE(6); // assume payload fits in 32 bits (fine for this app)
        offset = 10;
      }
      let maskKey = null;
      if(masked){
        if(buf.length < offset + 4) return;
        maskKey = buf.slice(offset, offset + 4);
        offset += 4;
      }
      if(buf.length < offset + len) return;
      let payload = buf.slice(offset, offset + len);
      if(masked){
        const un = Buffer.alloc(len);
        for(let i=0;i<len;i++) un[i] = payload[i] ^ maskKey[i % 4];
        payload = un;
      }
      buf = buf.slice(offset + len);
      onFrame(opcode, payload);
    }
  };
}

/* ============================= game utils ============================= */
function genId(p){ return (p||'id') + '_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36); }
function genRoomCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s=''; for(let i=0;i<5;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function normalizeFa(str){
  if(!str) return '';
  return str.toString().trim().toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g,'')
    .replace(/ي/g,'ی').replace(/ك/g,'ک')
    .replace(/[\u200c\s]+/g,'')
    .replace(/[أإآ]/g,'ا').replace(/ة/g,'ه');
}
function clamp(n,a,b){ return Math.max(a, Math.min(b, n)); }
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){ const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}

const WORDS = ["اسب","گربه","سگ","ماهی","پرنده","فیل","شیر","ببر","خرس","خرگوش","گاو","گوسفند","بز","اردک","مرغ","خروس","جغد","روباه","گرگ","میمون","زرافه","پنگوئن","لاک‌پشت","قورباغه","مار","عنکبوت","پروانه","زنبور","مورچه",
"خورشید","ماه","ستاره","ابر","باران","برف","رنگین‌کمان","کوه","دریا","درخت","گل","کاکتوس",
"خانه","قلعه","چادر","ماشین","دوچرخه","هواپیما","قایق","کشتی","قطار","موشک",
"کتاب","مداد","قیچی","ساعت","عینک","چتر","کلاه","کفش","پیراهن",
"توپ","گیتار","پیانو","طبل","تلفن","تلویزیون","کامپیوتر","دوربین","هدفون",
"صندلی","میز","تخت‌خواب","آینه","شمع","چراغ","فنجان","قاشق","چاقو",
"پیتزا","همبرگر","ساندویچ","بستنی","کیک","سیب","موز","هندوانه","توت‌فرنگی","انگور","پرتقال","تخم‌مرغ","نان","پنیر",
"آدم‌برفی","بادکنک","تاج","شمشیر","سپر","اژدها","ربات","فضانورد","سیاره"];

function pickWords(usedSet, n){
  const pool = WORDS.filter(w=> !usedSet.has(w));
  const src = pool.length >= n ? pool : WORDS.slice();
  const out = []; const copy = src.slice();
  while(out.length < n && copy.length){
    const i = Math.floor(Math.random()*copy.length);
    out.push(copy.splice(i,1)[0]);
  }
  return out;
}
function buildOptions(word){
  const others = WORDS.filter(w=> w !== word);
  const distractors = shuffle(others).slice(0, 9);
  return shuffle([word].concat(distractors));
}

/* ============================= room state ============================= */
const rooms = new Map(); // code -> room

function newRoom(code, hostId){
  return {
    code, hostId, status:'lobby', rounds:2, turnSeconds:60,
    players: new Map(), turnOrder: [], currentRound:1, currentTurnIndex:0,
    currentDrawerId:null, turnSeq:0, currentWord:null, currentOptions:[],
    usedWords: new Set(), turnStartAt:0, turnEndAt:0, guessedIds: new Set(), turnScores:{},
    currentStrokes: [], turnTimer:null, advanceTimer:null, emptyCleanupTimer:null,
    answers: {}
  };
}

function activePlayers(room){ return Array.from(room.players.values()).filter(p=>p.connected); }

function send(player, type, data){
  if(!player || !player.connected || !player.socket) return;
  sendText(player.socket, JSON.stringify(Object.assign({}, data||{}, {type})));
}
function broadcastAll(room, type, data){
  room.players.forEach(p=> send(p, type, data));
}
function broadcastExcept(room, type, data, exceptId){
  room.players.forEach(p=>{ if(p.id !== exceptId) send(p, type, data); });
}

function publicPlayers(room){
  const out = {};
  room.players.forEach((p,id)=>{ out[id] = {id:p.id, name:p.name, colorIdx:p.colorIdx, score:p.score, connected:p.connected}; });
  return out;
}
function publicMeta(room, forId){
  const isDrawer = room.currentDrawerId === forId;
  const wordLen = room.currentWord ? room.currentWord.replace(/[\u200c\s]/g,'').length : 0;
  return {
    code: room.code, hostId: room.hostId, status: room.status,
    rounds: room.rounds, turnSeconds: room.turnSeconds,
    turnOrder: room.turnOrder, currentRound: room.currentRound, currentTurnIndex: room.currentTurnIndex,
    currentDrawerId: room.currentDrawerId, turnSeq: room.turnSeq,
    currentWord: isDrawer ? room.currentWord : null,
    wordLen: wordLen,
    options: (!isDrawer && room.status==='drawing') ? room.currentOptions : [],
    turnEndAt: room.turnEndAt,
    guessedIds: Array.from(room.guessedIds||[]),
    turnScores: room.turnScores || {},
    myAnswer: (room.answers && room.answers[forId]) ? room.answers[forId] : null,
    lastWordReveal: room.status==='turnEnd' ? room.currentWord : null
  };
}
function broadcastState(room){
  room.players.forEach(p=>{
    send(p, 'state', { meta: publicMeta(room, p.id), players: publicPlayers(room) });
  });
}
function broadcastCanvas(room){
  broadcastAll(room, 'canvasSnapshot', { strokes: room.currentStrokes });
}

function clearRoomTimers(room){
  clearTimeout(room.turnTimer); clearTimeout(room.advanceTimer); clearTimeout(room.emptyCleanupTimer);
}
function scheduleEmptyCleanup(room){
  const anyConnected = activePlayers(room).length > 0;
  if(anyConnected) return;
  clearTimeout(room.emptyCleanupTimer);
  room.emptyCleanupTimer = setTimeout(()=>{
    if(activePlayers(room).length === 0){ clearRoomTimers(room); rooms.delete(room.code); }
  }, 10*60*1000);
}

function beginTurn(room, drawerId){
  clearTimeout(room.turnTimer); clearTimeout(room.advanceTimer);
  const word = pickWords(room.usedWords, 1)[0];
  room.currentWord = word;
  room.usedWords.add(word);
  room.currentOptions = buildOptions(word);
  room.status = 'drawing';
  room.currentDrawerId = drawerId;
  room.turnSeq += 1;
  room.guessedIds = new Set();
  room.turnScores = {};
  room.answers = {};
  room.currentStrokes = [];
  room.turnStartAt = Date.now();
  room.turnEndAt = Date.now() + room.turnSeconds*1000;
  broadcastState(room);
  broadcastCanvas(room);
  room.turnTimer = setTimeout(()=> endTurn(room), room.turnSeconds*1000);
}

function endTurn(room){
  if(room.status !== 'drawing') return;
  clearTimeout(room.turnTimer);
  room.status = 'turnEnd';
  broadcastState(room);
  room.advanceTimer = setTimeout(()=> advanceTurn(room), ADVANCE_DELAY);
}

function advanceTurn(room){
  if(room.status !== 'turnEnd') return;
  stepToNextEligible(room);
}
function stepToNextEligible(room){
  let idx = room.currentTurnIndex + 1;
  let round = room.currentRound;
  let guard = 0;
  const maxSteps = Math.max(1, room.turnOrder.length) * Math.max(1, room.rounds) + 2;
  while(guard++ < maxSteps){
    if(idx >= room.turnOrder.length){ idx = 0; round += 1; }
    if(round > room.rounds){ room.status = 'final'; broadcastState(room); return; }
    const candidateId = room.turnOrder[idx];
    const p = room.players.get(candidateId);
    if(p && p.connected){
      room.currentTurnIndex = idx; room.currentRound = round;
      beginTurn(room, candidateId);
      return;
    }
    idx++;
  }
  room.status = 'final'; broadcastState(room);
}

function checkAllGuessedOrEnd(room){
  if(room.status !== 'drawing') return;
  const guesserIds = activePlayers(room).filter(p=>p.id !== room.currentDrawerId).map(p=>p.id);
  if(guesserIds.length === 0) return;
  const allAnswered = guesserIds.every(id=> room.answers[id]); // guessed right or used their wrong attempt
  if(allAnswered) endTurn(room);
}

function startGameForRoom(room){
  const ids = activePlayers(room).map(p=>p.id);
  if(ids.length < 2) return false;
  room.turnOrder = shuffle(ids);
  room.currentRound = 1; room.currentTurnIndex = 0; room.usedWords = new Set();
  room.players.forEach(p=> p.score = 0);
  beginTurn(room, room.turnOrder[0]);
  return true;
}

/* ============================= message handling ============================= */
function handleMessage(conn, msg){
  if(!msg || typeof msg.type !== 'string') return;
  const type = msg.type;

  if(type === 'createRoom'){
    const code = genRoomCode();
    const id = genId('p');
    const room = newRoom(code, id);
    room.players.set(id, {id, name: String(msg.name||'بازیکن').slice(0,16) || 'بازیکن', colorIdx:0, score:0, connected:true, socket: conn.socket});
    rooms.set(code, room);
    conn.roomCode = code; conn.playerId = id;
    send(room.players.get(id), 'joined', {code, playerId:id, isHost:true});
    broadcastState(room);
    return;
  }
  if(type === 'joinRoom'){
    const code = String(msg.code||'').toUpperCase();
    const room = rooms.get(code);
    const tempPlayer = {socket: conn.socket, connected:true};
    if(!room){ send(tempPlayer,'errorMsg',{message:'اتاقی با این کد پیدا نشد'}); return; }
    if(room.status !== 'lobby'){ send(tempPlayer,'errorMsg',{message:'این بازی شروع شده؛ برای دور بعد صبر کن'}); return; }
    if(activePlayers(room).length >= 8){ send(tempPlayer,'errorMsg',{message:'اتاق پر است (حداکثر ۸ بازیکن)'}); return; }
    const id = genId('p');
    const colorIdx = room.players.size;
    room.players.set(id, {id, name: String(msg.name||'بازیکن').slice(0,16) || 'بازیکن', colorIdx, score:0, connected:true, socket: conn.socket});
    conn.roomCode = code; conn.playerId = id;
    send(room.players.get(id), 'joined', {code, playerId:id, isHost:false});
    broadcastState(room);
    return;
  }

  // everything below requires an existing room/player
  const room = conn.roomCode ? rooms.get(conn.roomCode) : null;
  if(!room) return;
  const player = room.players.get(conn.playerId);
  if(!player) return;

  if(type === 'updateSettings'){
    if(room.hostId !== player.id || room.status !== 'lobby') return;
    if(msg.rounds) room.rounds = clamp(parseInt(msg.rounds,10) || room.rounds, 1, 3);
    if(msg.turnSeconds) room.turnSeconds = clamp(parseInt(msg.turnSeconds,10) || room.turnSeconds, 15, 180);
    broadcastState(room);
  }
  else if(type === 'startGame'){
    if(room.hostId !== player.id || room.status !== 'lobby') return;
    startGameForRoom(room);
  }
  else if(type === 'strokeStart'){
    if(room.status !== 'drawing' || room.currentDrawerId !== player.id) return;
    if(!msg.id || !Array.isArray(msg.point)) return;
    room.currentStrokes.push({id: msg.id, tool: msg.tool==='eraser'?'eraser':'pen', color: String(msg.color||'#22252B').slice(0,16), size: clamp(parseInt(msg.size,10)||6,1,40), points:[msg.point]});
    if(room.currentStrokes.length > 500) room.currentStrokes.shift();
    broadcastExcept(room, 'strokeStart', {id:msg.id, tool:msg.tool, color:msg.color, size:msg.size, point:msg.point}, player.id);
  }
  else if(type === 'strokePoint'){
    if(room.status !== 'drawing' || room.currentDrawerId !== player.id) return;
    const st = room.currentStrokes.find(s=>s.id === msg.id);
    if(st && Array.isArray(msg.point)) st.points.push(msg.point);
    broadcastExcept(room, 'strokePoint', {id: msg.id, point: msg.point}, player.id);
  }
  else if(type === 'strokeEnd'){
    if(room.currentDrawerId !== player.id) return;
    broadcastExcept(room, 'strokeEnd', {id: msg.id}, player.id);
  }
  else if(type === 'undo'){
    if(room.status !== 'drawing' || room.currentDrawerId !== player.id) return;
    room.currentStrokes.pop();
    broadcastCanvas(room);
  }
  else if(type === 'clearCanvas'){
    if(room.status !== 'drawing' || room.currentDrawerId !== player.id) return;
    room.currentStrokes = [];
    broadcastCanvas(room);
  }
  else if(type === 'guess'){
    if(room.status !== 'drawing' || player.id === room.currentDrawerId) return;
    if(room.answers[player.id]) return; // already used their one attempt this turn (right or wrong)
    const word = String(msg.word||'');
    if(!word || room.currentOptions.indexOf(word) === -1) return;
    const correct = normalizeFa(word) === normalizeFa(room.currentWord||'');
    if(correct){
      const rank = room.guessedIds.size; // how many already guessed correctly before this one
      const points = rank === 0 ? 5 : rank === 1 ? 4 : 3;
      room.guessedIds.add(player.id);
      room.answers[player.id] = {word, correct:true};
      room.turnScores[player.id] = points;
      player.score += points;
      const drawer = room.players.get(room.currentDrawerId);
      if(drawer){ drawer.score += 3; room.turnScores[drawer.id] = (room.turnScores[drawer.id]||0) + 3; }
      broadcastAll(room, 'chatMessage', {kind:'correct', name: player.name, points});
      broadcastState(room);
      checkAllGuessedOrEnd(room);
    } else {
      room.answers[player.id] = {word, correct:false};
      broadcastState(room);
      checkAllGuessedOrEnd(room);
    }
  }
  else if(type === 'playAgain'){
    if(room.hostId !== player.id || room.status !== 'final') return;
    startGameForRoom(room);
  }
}

function handleDisconnect(conn){
  if(!conn.roomCode) return;
  const room = rooms.get(conn.roomCode);
  if(!room) return;
  const player = room.players.get(conn.playerId);
  if(!player) return;
  player.connected = false;
  player.socket = null;

  if(room.status === 'lobby'){
    room.players.delete(player.id);
  } else if(room.status === 'drawing'){
    if(room.currentDrawerId === player.id){
      endTurn(room);
    } else {
      checkAllGuessedOrEnd(room);
    }
  }
  if(room.hostId === player.id){
    const next = activePlayers(room)[0];
    if(next) room.hostId = next.id;
  }
  broadcastState(room);
  scheduleEmptyCleanup(room);
}

/* ============================= HTTP + upgrade ============================= */
const server = http.createServer((req, res)=>{
  if(req.url === '/health'){ res.writeHead(200,{'Content-Type':'text/plain'}); res.end('ok'); return; }
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
  res.end(indexHtml);
});

server.on('upgrade', (req, socket)=>{
  if((req.headers['upgrade']||'').toLowerCase() !== 'websocket'){ socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if(!key){ socket.destroy(); return; }
  const accept = acceptKey(key);
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', ''
  ].join('\r\n'));

  const conn = { socket, roomCode:null, playerId:null };
  const feed = makeFrameParser((opcode, payload)=>{
    if(opcode === 0x8){ try{ socket.end(); }catch(e){} return; }
    if(opcode === 0x9){ sendPong(socket, payload); return; }
    if(opcode === 0xA){ return; }
    if(opcode === 0x1){
      let msg;
      try{ msg = JSON.parse(payload.toString('utf8')); }catch(e){ return; }
      try{ handleMessage(conn, msg); }catch(e){ console.error('handleMessage error:', e); }
    }
  });
  socket.on('data', feed);
  socket.on('close', ()=>{ try{ handleDisconnect(conn); }catch(e){} });
  socket.on('error', ()=>{ try{ handleDisconnect(conn); }catch(e){} });
  socket.setTimeout(0);
});

// heartbeat so proxies (Render etc.) don't kill idle connections
setInterval(()=>{
  rooms.forEach(room=>{
    room.players.forEach(p=>{ if(p.connected && p.socket) sendPing(p.socket); });
  });
}, 25000);

server.listen(PORT, ()=>{ console.log('خط‌خطی server listening on port ' + PORT); });
