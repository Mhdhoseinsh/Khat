/* خط‌خطی — server.js */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADVANCE_DELAY = process.env.FAST_TEST === '1' ? 300 : 7000; // ۷ ثانیه دیالوگ

/* ============================= static file ============================= */
const indexPath = path.join(__dirname, 'index.html');
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
        len = buf.readUInt32BE(6);
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

const WORD_CATEGORIES = {
  "حیوانات خانگی و اهلی": ["اسب","گربه","سگ","گاو","گاومیش","گوسفند","بز","بزغاله","بره","خر","قاطر","شتر","خرگوش","مرغ","خروس","جوجه","اردک","مرغابی","غاز","بوقلمو","کبوتر","همستر","خوکچه‌هندی","طوطی","قناری","بلدرچین","گوساله","کره‌اسب","خوک","گربه‌ولگرد","سگ‌ولگرد","ماهی‌قرمز"],
  "حیوانات وحشی": ["فیل","شیر","ببر","پلنگ","یوزپلنگ","خرس","خرس‌قطبی","گرگ","روباه","میمون","گوریل","شامپانزه","زرافه","اسب‌آبی","کرگدن","گوزن","آهو","بوفالو","کانگورو","کوآلا","پاندا","راسو","سنجاب","خارپشت","موش‌صحرایی","تمساح","مار","مارکبری","افعی","پیتون","لاک‌پشت","سمندر","قورباغه","وزغ","عقاب","باز","شاهین","جغد","کرکس","شترمرغ","پنگوئن","فلامینگو","طاووس","گراز","بز‌کوهی","گورخر","شغال","کفتار","مورچه‌خوار","تنبل","نهنگ","والرس","سمور","راکون","اورانگوتان","بابون","لمور","وال‌عنبر"],
  "پرندگان": ["گنجشک","کلاغ","زاغی","بلبل","هدهد","لک‌لک","پرستو","مرغ‌مگس‌خوار","توکا","دارکوب","کبک","تیهو","قرقاول","مرغ‌عشق","کاکادو","جغد‌کوچک","سینه‌سرخ","قناری‌زرد","درنا","اردک‌وحشی","مرغ‌دریایی","کاسوواری","کیوی‌پرنده","توکان","اردک‌ماهیخوار","سبزقبا"],
  "حشرات و جانوران کوچک": ["زنبور","زنبورعسل","پروانه","مورچه","عنکبوت","سوسک","پشه","مگس","کرم","کرم‌ابریشم","ملخ","سنجاقک","کفشدوزک","بید‌کتابی","شب‌پره","زنجره","هزارپا","رطیل","عقرب","حلزون","کرم‌خاکی","شب‌تاب","زنبور‌سرخ","مگس‌سرکه","سرخرطومی","شپش","کک","مورچه‌سرباز","کرم‌شب‌تاب","لارو"],
  "جانوران دریایی": ["ماهی","کوسه","دلفین","اختاپوس","ماهی‌مرکب","ستاره‌دریایی","خرچنگ","میگو","لابستر","صدف","عروس‌دریایی","مرجان","فک","شیر‌دریایی","والرس","سمور‌آبی","لاک‌پشت‌دریایی","ماهی‌شمشیری","نهنگ‌قاتل","کوسه‌سفید","ماهی‌گازار","قورباغه‌دریایی","ماهی‌بادکنکی","اسب‌آبی‌دریایی","ماهی‌پرنده","نارگیل‌ماهی","خارپشت‌دریایی","نوعی‌کوسه‌چکشی","ماهی‌مرکب‌غول‌پیکر"],
  "میوه‌ها": ["سیب","موز","پرتقال","انگور","هندوانه","طالبی","خربزه","گلابی","هلو","شلیل","آلو","زردآلو","گیلاس","آلبالو","توت‌فرنگی","تمشک","بلوبری","انار","انبه","آناناس","کیوی","نارنگی","لیمو","گریپ‌فروت","خرما","انجیر","زغال‌اخته","شاه‌توت","به","ازگیل","نارگیل","پاپایا","گواوا","لیچی","خرمالو","ازگیل‌ژاپنی","کیوی‌طلایی","خربزه‌تابستانی","نارنج","لیموترش","لیموشیرین"],
  "سبزیجات": ["گوجه‌فرنگی","خیار","هویج","سیب‌زمینی","پیاز","سیر","فلفل","فلفل‌دلمه‌ای","بادمجان","کدو","کدوحلوایی","کلم","کلم‌بروکلی","کاهو","اسفناج","تربچه","چغندر","شلغم","ذرت","لوبیا‌سبز","نخود‌فرنگی","قارچ","کرفس","جعفری","شاهی","ترخون","ریحان","نعناع","زنجبیل","ترب","کدو‌سبز","بامیه","کنگر","گشنیز","تره"],
  "غذاها و خوراکی‌ها": ["پیتزا","همبرگر","ساندویچ","هات‌داگ","کباب","جوجه‌کباب","چلوکباب","قورمه‌سبزی","قیمه","فسنجان","زرشک‌پلو","باقالی‌پلو","دلمه","کوکو‌سبزی","آش‌رشته","آش‌دوغ","سوپ","حلیم","کله‌پاچه","دیزی","کشک‌بادمجان","میرزاقاسمی","ته‌چین","تخم‌مرغ","نیمرو","املت","نان","نان‌بربری","نان‌سنگک","نان‌لواش","پنیر","ماست","کره","عسل","مربا","سالاد‌شیرازی","ماکارونی","لازانیا","سوشی","رشته‌فرنگی","فلافل","شاورما","بستنی","کیک","شیرینی","کلوچه","دونات","وافل","پن‌کیک","پاپ‌کورن","چیپس","کوفته","کتلت","سمبوسه","لوبیاپلو","عدس‌پلو","استانبولی‌پلو"],
  "نوشیدنی‌ها و شیرینی‌جات": ["چای","قهوه","دوغ","شربت","آب‌میوه","آب‌پرتقال","آب‌هویج","نوشابه","شیر","شیرکاکائو","اسموتی","لیموناد","شربت‌آلبالو","قهوه‌ترک","اسپرسو","کاپوچینو","هات‌چاکلت","آب‌معدنی","چای‌سبز","شربت‌سکنجبین","شکلات","تافی","آبنبات","نبات","حلوا","گز","سوهان","باقلوا","نان‌خرمایی","زولبیا"],
  "وسایل خانه و آشپزخانه": ["میز","صندلی","مبل","تخت‌خواب","کمد","قفسه","آینه","پرده","فرش","چراغ","لوستر","ساعت‌دیواری","تلویزیون","یخچال","اجاق‌گاز","ماکروویو","ظرفشویی","ماشین‌لباسشویی","جارو‌برقی","اتو","قوری","کتری","فنجان","بشقاب","قاشق","چنگال","چاقو","کاسه","دیگ","تابه","سبد","آینه‌قدی","بالش","پتو","ملحفه","حوله","صابون","شامپو","مسواک","خمیردندان","سطل‌زباله","جاکفشی","رخت‌آویز","تشک","بخاری","کولر","پنکه"],
  "مبلمان و دکوراسیون": ["مبل","میزناهارخوری","صندلی‌راحتی","کتابخانه","گلدان","تابلو‌نقاشی","شمعدان","ساعت‌شنی","قاب‌عکس","تخت‌دونفره","میزتحریر","کمد‌لباس","رخت‌آویز","پاراوان","فرش‌ایرانی","تشک‌خواب","میزعسلی","کاناپه","نیمکت","صندلی‌گهواره‌ای"],
  "وسایل نقلیه": ["ماشین","موتورسیکلت","دوچرخه","اتوبوس","تاکسی","کامیون","قطار","مترو","تراموا","هواپیما","بالگرد","کشتی","قایق","زیردریایی","اسکوتر","سه‌چرخه","ماشین‌مسابقه","ماشین‌آتش‌نشانی","آمبولانس","ماشین‌پلیس","تراکتور","بولدوزر","جرثقیل","موشک","سفینه‌فضایی","بالن","هواپیمای‌کاغذی","اسکیت‌برد","اسکیت","وانت","کامیونت","یدک‌کش","ون","لیموزین","کالسکه","گاری","سورتمه","تله‌کابین","کشتی‌بادبانی","قایق‌موتوری"],
  "مشاغل": ["دکتر","پرستار","معلم","مهندس","نجار","آشپز","نانوا","قصاب","کشاورز","خلبان","راننده","پلیس","آتش‌نشان","وکیل","قاضی","خبرنگار","نویسنده","نقاش","موسیقی‌دان","خواننده","بازیگر","ورزشکار","فوتبالیست","شنا‌گر","دوچرخه‌سوار","آرایشگر","خیاط","بنا","برقکار","لوله‌کش","مکانیک","دندان‌پزشک","داروساز","کتابدار","صندوق‌دار","فروشنده","ماهیگیر","چوپان","باغبان","عکاس","دامپزشک","خلبان‌جنگی","فضانورد","معمار","کارآگاه","سرآشپز","دلقک","رقصنده","نگهبان","کاراگاه"],
  "ورزش‌ها و وسایل ورزشی": ["فوتبال","بسکتبال","والیبال","تنیس","پینگ‌پنگ","بدمینتون","شنا","دوومیدانی","دوچرخه‌سواری","اسکی","اسنوبرد","بوکس","کشتی","کاراته","تکواندو","ژیمناستیک","گلف","بولینگ","بیسبال","هاکی","راگبی","کریکت","وزنه‌برداری","تیراندازی‌باکمان","شمشیربازی","اسب‌سواری","قایق‌رانی","کوهنوردی","صخره‌نوردی","یوگا","توپ‌فوتبال","راکت‌تنیس","دروازه","تور‌والیبال","کلاه‌ایمنی","تشک‌ژیمناستیک","دستکش‌بوکس","اسکیت‌بازی","سرسره‌اسکی"],
  "آلات موسیقی": ["گیتار","پیانو","ویولن","ویولن‌سل","طبل","دف","تنبک","سنتور","تار","سه‌تار","نی","فلوت","ترومپت","ساکسیفون","آکاردئون","ارگ","هارمونیکا","درام","گیتار‌بیس","کمانچه","دایره‌زنگی","چنگ"],
  "اعضای بدن": ["سر","چشم","بینی","دهان","گوش","مو","دست","پا","انگشت","ناخن","زانو","آرنج","شانه","گردن","کمر","شکم","قلب","مغز","ریه","دندان","لب","ابرو","مژه","پیشانی","چانه","مچ‌دست","کتف","پاشنه‌پا"],
  "پوشاک و لوازم شخصی": ["پیراهن","شلوار","دامن","کت","کاپشن","ژاکت","تی‌شرت","شلوارک","جوراب","کفش","چکمه","صندل","کلاه","عینک","عینک‌آفتابی","دستکش","شال‌گردن","کراوات","کمربند","ساعت‌مچی","انگشتر","گردنبند","دستبند","گوشواره","کیف","کیف‌پول","چتر","ماسک","روسری","چادر","پاپیون","کفش‌ورزشی","لباس‌عروسی","کت‌وشلوار","لباس‌غواصی","لباس‌شنا"],
  "لوازم‌التحریر و مدرسه": ["مداد","خودکار","پاک‌کن","مدادتراش","خط‌کش","دفتر","کتاب","کیف‌مدرسه","ماژیک","مداد‌رنگی","قیچی","چسب","منگنه","پرگار","تخته‌سیاه","گچ","ماشین‌حساب","نقاله","دفترچه‌یادداشت","کش‌پاک‌کن","جامدادی","برچسب‌رنگی"],
  "ابزار و الکترونیک": ["چکش","پیچ‌گوشتی","انبردست","اره","میخ","پیچ","مته","نردبان","تلفن‌همراه","لپ‌تاپ","کامپیوتر","تبلت","هدفون","بلندگو","دوربین‌عکاسی","دوربین‌فیلمبرداری","ریموت‌کنترل","شارژر","باتری","پرینتر","مودم","میکروفون","ساعت‌هوشمند","پاوربانک","فلش‌مموری","کنسول‌بازی","هدست","ماوس","کیبورد","مانیتور","متر‌نواری","سطل‌رنگ‌آمیزی","قلمو"],
  "طبیعت و پدیده‌های جوی": ["خورشید","ماه","ستاره","ابر","باران","برف","رعدوبرق","رنگین‌کمان","مه","باد","طوفان","گردباد","کوه","آتشفشان","دریا","رودخانه","دریاچه","آبشار","جنگل","بیابان","صحرا","ساحل","غار","جزیره","تپه","دشت","یخچال‌طبیعی","شبنم","شفق‌قطبی","برکه","چشمه","مرداب"],
  "مکان‌ها و بناها": ["خانه","آپارتمان","برج","قلعه","کاخ","مسجد","کلیسا","معبد","پل","فانوس‌دریایی","ایستگاه‌قطار","فرودگاه","بیمارستان","مدرسه","دانشگاه","کتابخانه","پارک","باغ‌وحش","استادیوم","سینما","رستوران","کافه","فروشگاه","بازار","مزرعه","آسیاب‌بادی","چادر‌مسافرتی","آلونک","برج‌ساعت","انبار"],
  "فضا و کهکشان": ["زمین","سیاره","کهکشان","دنباله‌دار","شهاب‌سنگ","سیاه‌چاله","ماهواره","فضانورد","تلسکوپ","مریخ","زحل","مشتری","راه‌شیری","بشقاب‌پرنده","ایستگاه‌فضایی","کاوشگر‌فضایی"],
  "شخصیت‌ها و موجودات خیالی": ["اژدها","ربات","فضانورد","پری","جادوگر","شوالیه","شاهزاده","شاهزاده‌خانم","غول","جن","هیولا","زامبی","خون‌آشام","گرگینه","ابرقهرمان","نینجا","سامورایی","دزد‌دریایی","یتی","بابانوئل","فرشته","اسکلت","عروسک‌خیمه‌شب‌بازی","دیو","پری‌دریایی","تک‌شاخ"],
  "اسباب‌بازی و سرگرمی": ["توپ","عروسک","ماشین‌اسباب‌بازی","لگو","پازل","بادکنک","ورق‌بازی","شطرنج","تخته‌نرد","دوچرخه‌اسباب‌بازی","تفنگ‌آب‌پاش","بادبادک","یویو","تاب","سرسره","ترامپولین","دارت","بولینگ‌خانگی","گیم‌کنسول","جوی‌استیک","دوچرخه‌سه‌چرخ","عروسک‌خرسی","جعبه‌هدیه","تاج‌تولد","کیک‌تولد","شمع‌تولد","کاله‌ایدوسکوپ","فرفره","تفنگ‌بادی"],
  "احساسات و حالت‌ها": ["خنده","گریه","تعجب","خشم","ترس","خواب‌آلودگی","بوسه","دلتنگی","خستگی","شادی","غم","خجالت","استرس","آرامش","عصبانیت"],
  "دایناسورها و جانوران باستانی": ["تیرانوسوروس","ترایسراتوپس","استگوساروس","ولوسیرپتور","برونتوسوروس","پتروزاور","آنکیلوسوروس","دیپلودوکوس","اسپینوساروس","دایناسور","تخم‌دایناسور","ماموت","ببر‌دندان‌شمشیری","پلزیوسور"],
  "اشکال هندسی و نمادها": ["دایره","مربع","مثلث","مستطیل","ستاره","قلب","لوزی","بیضی","پنج‌ضلعی","شش‌ضلعی","پیکان","علامت‌سوال","علامت‌تعجب","ضربدر","مکعب","هرم‌هندسی","استوانه","مخروط","کره‌هندسی"],
  "بناهای معروف و نمادهای جهانی": ["برج‌ایفل","تاج‌محل","دیوار‌چین","مجسمه‌آزادی","برج‌پیزا","کولوسئوم","هرم‌مصر","ابوالهول","برج‌خلیفه","پرچم","کره‌زمین","نقشه‌جهان","قطب‌نما","کشتی‌تایتانیک","برج‌آزادی"],
  "فصل‌ها و تعطیلات": ["درخت‌کریسمس","بابانوئل","تخم‌مرغ‌رنگی","هفت‌سین","فانوس","آتش‌بازی","کاج","برف‌آدم","ساحل‌تابستانی","برگ‌پاییزی","چتر‌بارانی","کلاه‌بابانوئل","جشن‌تولد","کیک‌عروسی","فشفشه"],
  "لوازم آرایشی و بهداشتی": ["رژلب","لاک‌ناخن","عطر","برس‌مو","سشوار","آینه‌جیبی","کرم","پنبه","حوله‌حمام","وان‌حمام","دوش","شانه","ناخن‌گیر","اسپری‌مو"],
  "وسایل اداری و تجاری": ["پرینتر","فکس","تلفن‌رومیزی","کیف‌اداری","پوشه‌فایل","استپلر","گیره‌کاغذ","تقویم‌رومیزی","وایت‌برد","پروژکتور","میزکار","صندلی‌اداری","برچسب‌قیمت","صندوق‌پول"],
  "حمل‌ونقل آینده‌نگر": ["ماشین‌پرنده","ربات‌غول‌پیکر","جت‌پک","پرتاب‌کننده‌موشک","ماهواره‌مخابراتی","کاوشگر‌مریخ","پهپاد","ماشین‌خودران","جلیقه‌جت‌پکی"],
};

