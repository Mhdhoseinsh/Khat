/* ============================================================
   qr-chunks.js — نمایش کدهای بلند (دعوت/پاسخ) به‌صورت چند QR کد
   و اسکن آن‌ها با دوربین برای بازسازی کد کامل
   ============================================================
   وابسته به qrcode-gen.bundle.js (باید قبل از این فایل لود شود).
   کدهای طولانی WebRTC (offer/answer) را به چند تکه تقسیم می‌کند،
   هر تکه را در یک QR کد جدا نشان می‌دهد (با دکمه بعدی/قبلی یا
   پخش خودکار)، و برای طرف مقابل امکان اسکن پشت‌سرهم با دوربین و
   بازسازی خودکار کد کامل را فراهم می‌کند. کاملاً محلی و بدون
   نیاز به اینترنت.
*/
(function(global){
  'use strict';

  var CHUNK_TAG = 'QK1';
  var DEFAULT_CHUNK_LEN = 110; /* کاراکتر در هر QR؛ عدد کوچک = اسکن راحت‌تر با موبایل */

  function randSid(){
    return Math.random().toString(36).slice(2,6);
  }

  /* یک رشتهٔ طولانی را به چند تکهٔ قابل‌نمایش در QR تقسیم می‌کند */
  function splitCodeForQr(code, chunkLen){
    chunkLen = chunkLen || DEFAULT_CHUNK_LEN;
    var sid = randSid();
    var total = Math.max(1, Math.ceil(code.length / chunkLen));
    var chunks = [];
    for(var i = 0; i < total; i++){
      var part = code.slice(i * chunkLen, (i + 1) * chunkLen);
      chunks.push([CHUNK_TAG, sid, (i + 1), total, part].join('|'));
    }
    return chunks;
  }

  /* جمع‌کنندهٔ تکه‌ها هنگام اسکن؛ اگر یک ست جدید (sid جدید) شروع شود
     خودکار ریست می‌شود */
  function createChunkCollector(){
    var sid = null, total = null, parts = {};
    function reset(){ sid = null; total = null; parts = {}; }
    function ingest(text){
      if(typeof text !== 'string') return { ok:false };
      var segs = text.split('|');
      if(segs.length < 5 || segs[0] !== CHUNK_TAG) return { ok:false };
      var csid = segs[1];
      var idx = parseInt(segs[2], 10);
      var tot = parseInt(segs[3], 10);
      var payload = segs.slice(4).join('|');
      if(!csid || !idx || !tot || idx < 1 || idx > tot) return { ok:false };
      if(sid !== csid){ sid = csid; total = tot; parts = {}; }
      var isNew = !Object.prototype.hasOwnProperty.call(parts, idx);
      parts[idx] = payload;
      var got = Object.keys(parts).length;
      var done = got === total;
      var full = null;
      if(done){
        var arr = [];
        for(var i = 1; i <= total; i++) arr.push(parts[i]);
        full = arr.join('');
      }
      return { ok:true, isNew:isNew, progress:{ got:got, total:total }, done:done, full:full };
    }
    return { reset:reset, ingest:ingest };
  }

  /* رسم یک رشته به‌صورت QR روی canvas */
  function renderQrToCanvas(canvas, text, opts){
    opts = opts || {};
    var level = global.QRErrorCorrectLevel[opts.level || 'Q'];
    var qr = new global.QRCodeGen(0, level);
    qr.addData(text);
    qr.make();
    var count = qr.getModuleCount();
    var targetSize = opts.size || 260;
    var cell = Math.max(3, Math.floor(targetSize / (count + 8)));
    var margin = 4 * cell;
    var size = count * cell + margin * 2;
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for(var r = 0; r < count; r++){
      for(var c = 0; c < count; c++){
        if(qr.isDark(r, c)) ctx.fillRect(margin + c * cell, margin + r * cell, cell, cell);
      }
    }
    return canvas;
  }

  function makeOverlay(innerHtml){
    var ov = document.createElement('div');
    ov.className = 'reconnect-overlay show';
    ov.innerHTML = innerHtml;
    document.body.appendChild(ov);
    return ov;
  }

  /* نمایش چرخشی چند QR برای یک کد طولانی. options: { title, subtitle } */
  function openQrCarousel(code, options){
    options = options || {};
    var chunks = splitCodeForQr(code, options.chunkLen);
    var multi = chunks.length > 1;
    var ov = makeOverlay(
      '<div class="reconnect-card">' +
        '<div class="rc-title">' + (options.title || 'کد QR') + '</div>' +
        '<div class="rc-sub">' + (options.subtitle || 'طرف مقابل این کد(ها) را با دکمه «اسکن QR» بخواند.') + '</div>' +
        '<div style="display:flex;justify-content:center;margin:10px 0;">' +
          '<canvas id="qrCarouselCanvas" style="width:250px;height:250px;background:#fff;border-radius:10px;"></canvas>' +
        '</div>' +
        '<div style="text-align:center;font-size:13px;opacity:.75;margin-bottom:12px;" id="qrCarouselCounter"></div>' +
        (multi ?
          '<div class="rc-actions" style="flex-direction:row;gap:8px;">' +
            '<button type="button" class="btn btn-block" id="qrPrevBtn">قبلی</button>' +
            '<button type="button" class="btn btn-primary btn-block" id="qrNextBtn">بعدی</button>' +
          '</div>' +
          '<div class="rc-actions" style="margin-top:10px;">' +
            '<button type="button" class="btn btn-ghost btn-block" id="qrAutoBtn">پخش خودکار</button>' +
            '<button type="button" class="btn btn-ghost btn-block" id="qrCloseBtn">بستن</button>' +
          '</div>'
        :
          '<div class="rc-actions">' +
            '<button type="button" class="btn btn-ghost btn-block" id="qrCloseBtn">بستن</button>' +
          '</div>'
        ) +
      '</div>'
    );

    var idx = 0, timer = null;
    var canvas = ov.querySelector('#qrCarouselCanvas');
    var counterEl = ov.querySelector('#qrCarouselCounter');

    function render(){
      renderQrToCanvas(canvas, chunks[idx], { level:'Q', size:250 });
      counterEl.textContent = multi ? ('کد ' + (idx + 1) + ' از ' + chunks.length) : 'یک کد';
    }
    function next(){ idx = (idx + 1) % chunks.length; render(); }
    function prev(){ idx = (idx - 1 + chunks.length) % chunks.length; render(); }
    function close(){ if(timer) clearInterval(timer); ov.remove(); options.onClose && options.onClose(); }

    if(multi){
      ov.querySelector('#qrNextBtn').onclick = next;
      ov.querySelector('#qrPrevBtn').onclick = prev;
      ov.querySelector('#qrAutoBtn').onclick = function(){
        if(timer){
          clearInterval(timer); timer = null;
          this.textContent = 'پخش خودکار';
        } else {
          timer = setInterval(next, 2200);
          this.textContent = 'توقف پخش خودکار';
        }
      };
    }
    ov.querySelector('#qrCloseBtn').onclick = close;
    render();
    return { close: close };
  }

  /* بازکردن دوربین و اسکن پی‌درپی QRها تا تکمیل کد. options:
     { title, subtitle, onComplete(fullText), onClose(), onUnsupported() } */
  function openQrScanner(options){
    options = options || {};
    if(!('BarcodeDetector' in global) ){
      options.onUnsupported && options.onUnsupported();
      return null;
    }

    var detector;
    try{ detector = new global.BarcodeDetector({ formats:['qr_code'] }); }
    catch(e){ options.onUnsupported && options.onUnsupported(); return null; }

    var collector = createChunkCollector();
    var ov = makeOverlay(
      '<div class="reconnect-card">' +
        '<div class="rc-title">' + (options.title || 'اسکن کد QR') + '</div>' +
        '<div class="rc-sub">' + (options.subtitle || 'دوربین را روی کد(های) QR طرف مقابل بگیر؛ به هر ترتیب می‌توانی اسکن کنی.') + '</div>' +
        '<video id="qrScanVideo" playsinline autoplay muted style="width:100%;border-radius:10px;background:#000;max-height:300px;object-fit:cover;"></video>' +
        '<div style="text-align:center;font-size:13px;margin:10px 0;" id="qrScanStatus">در حال باز کردن دوربین...</div>' +
        '<div class="rc-actions">' +
          '<button type="button" class="btn btn-ghost btn-block" id="qrScanCancel">انصراف</button>' +
        '</div>' +
      '</div>'
    );

    var video = ov.querySelector('#qrScanVideo');
    var statusEl = ov.querySelector('#qrScanStatus');
    var stream = null, raf = null, stopped = false;

    function stop(){
      stopped = true;
      if(raf) cancelAnimationFrame(raf);
      if(stream){ try{ stream.getTracks().forEach(function(t){ t.stop(); }); }catch(e){} }
      ov.remove();
    }
    ov.querySelector('#qrScanCancel').onclick = function(){ stop(); options.onClose && options.onClose(); };

    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal:'environment' } } })
      .then(function(s){
        stream = s;
        video.srcObject = s;
        statusEl.textContent = 'در انتظار اسکن اول...';
        scanLoop();
      })
      .catch(function(){
        statusEl.textContent = 'دسترسی به دوربین ممکن نشد؛ اجازهٔ دوربین را بررسی کن.';
      });

    function scanLoop(){
      if(stopped) return;
      detector.detect(video).then(function(codes){
        if(codes && codes.length){
          for(var i = 0; i < codes.length; i++){
            var res = collector.ingest(codes[i].rawValue);
            if(res.ok && res.isNew){
              statusEl.textContent = 'دریافت شد: ' + res.progress.got + ' از ' + res.progress.total;
              if(res.done){
                stop();
                options.onComplete && options.onComplete(res.full);
                return;
              }
            }
          }
        }
      }).catch(function(){}).then(function(){
        if(!stopped) raf = requestAnimationFrame(scanLoop);
      });
    }

    return { stop: stop };
  }

  global.QR = {
    splitCodeForQr: splitCodeForQr,
    createChunkCollector: createChunkCollector,
    renderQrToCanvas: renderQrToCanvas,
    openQrCarousel: openQrCarousel,
    openQrScanner: openQrScanner,
    isScanSupported: function(){ return 'BarcodeDetector' in global; }
  };
})(window);
