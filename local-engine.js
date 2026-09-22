/* ============================================================
   local-engine.js — موتور کامل بازی خط‌خطی، اجراشونده داخل مرورگر
   (نسخه‌ی وفق‌داده‌شده از server.js برای «حالت محلی بدون اینترنت»)
   ============================================================
   این فایل عیناً همان منطق بازی (اتاق‌ها، نوبت‌ها، امتیازدهی، حدس کلمه)
   را دارد که در server.js روی سرور آنلاین اجرا می‌شود؛ فقط لایه‌ی
   ارسال پیام (sendText) به‌جای وب‌ساکت خام، از متد send() روی هر
   "socket" انتزاعی استفاده می‌کند — این socket می‌تواند یک
   RTCDataChannel (برای مهمان‌های راه‌دور) یا یک لوپ‌بک محلی
   (برای خودِ میزبان) باشد. بقیه‌ی کد دست‌نخورده است.

   استفاده:
     const engine = createLocalEngine();
     engine.handleMessage(conn, msg);   // conn = {roomCode, playerId, socket}
     engine.handleDisconnect(conn);
     // conn.socket باید متد send(str) داشته باشد.
*/
function createLocalEngine(){
'use strict';
const ADVANCE_DELAY = 7000;
const READY_COUNTDOWN_MS = 10000;
const DISCONNECT_GRACE_MS = 60 * 1000;
const REPLAY_WINDOW_MS = 45000;

function sendText(socket, str){
  try{ socket.send(str); }catch(e){}
}

/* ============================= game utils ============================= */
function genId(p){ return (p||'id') + '_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36); }
function genRoomCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s=''; for(let i=0;i<5;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function toEnDigits(str){
  if(str == null) return '';
  const M = {'۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9',
             '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
  return String(str).replace(/[۰-۹٠-٩]/g, c=> M[c] || c);
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
function sanitizeName(raw){
  return String(raw||'').trim().replace(/\s+/g,' ').slice(0,24);
}
function makeUniqueName(room, preferred){
  const name = sanitizeName(preferred);
  if(!name) return null;
  const existing = new Set(Array.from(room.players.values()).map(p=> p.name));
  if(!existing.has(name)) return name;
  for(let i=2;i<200;i++){
    const candidate = name + ' ' + i;
    if(!existing.has(candidate)) return candidate;
  }
  return name + ' ' + Math.floor(Math.random()*1000);
}

const WORD_CATEGORIES = {
  "حیوانات خانگی": ["سگ","گربه","خرگوش","همستر","طوطی","قناری","لاک‌پشت","جوجه","خوکچه"],
  "حیوانات وحشی": ["شیر","ببر","پلنگ","فیل","زرافه","کرگدن","گوریل","میمون","خرس","گرگ","روباه","آهو","گوزن","کانگورو","پاندا","کوآلا","شترمرغ","شغال","گراز","بوفالو","اورانگوتان","شامپانزه","خفاش","سنجاب","خارپشت","راسو","سمور","لاما","شتر","زبرا","تمساح","سوسمار","مار","راکون","گورخر","یوزپلنگ","گاومیش","بز","مارمولک","سمندر","کروکودیل","وزغ","خرگوش","موش","بوقلمون","لاک‌پشت","جوجه‌تیغی","خرس‌قطبی","گربه‌سانان","اسب‌آبی","گوزن‌شمالی","گراز‌وحشی","سگ‌آبی","گورکن"],
  "پرندگان": ["کبوتر","گنجشک","کلاغ","عقاب","جغد","طاووس","اردک","غاز","مرغ","خروس","بلبل","دارکوب","هدهد","قو","پلیکان","شاهین","لک‌لک","فلامینگو","کبک","پرستو","مرغابی","قناری","سار","زاغی","مینا","طوطی","جوجه","کرکس","مرغ‌عشق","بوقلمون"],
  "حشرات و جانوران کوچک": ["زنبور","مورچه","عنکبوت","سوسک","ملخ","جیرجیرک","کرم","حلزون","سنجاقک","کفشدوزک","پشه","مگس","کک","خرخاکی","پروانه","شب‌پره"],
  "جانوران دریایی": ["ماهی","نهنگ","کوسه","دلفین","اختاپوس","خرچنگ","میگو","صدف","فک","قورباغه","مرجان","ستاره","لاک‌پشت","عروس"],
  "حیوانات مزرعه": ["گاو","گوسفند","بز","اسب","خر","خوک","مرغ","خروس","بوقلمون","اردک","غاز","گاومیش","قاطر","بره","گوساله","بزغاله"],
  "میوه‌ها": ["سیب","موز","پرتقال","انگور","خربزه","توت‌فرنگی","گیلاس","آلبالو","هلو","زردآلو","گلابی","آناناس","انار","انجیر","خرما","کیوی","لیمو","نارنگی","آلو","توت","نارگیل","انبه","پاپایا","گواوا","خرمالو","نارنج","به","کاکی","طالبی","هندوانه","گریپ‌فروت","شاه‌توت","ازگیل","لیچی"],
  "سبزیجات": ["هویج","سیب‌زمینی","گوجه‌فرنگی","خیار","کاهو","کلم","پیاز","سیر","بادمجان","کدو","ذرت","تربچه","چغندر","اسفناج","کرفس","قارچ","شلغم","تره","جعفری","ترب","موسیر","نخود","عدس","لپه","ماش","فلفل","گوجه","کنگر","گشنیز"],
  "غذاها": ["نان","برنج","کباب","پیتزا","ساندویچ","همبرگر","سوپ","سالاد","تخم‌مرغ","پنیر","کره","عسل","مربا","ماکارونی","اسپاگتی","سوسیس","کالباس","کیک","بیسکویت","شکلات","بستنی","آبنبات","آدامس","پفک","چیپس","دلمه","آش","قیمه","میرزاقاسمی","کوفته","سمبوسه","فلافل","شاورما","تاکو","پیراشکی","نودل","کتلت","نیمرو","حلیم","پاستا","لازانیا","نمک","شکر","روغن","سرکه","دارچین","زعفران","زیره","ماست","حریره","آبگوشت","خورشت","ترشی","حلوا","فرنی","کشک","آش‌رشته","قیسی"],
  "نوشیدنی‌ها": ["آب","چای","قهوه","شیر","آبمیوه","دوغ","نوشابه","شربت","شیرکاکائو","اسموتی","اسپرسو","کاکائو"],
  "شیرینی و دسر": ["دونات","وافل","پنکیک","کلوچه","حلوا","باقلوا","ژله","پودینگ","تافی","کیک"],
  "وسایل آشپزخانه": ["قابلمه","ماهیتابه","چاقو","قاشق","چنگال","بشقاب","لیوان","فنجان","کتری","یخچال","مایکروویو","توستر","آبمیوه‌گیری","قندان","نمکدان","دیگ","ظرفشویی","کاسه","آبکش","همزن","سینی","قیف"],
  "وسایل خانه": ["تخت","مبل","میز","صندلی","کمد","لامپ","پنجره","در","فرش","پرده","تلویزیون","گلدان","بالش","پتو","جارو","اتو","بخاری","پنکه","کولر","تلفن","کامپیوتر","لپ‌تاپ","موبایل","رادیو","جالباسی","چراغ‌خواب","کلید","قفل","چتر","کوله‌پشتی","کاناپه","شمعدان","تشک","قالیچه","مسواک","خمیردندان","صابون","شامپو","حوله","برس","شانه","آینه","ساعت","یخچال","رادیاتور","جاروبرقی","گنجه","نردبان","آویز","بشکه","سبد","قفسه","آباژور"],
  "وسایل نقلیه": ["ماشین","اتوبوس","قطار","هواپیما","کشتی","دوچرخه","موتورسیکلت","تاکسی","کامیون","آمبولانس","هلیکوپتر","بالن","اسکیت‌برد","اسکوتر","تراکتور","وانت","قایق","زیردریایی","تراموا","مترو","بالگرد","ون","چرخ‌دستی","جنگنده","کالسکه","چرخ","یدک‌کش"],
  "مشاغل": ["دکتر","معلم","پلیس","آتش‌نشان","خلبان","آشپز","نجار","نقاش","خیاط","کشاورز","پرستار","مهندس","وکیل","دندانپزشک","کارگر","راننده","رقصنده","خواننده","نویسنده","ورزشکار","سرباز","ماهیگیر","نانوا","قصاب","آرایشگر","مکانیک","برقکار","لوله‌کش","باغبان","دامپزشک","فروشنده","صندوق‌دار","قاضی","باستان‌شناس","عکاس","فیلمبردار","کارآگاه","خبرنگار","نگهبان","کتابدار","ملوان","چوپان","صیاد","معدنچی","بنا","مترجم","قهرمان","داور","بازیگر","کارگردان","معمار"],
  "ورزش‌ها و وسایل ورزشی": ["فوتبال","بسکتبال","والیبال","تنیس","شنا","دو","کشتی","بوکس","اسکی","اسکیت","توپ","دروازه","راکت","دمبل","طناب","کوهنوردی","شطرنج","گلف","بدمینتون","پینگ‌پنگ","ژیمناستیک","کبدی","دارت","بولینگ","هاکی","وزنه","تور","اسکواش","کاراته","جودو"],
  "آلات موسیقی": ["گیتار","پیانو","ویولن","طبل","فلوت","سنتور","تار","دف","نی","ترومپت","آکاردئون","ساکسیفون","کمانچه","دهل","سنج","ارگ","بربط","بلندگو","هدفون","میکروفون","قره‌نی"],
  "اعضای بدن": ["چشم","گوش","دهان","دماغ","دست","پا","سر","مو","دندان","زبان","انگشت","ناخن","گردن","شکم","ابرو","مژه","پیشانی","آرنج","زانو","لب","چانه","مچ","گونه","لپ","پاشنه","ناف","ران","ساق"],
  "پوشاک": ["پیراهن","شلوار","کفش","کلاه","جوراب","دستکش","شال","کت","دامن","کراوات","عینک","کمربند","چکمه","دمپایی","پالتو","روسری","شلوارک","بلوز","ژاکت","مانتو","یقه","جلیقه","عبا"],
  "لوازم‌التحریر و مدرسه": ["مداد","خودکار","دفتر","پاک‌کن","خط‌کش","کتاب","گچ","چسب","قیچی","پرگار","ماژیک","تراش","برچسب","ماشین‌حساب","جامدادی","استپلر","پوشه","تقویم","پرینتر"],
  "ابزار و لوازم فنی": ["چکش","پیچ‌گوشتی","اره","میخ","نردبان","متر","دریل","چراغ‌قوه","باتری","سیم","انبردست","پیچ","مته","قیچی","سوهان","اسکنه","طناب","قلاب","قلم","سنباده"],
  "طبیعت و آب‌وهوا": ["خورشید","ماه","ستاره","ابر","باران","برف","رنگین‌کمان","کوه","دریا","جنگل","درخت","گل","برگ","آتش‌فشان","آبشار","صحرا","دریاچه","تپه","غار","مه","طوفان","گردباد","تگرگ","یخ","برف‌آدم","کویر","جزیره","صخره","رودخانه","رعد","دیوار","سقف","پله","دشت","برکه","چشمه","بیابان","چمن","علف","ماسه","سنگ","گدازه","خزه","نمکزار"],
  "مکان‌ها و بناها": ["مدرسه","بیمارستان","پارک","مسجد","کلیسا","قلعه","برج","پل","فروشگاه","استخر","فرودگاه","چادر","کاخ","موزه","سینما","رستوران","کافه","بازار","سوپرمارکت","خانه","آسیاب","فانوس","کف","برکه","چاه","انبار","معبد"],
  "فضا": ["زمین","ماه","خورشید","سیاره","ستاره","موشک","فضاپیما","فضانورد","شهاب‌سنگ","ماهواره","کهکشان","سیاه‌چاله","مریخ","زحل","مشتری","شهاب","زهره","عطارد","اورانوس","نپتون","پلوتو","قمر","دنباله"],
  "شخصیت‌های خیالی": ["اژدها","جن","پری","غول","شاهزاده","جادوگر","ابرقهرمان","روح","سیندرلا","پینوکیو","بابانوئل","دیو","سوپرمن","بتمن","سفیدبرفی","علاءالدین","شوالیه","پرنسس","فرشته","شیطان"],
  "اشکال هندسی": ["دایره","مربع","مثلث","مستطیل","ستاره","قلب","بیضی","لوزی","مکعب","هرم","مخروط","پنج‌ضلعی","شش‌ضلعی","نیم‌دایره","کره","استوانه","هشت‌ضلعی","هفت‌ضلعی"],
  "فصل‌ها و تعطیلات": ["بهار","تابستان","پاییز","زمستان","کریسمس","هالووین","تولد","عروسی","سیزده‌بدر","فشفشه","آتش‌بازی","نوروز"],
  "اسباب‌بازی و سرگرمی": ["عروسک","بادکنک","لگو","پازل","فرفره","تاب","سرسره","کایت","یویو"],
};

const WORDS = [];
const WORD_CATEGORY_OF = new Map();
for(const [cat, list] of Object.entries(WORD_CATEGORIES)){
  for(const w of list){
    if(!WORD_CATEGORY_OF.has(w)){
      WORD_CATEGORY_OF.set(w, cat);
      WORDS.push(w);
    }
  }
}

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
  const needed = 9;
  const cat = WORD_CATEGORY_OF.get(word);
  const sameCategory = WORDS.filter(w=> w !== word && WORD_CATEGORY_OF.get(w) === cat);
  const otherCategory = WORDS.filter(w=> w !== word && WORD_CATEGORY_OF.get(w) !== cat);
  const fromSame = shuffle(sameCategory).slice(0, Math.min(needed, sameCategory.length, 7));
  let distractors = fromSame;
  if(distractors.length < needed){
    distractors = distractors.concat(shuffle(otherCategory).slice(0, needed - distractors.length));
  }
  return shuffle([word].concat(distractors));
}

/* ============================= room state ============================= */
const rooms = new Map();

function newRoom(code, hostId){
  return {
    code, hostId, status:'lobby', rounds:2, turnSeconds:60,
    players: new Map(), turnOrder: [], currentRound:1, currentTurnIndex:-1,
    currentDrawerId:null, turnSeq:0, currentWord:null, currentOptions:[],
    usedWords: new Set(), turnStartAt:0, turnEndAt:0, guessedIds:new Set(), turnScores:{},
    currentStrokes: [], turnTimer:null, advanceTimer:null, emptyCleanupTimer:null,
    answers: {}, nextTurnInfo: null, isPreGame: false, isPublic: false, name: '',
    readyCountdownEndAt: 0, readyCountdownTimer: null,
    replayVotes: new Set(), replayEndAt: 0, replayTimer: null
  };
}

function activePlayers(room){ return Array.from(room.players.values()).filter(p=>p.connected); }
function nextFreeColorIdx(room){
  const used = new Set(activePlayers(room).map(p=>p.colorIdx));
  for(let i=0;i<8;i++) if(!used.has(i)) return i;
  return room.players.size;
}

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
  room.players.forEach((p,id)=>{ out[id] = {id:p.id, name:p.name, colorIdx:p.colorIdx, score:p.score, connected:p.connected, ready: !!p.ready}; });
  return out;
}
function publicMeta(room, forId){
  const isDrawer = room.currentDrawerId === forId;
  const wordLen = room.currentWord ? room.currentWord.replace(/[\u200c\s]/g,'').length : 0;
  const meta = {
    code: room.code, hostId: room.hostId, status: room.status,
    rounds: room.rounds, turnSeconds: room.turnSeconds,
    isPublic: !!room.isPublic,
    roomName: room.name || '',
    readyCountdownEndAt: room.readyCountdownEndAt || 0,
    turnOrder: room.turnOrder, currentRound: room.currentRound, currentTurnIndex: room.currentTurnIndex,
    currentDrawerId: room.currentDrawerId, turnSeq: room.turnSeq,
    currentWord: isDrawer ? room.currentWord : null,
    wordLen: wordLen,
    options: (!isDrawer && room.status==='drawing') ? room.currentOptions : [],
    turnEndAt: room.turnEndAt,
    guessedIds: Array.from(room.guessedIds||[]),
    turnScores: room.turnScores || {},
    myAnswer: (room.answers && room.answers[forId]) ? room.answers[forId] : null,
    wrongIds: Object.keys(room.answers||{}).filter(id => room.answers[id] && !room.answers[id].correct),
    lastWordReveal: room.status==='turnEnd' ? room.currentWord : null,
    isPreGame: room.status === 'turnEnd' && room.isPreGame,
    replayVotes: Array.from(room.replayVotes || []),
    replayEndAt: room.replayEndAt || 0
  };
  if(room.status === 'turnEnd' && room.nextTurnInfo){
    meta.nextDrawerId = room.nextTurnInfo.drawerId;
    meta.nextRound = room.nextTurnInfo.round;
    if(room.nextTurnInfo.drawerId === forId){
      meta.nextWord = room.nextTurnInfo.word;
    }
  }
  return meta;
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
  clearTimeout(room.turnTimer);
  clearTimeout(room.advanceTimer);
  clearTimeout(room.emptyCleanupTimer);
  clearTimeout(room.replayTimer);
}
function scheduleEmptyCleanup(room){
  const anyConnected = activePlayers(room).length > 0;
  if(anyConnected) return;
  clearTimeout(room.emptyCleanupTimer);
  room.emptyCleanupTimer = setTimeout(()=>{
    if(activePlayers(room).length === 0){
      clearRoomTimers(room);
      rooms.delete(room.code);
      broadcastPublicRooms();
    }
  }, 20*1000);
}

function computeNextTurnInfo(room){
  let idx = room.currentTurnIndex + 1;
  let round = room.currentRound;
  let guard = 0;
  const maxSteps = Math.max(1, room.turnOrder.length) * Math.max(1, room.rounds) + 2;
  while(guard++ < maxSteps){
    if(idx >= room.turnOrder.length){ idx = 0; round += 1; }
    if(round > room.rounds) return null;
    const candidateId = room.turnOrder[idx];
    const p = room.players.get(candidateId);
    if(p && p.connected){
      const word = pickWords(room.usedWords, 1)[0];
      room.usedWords.add(word);
      return { drawerId: candidateId, turnIndex: idx, round: round, word: word };
    }
    idx++;
  }
  return null;
}

function beginTurnWithWord(room, drawerId, word){
  clearTimeout(room.turnTimer); clearTimeout(room.advanceTimer);
  room.currentWord = word;
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

function clearReadyCountdown(room){
  if(room.readyCountdownTimer){ clearTimeout(room.readyCountdownTimer); room.readyCountdownTimer = null; }
  room.readyCountdownEndAt = 0;
}
function evaluateReadyState(room){
  if(room.status !== 'lobby') return;
  const players = activePlayers(room);
  const total = players.length;
  if(total < 2){ clearReadyCountdown(room); return; }
  const readyCount = players.filter(p=>p.ready).length;
  if(readyCount === total){
    /* وقتی همه‌ی بازیکن‌ها آماده‌اند، غافل‌گیرکننده نیست و بازی خودکار شروع می‌شود */
    clearReadyCountdown(room);
    startGameForRoom(room);
    return;
  }
  /* دیگر با اکثریت (نه همه) به‌صورت خودکار و بدون اقدام میزبان بازی شروع
     نمی‌شود؛ میزبان همچنان می‌تواند با دکمه‌ی «شروع بازی» با اکثریت آماده
     شروع کند، ولی بازیکن‌هایی که مشغول کاری دیگر (مثل تنظیم اسم) هستند
     ناگهانی وارد بازی نمی‌شوند. */
  clearReadyCountdown(room);
}

function startGameForRoom(room){
  clearReadyCountdown(room);
  clearTimeout(room.replayTimer);
  room.replayVotes = new Set();
  room.replayEndAt = 0;
  room.players.forEach(p=> { p.ready = false; });
  const ids = activePlayers(room).map(p=>p.id);
  if(ids.length < 2) return false;
  room.turnOrder = shuffle(ids);
  room.currentRound = 1;
  room.currentTurnIndex = -1;
  room.usedWords = new Set();
  room.players.forEach(p=> p.score = 0);
  room.currentWord = null;
  room.currentDrawerId = null;
  room.guessedIds = new Set();
  room.turnScores = {};
  room.answers = {};
  room.currentStrokes = [];
  room.nextTurnInfo = null;

  const info = computeNextTurnInfo(room);
  if(!info){ enterFinalState(room); return false; }

  room.nextTurnInfo = info;
  room.isPreGame = true;
  room.status = 'turnEnd';
  broadcastState(room);
  broadcastPublicRooms();
  clearTimeout(room.advanceTimer);
  room.advanceTimer = setTimeout(()=> advanceTurn(room), ADVANCE_DELAY);
  return true;
}

function endTurn(room){
  if(room.status !== 'drawing') return;
  clearTimeout(room.turnTimer);
  const info = computeNextTurnInfo(room);
  room.nextTurnInfo = info;
  room.isPreGame = false;
  room.status = 'turnEnd';
  broadcastState(room);
  clearTimeout(room.advanceTimer);
  room.advanceTimer = setTimeout(()=> advanceTurn(room), ADVANCE_DELAY);
}

function advanceTurn(room){
  if(room.status !== 'turnEnd') return;
  let info = room.nextTurnInfo;
  room.nextTurnInfo = null;
  room.isPreGame = false;
  if(info){
    const p = room.players.get(info.drawerId);
    if(!p || !p.connected){
      if(info.word) room.usedWords.delete(info.word);
      info = computeNextTurnInfo(room);
    }
  }
  if(!info){ enterFinalState(room); return; }
  room.currentTurnIndex = info.turnIndex;
  room.currentRound = info.round;
  beginTurnWithWord(room, info.drawerId, info.word);
}

function checkAllGuessedOrEnd(room){
  if(room.status !== 'drawing') return;
  const guesserIds = activePlayers(room).filter(p=>p.id !== room.currentDrawerId).map(p=>p.id);
  if(guesserIds.length === 0){ endTurn(room); return; }
  const allAnswered = guesserIds.every(id=> room.answers[id]);
  if(allAnswered) endTurn(room);
}

/* ---- پایان بازی وقتی فقط یک نفر مونده ---- */
function endGameWithSoloPlayer(room){
  enterFinalState(room);
}

/* ---- ورود به حالت پایان + پنجره‌ی ۴۵ ثانیه‌ای بازی دوباره ---- */
function enterFinalState(room){
  clearTimeout(room.turnTimer);
  clearTimeout(room.advanceTimer);
  clearTimeout(room.replayTimer);
  clearReadyCountdown(room);
  room.status = 'final';
  room.currentWord = null;
  room.currentOptions = [];
  room.nextTurnInfo = null;
  room.isPreGame = false;
  room.replayVotes = new Set();
  room.replayEndAt = Date.now() + REPLAY_WINDOW_MS;
  broadcastState(room);
  broadcastPublicRooms();
  room.replayTimer = setTimeout(()=> resolveReplayWindow(room), REPLAY_WINDOW_MS);
}

function resolveReplayWindow(room){
  if(room.status !== 'final') return;
  clearTimeout(room.replayTimer);

  /* حذف هر کسی که یا رأی نداده یا وصل نیست */
  const toRemove = [];
  room.players.forEach(p=>{
    if(!p.connected || !room.replayVotes.has(p.id)) toRemove.push(p);
  });
  toRemove.forEach(p=>{
    if(p.disconnectTimer){ clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
    if(p.connected){
      send(p, 'kickedToHome', {message: 'زمان «بازی دوباره» تموم شد — به صفحه اصلی برگشتی'});
    }
    room.players.delete(p.id);
  });

  room.replayVotes = new Set();
  room.replayEndAt = 0;

  if(room.players.size === 0){
    clearRoomTimers(room);
    rooms.delete(room.code);
    broadcastPublicRooms();
    return;
  }

  if(room.players.size < 2){
    /* فقط یک نفر آماده بود → بازی دوباره شروع نمی‌شود */
    broadcastAll(room, 'roomClosed', {reason: 'notEnoughPlayers'});
    clearRoomTimers(room);
    rooms.delete(room.code);
    broadcastPublicRooms();
    return;
  }

  if(!room.players.has(room.hostId)){
    const next = activePlayers(room)[0];
    room.hostId = next ? next.id : null;
  }

  startGameForRoom(room);
}

function checkSoloVictory(room){
  if(room.status === 'lobby' || room.status === 'final') return false;
  if(room.players.size === 1 && activePlayers(room).length === 1){
    endGameWithSoloPlayer(room);
    return true;
  }
  return false;
}

/* جدا کردن یک بازیکن از اتاق (leaveRoom یا اتمام مهلت disconnect) */
function handlePlayerLeave(room, playerId){
  const player = room.players.get(playerId);
  if(!player) return;

  if(player.disconnectTimer){
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }

  const wasHost = room.hostId === playerId;
  room.players.delete(playerId);

  if(wasHost){
    const next = activePlayers(room)[0];
    room.hostId = next ? next.id : null;
  }

  if(room.players.size === 0){
    clearRoomTimers(room);
    rooms.delete(room.code);
    broadcastPublicRooms();
    return;
  }

  if(checkSoloVictory(room)){
    broadcastPublicRooms();
    scheduleEmptyCleanup(room);
    return;
  }

  /* ---- اگر وسط پنجره‌ی «بازی دوباره» هستیم ---- */
  if(room.status === 'final'){
    const active = activePlayers(room);
    if(active.length < 2 || active.every(p=> room.replayVotes.has(p.id))){
      clearTimeout(room.replayTimer);
      resolveReplayWindow(room);
      broadcastPublicRooms();
      scheduleEmptyCleanup(room);
      return;
    }
  }

  if(room.status === 'drawing' && room.currentDrawerId === playerId){
    endTurn(room);
  } else if(room.status === 'turnEnd' && room.nextTurnInfo && room.nextTurnInfo.drawerId === playerId){
    if(room.nextTurnInfo.word) room.usedWords.delete(room.nextTurnInfo.word);
    room.nextTurnInfo = computeNextTurnInfo(room);
    broadcastState(room);
  } else {
    evaluateReadyState(room);
    checkAllGuessedOrEnd(room);
    broadcastState(room);
  }
  broadcastPublicRooms();
  scheduleEmptyCleanup(room);
}

/* ============================= لیست عمومی زنده ============================= */
function broadcastPublicRooms(){
  /* در حالت محلی (بدون اینترنت) مفهوم «لیست عمومی اتاق‌ها» وجود ندارد؛
     این تابع عمداً کاری انجام نمی‌دهد تا بقیه‌ی موتور بدون تغییر کار کند. */
}

/* ============================= message handling ============================= */
function handleMessage(conn, msg){
  if(!msg || typeof msg.type !== 'string') return;
  const type = msg.type;

  if(type === 'rejoin'){
    const code = toEnDigits(String(msg.code||'')).toUpperCase();
    const room = rooms.get(code);
    const tempPlayer = {socket: conn.socket, connected:true};
    if(!room){ send(tempPlayer,'errorMsg',{message:'این اتاق دیگر وجود ندارد', fatal:true}); return; }
    const player = room.players.get(String(msg.playerId||''));
    if(!player){ send(tempPlayer,'errorMsg',{message:'اطلاعات بازیکن پیدا نشد', fatal:true}); return; }
    /* اگر همین بازیکن از یک اتصال زنده‌ی دیگری (مثلاً یک تب دیگر) وصل بود،
       قبل از جایگزینی، به آن اتصالِ قدیمی خبر بده و آن را ببند تا آن تب
       بی‌سروصدا و بدون توضیح از کار نیفتد */
    if(player.connected && player.socket && player.socket !== conn.socket){
      send(player, 'errorMsg', {message:'این حساب از یک صفحه‌ی دیگر به این اتاق وصل شد', fatal:true});
      try{ player.socket.end(); }catch(e){}
    }
    player.socket = conn.socket;
    player.connected = true;
    /* تایمر قطعی رو کنسل کن چون کاربر برگشت */
    if(player.disconnectTimer){ clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }
    conn.roomCode = code; conn.playerId = player.id;
    clearTimeout(room.emptyCleanupTimer);
    if(room.hostId && !room.players.get(room.hostId)){ room.hostId = player.id; }
    send(player, 'joined', {code, playerId: player.id, isHost: room.hostId === player.id});
    send(player, 'canvasSnapshot', {strokes: room.currentStrokes});
    broadcastState(room);
    return;
  }
  if(type === 'createRoom'){
    let code = genRoomCode();
    while(rooms.has(code)) code = genRoomCode();
    const id = genId('p');
    const room = newRoom(code, id);
    room.name = String(msg.roomName||'').trim().slice(0,24) || 'اتاق بازی';
    const preferred = makeUniqueName(room, msg.preferredName);
    const initialName = preferred || 'بازیکن1';
    room.players.set(id, {id, name: initialName, colorIdx:0, score:0, connected:true, ready:false, socket: conn.socket, disconnectTimer:null});
    rooms.set(code, room);
    conn.roomCode = code; conn.playerId = id;
    send(room.players.get(id), 'joined', {code, playerId:id, isHost:true});
    broadcastState(room);
    broadcastPublicRooms();
    return;
  }
  if(type === 'listPublicRooms'){
    const tempPlayer = {socket: conn.socket, connected:true};
    const list = [];
    rooms.forEach(room=>{
      if(!room.isPublic || room.status !== 'lobby') return;
      const count = activePlayers(room).length;
      if(count === 0 || count >= 8) return;
      list.push({ code: room.code, roomName: room.name || 'اتاق بازی', playerCount: count });
    });
    list.sort((a,b)=> b.playerCount - a.playerCount);
    send(tempPlayer, 'publicRoomsList', {rooms: list});
    return;
  }
  if(type === 'joinRoom'){
    const code = toEnDigits(String(msg.code||'')).toUpperCase();
    const room = rooms.get(code);
    const tempPlayer = {socket: conn.socket, connected:true};
    if(!room){ send(tempPlayer,'errorMsg',{message:'اتاقی با این کد پیدا نشد'}); return; }

    if(msg.viaPublicList && !room.isPublic){
      send(tempPlayer,'errorMsg',{message:'این اتاق دیگه عمومی نیست — برای ورود باید کد داشته باشی'});
      return;
    }

    if(room.status !== 'lobby'){ send(tempPlayer,'errorMsg',{message:'این بازی شروع شده؛ برای دور بعد صبر کن'}); return; }
    if(activePlayers(room).length >= 8){ send(tempPlayer,'errorMsg',{message:'اتاق پر است (حداکثر ۸ بازیکن)'}); return; }
    const id = genId('p');
    const colorIdx = nextFreeColorIdx(room);
    const preferred = makeUniqueName(room, msg.preferredName);
    const defaultName = 'بازیکن' + (activePlayers(room).length + 1);
    const initialName = preferred || defaultName;
    room.players.set(id, {id, name: initialName, colorIdx, score:0, connected:true, ready:false, socket: conn.socket, disconnectTimer:null});
    conn.roomCode = code; conn.playerId = id;
    send(room.players.get(id), 'joined', {code, playerId:id, isHost:false});
    evaluateReadyState(room);
    broadcastState(room);
    broadcastPublicRooms();
    return;
  }

  const room = conn.roomCode ? rooms.get(conn.roomCode) : null;
  if(!room) return;
  const player = room.players.get(conn.playerId);
  if(!player) return;

  if(type === 'updateName'){
    const newName = sanitizeName(msg.name);
    if(!newName) return;
    player.name = newName;
    broadcastState(room);
    return;
  }

  if(type === 'setReady'){
    if(room.status !== 'lobby') return;
    player.ready = !!msg.ready;
    evaluateReadyState(room);
    broadcastState(room);
    return;
  }

  if(type === 'updateSettings'){
    if(room.hostId !== player.id || room.status !== 'lobby') return;
    if(msg.rounds) room.rounds = clamp(parseInt(msg.rounds,10) || room.rounds, 1, 3);
    if(msg.turnSeconds) room.turnSeconds = clamp(parseInt(msg.turnSeconds,10) || room.turnSeconds, 15, 180);
    if(typeof msg.isPublic === 'boolean') room.isPublic = msg.isPublic;
    broadcastState(room);
    broadcastPublicRooms();
  }
  else if(type === 'startGame'){
    if(room.hostId !== player.id || room.status !== 'lobby') return;
    const players = activePlayers(room);
    const total = players.length;
    if(total < 2) return;
    const readyCount = players.filter(p=>p.ready).length;
    if(readyCount <= total/2){
      send(player, 'errorMsg', {message:'برای شروع بازی باید حداقل اکثریت بازیکن‌ها اعلام آمادگی کرده باشند'});
      return;
    }
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
    if(room.answers[player.id]) return;
    const word = String(msg.word||'');
    if(!word || room.currentOptions.indexOf(word) === -1) return;
    const correct = normalizeFa(word) === normalizeFa(room.currentWord||'');
    if(correct){
      const rank = room.guessedIds.size;
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
    if(room.status !== 'final') return;
    if(room.replayVotes.has(player.id)) return;
    room.replayVotes.add(player.id);
    const active = activePlayers(room);
    if(active.length >= 2 && active.every(p=> room.replayVotes.has(p.id))){
      clearTimeout(room.replayTimer);
      resolveReplayWindow(room);
      return;
    }
    broadcastState(room);
  }
  else if(type === 'leaveRoom'){
    conn.roomCode = null; conn.playerId = null;
    handlePlayerLeave(room, player.id);
  }
  else if(type === 'closeRoom'){
    if(room.hostId !== player.id) return;
    broadcastAll(room, 'roomClosed', {});
    clearRoomTimers(room);
    rooms.delete(room.code);
    broadcastPublicRooms();
  }
}

function handleDisconnect(conn){
  if(!conn.roomCode) return;
  const room = rooms.get(conn.roomCode);
  if(!room) return;
  const player = room.players.get(conn.playerId);
  if(!player || !player.connected) return;
  /* اگر این اتصال قبلاً با یک rejoin جدیدتر (مثلاً از تب دیگر) جایگزین شده،
     دیگر اتصال فعلیِ این بازیکن نیست؛ نباید نشست جدید را قطع کند */
  if(player.socket !== conn.socket) return;
  player.connected = false;
  player.socket = null;

  if(room.status === 'lobby'){
    /* در لابی: حذف فوری */
    room.players.delete(player.id);
    if(room.hostId === player.id){
      const next = activePlayers(room)[0];
      if(next) room.hostId = next.id;
    }
    evaluateReadyState(room);
    broadcastState(room);
    broadcastPublicRooms();
    scheduleEmptyCleanup(room);
    return;
  }

  if(room.status === 'final'){
    /* بازی تمام شده و نوبتی در جریان نیست؛ جابه‌جایی فوری میزبان اینجا
       امن است و باعث نمی‌شود بقیه برای «بازی دوباره» بی‌دلیل معطل بمانند */
    if(room.hostId === player.id){
      const next = activePlayers(room)[0];
      if(next) room.hostId = next.id;
    }
    /* اگر همه‌ی بازیکنانِ فعال رأی داده‌اند (به‌جز این یکی که قطع شد)،
       پنجره را همین حالا ببند */
    const activeAfter = activePlayers(room);
    if(activeAfter.length < 2 || activeAfter.every(p=> room.replayVotes.has(p.id))){
      clearTimeout(room.replayTimer);
      resolveReplayWindow(room);
      broadcastPublicRooms();
      return;
    }
  }

  /* در حین بازی: ۶۰ ثانیه فرصت برگشت داده می‌شود و در این مدت هیچ اتفاقی
     نمی‌افتد — نه نوبت جلو می‌رود، نه میزبان یا نوبتِ بعدی عوض می‌شود.
     بازی طبق روال عادی و با تایمرهای معمول خودش ادامه پیدا می‌کند. اگر
     بازیکن بعد از ۱ دقیقه برنگردد، به‌منزله‌ی انصراف او در handlePlayerLeave
     رسیدگی می‌شود (که آنجا نوبت/میزبان/برد تک‌نفره به‌درستی محاسبه می‌شود). */
  if(player.disconnectTimer) clearTimeout(player.disconnectTimer);
  player.disconnectTimer = setTimeout(()=>{
    const p = room.players.get(player.id);
    if(p && !p.connected){
      handlePlayerLeave(room, player.id);
    }
  }, DISCONNECT_GRACE_MS);

  broadcastState(room);
  broadcastPublicRooms();
  scheduleEmptyCleanup(room);
}

return { handleMessage, handleDisconnect, rooms };
}
if(typeof window !== 'undefined') window.createLocalEngine = createLocalEngine;