/* Flatten all categories into one word list, and remember which category
   each word belongs to (first category wins on duplicates). */
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
  /* Make the multiple-choice options harder by preferring distractors from
     the SAME category as the answer (e.g. other wild animals, other fruits)
     instead of totally unrelated random words. Falls back to other
     categories only if a category doesn't have enough words on its own. */
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
    usedWords: new Set(), turnStartAt:0, turnEndAt:0, guessedIds: new Set(), turnScores:{},
    currentStrokes: [], turnTimer:null, advanceTimer:null, emptyCleanupTimer:null,
    answers: {}, nextTurnInfo: null, isPreGame: false
  };
}

function activePlayers(room){ return Array.from(room.players.values()).filter(p=>p.connected); }
function nextFreeColorIdx(room){
  const used = new Set(Array.from(room.players.values()).map(p=>p.colorIdx));
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
  room.players.forEach((p,id)=>{ out[id] = {id:p.id, name:p.name, colorIdx:p.colorIdx, score:p.score, connected:p.connected}; });
  return out;
}
function publicMeta(room, forId){
  const isDrawer = room.currentDrawerId === forId;
  const wordLen = room.currentWord ? room.currentWord.replace(/[\u200c\s]/g,'').length : 0;
  const meta = {
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
    wrongIds: Object.keys(room.answers||{}).filter(id => room.answers[id] && !room.answers[id].correct),
    lastWordReveal: room.status==='turnEnd' ? room.currentWord : null,
    isPreGame: room.status === 'turnEnd' && room.isPreGame
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

/* ---- turn computation ---- */
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

function startGameForRoom(room){
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
  if(!info){ room.status = 'final'; broadcastState(room); return false; }

  room.nextTurnInfo = info;
  room.isPreGame = true;
  room.status = 'turnEnd';
  broadcastState(room);
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
  if(!info){ room.status = 'final'; broadcastState(room); return; }
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

/* ============================= message handling ============================= */
function handleMessage(conn, msg){
  if(!msg || typeof msg.type !== 'string') return;
  const type = msg.type;

  if(type === 'rejoin'){
    const code = String(msg.code||'').toUpperCase();
    const room = rooms.get(code);
    const tempPlayer = {socket: conn.socket, connected:true};
    if(!room){ send(tempPlayer,'errorMsg',{message:'این اتاق دیگر وجود ندارد', fatal:true}); return; }
    const player = room.players.get(String(msg.playerId||''));
    if(!player){ send(tempPlayer,'errorMsg',{message:'اطلاعات بازیکن پیدا نشد', fatal:true}); return; }
    player.socket = conn.socket;
    player.connected = true;
    conn.roomCode = code; conn.playerId = player.id;
    clearTimeout(room.emptyCleanupTimer);
    if(room.hostId && !room.players.get(room.hostId)){ room.hostId = player.id; }
    send(player, 'joined', {code, playerId: player.id, isHost: room.hostId === player.id});
    send(player, 'canvasSnapshot', {strokes: room.currentStrokes});
    broadcastState(room);
    return;
  }
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
    const colorIdx = nextFreeColorIdx(room);
    room.players.set(id, {id, name: String(msg.name||'بازیکن').slice(0,16) || 'بازیکن', colorIdx, score:0, connected:true, socket: conn.socket});
    conn.roomCode = code; conn.playerId = id;
    send(room.players.get(id), 'joined', {code, playerId:id, isHost:false});
    broadcastState(room);
    return;
  }

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
    if(room.hostId !== player.id || room.status !== 'final') return;
    startGameForRoom(room);
  }
  else if(type === 'leaveRoom'){
    room.players.delete(player.id);
    conn.roomCode = null; conn.playerId = null;
    if(room.hostId === player.id){
      const next = activePlayers(room)[0];
      room.hostId = next ? next.id : null;
    }
    if(room.status === 'drawing' && room.currentDrawerId === player.id){
      endTurn(room);
    } else if(room.status === 'turnEnd' && room.nextTurnInfo && room.nextTurnInfo.drawerId === player.id){
      if(room.nextTurnInfo.word) room.usedWords.delete(room.nextTurnInfo.word);
      room.nextTurnInfo = computeNextTurnInfo(room);
      broadcastState(room);
    } else {
      checkAllGuessedOrEnd(room);
      broadcastState(room);
    }
    scheduleEmptyCleanup(room);
  }
  else if(type === 'closeRoom'){
    if(room.hostId !== player.id) return;
    broadcastAll(room, 'roomClosed', {});
    clearRoomTimers(room);
    rooms.delete(room.code);
  }
}

function handleDisconnect(conn){
  if(!conn.roomCode) return;
  const room = rooms.get(conn.roomCode);
  if(!room) return;
  const player = room.players.get(conn.playerId);
  if(!player || !player.connected) return;
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
  } else if(room.status === 'turnEnd'){
    if(room.nextTurnInfo && room.nextTurnInfo.drawerId === player.id){
      if(room.nextTurnInfo.word) room.usedWords.delete(room.nextTurnInfo.word);
      room.nextTurnInfo = computeNextTurnInfo(room);
      broadcastState(room);
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

const liveConns = new Set();
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

  const conn = { socket, roomCode:null, playerId:null, lastPong: Date.now() };
  liveConns.add(conn);
  const feed = makeFrameParser((opcode, payload)=>{
    if(opcode === 0x8){ try{ socket.end(); }catch(e){} return; }
    if(opcode === 0x9){ sendPong(socket, payload); return; }
    if(opcode === 0xA){ conn.lastPong = Date.now(); return; }
    if(opcode === 0x1){
      let msg;
      try{ msg = JSON.parse(payload.toString('utf8')); }catch(e){ return; }
      conn.lastPong = Date.now();
      try{ handleMessage(conn, msg); }catch(e){ console.error('handleMessage error:', e); }
    }
  });
  socket.on('data', feed);
  socket.on('close', ()=>{ liveConns.delete(conn); try{ handleDisconnect(conn); }catch(e){} });
  socket.on('error', ()=>{ liveConns.delete(conn); try{ handleDisconnect(conn); }catch(e){} });
  socket.setTimeout(0);
});

setInterval(()=>{
  const now = Date.now();
  liveConns.forEach(conn=>{
    if(now - conn.lastPong > 70000){
      liveConns.delete(conn);
      try{ conn.socket.destroy(); }catch(e){}
      try{ handleDisconnect(conn); }catch(e){}
    } else {
      sendPing(conn.socket);
    }
  });
}, 25000);

server.listen(PORT, ()=>{ console.log('خط‌خطی server listening on port ' + PORT); });
