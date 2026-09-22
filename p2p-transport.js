/* ============================================================
   p2p-transport.js — اتصال مستقیم بین گوشی‌ها بدون اینترنت
   (WebRTC DataChannel + تبادل دستی کد اتصال روی وای‌فای/هات‌اسپات مشترک)
   ============================================================

   استفاده در سمت میزبان (کسی که بازی را اجرا می‌کند):
     const host = P2P.createHost({
       onPeerMessage: (peerId, msg) => { ... },   // پیام از هر مهمان
       onPeerConnect: (peerId) => { ... },
       onPeerDisconnect: (peerId) => { ... },
     });
     const code = await host.createInviteCode();   // این را نشان بده (متن/QR)
     // وقتی مهمان کد پاسخ را داد:
     await host.acceptGuestCode(peerId, guestAnswerCode);
     host.sendTo(peerId, {type:'x'});
     host.broadcast({type:'x'});

   استفاده در سمت مهمان:
     const guest = P2P.createGuest({
       onMessage: (msg) => { ... },
       onConnect: () => { ... },
       onDisconnect: () => { ... },
     });
     const answerCode = await guest.joinWithInviteCode(hostInviteCode);
     // answerCode را به میزبان بده (تایپ یا اسکن)
     guest.send({type:'x'});

   نکته: چون هر دو طرف روی یک شبکه‌ی محلی هستند (وای‌فای/هات‌اسپات)،
   مرورگر کاندیدهای IP محلی (host candidates) تولید می‌کند که برای
   اتصال کافی‌اند و نیازی به سرور STUN/TURN (و در نتیجه اینترنت) نیست.
   اگر مرورگر یا شبکه‌ی خاصی این کاندیدها را ندهد، اتصال شکست می‌خورد؛
   raceForIceGatheringComplete پایین صرفاً منتظر جمع‌آوری کامل کاندیدها
   می‌ماند تا کد اتصال شامل همه‌ی مسیرهای ممکن باشد.
*/
(function(global){
  'use strict';

  const RTC_CONFIG = { iceServers: [] }; /* عمداً خالی: هیچ سرور خارجی/اینترنتی لازم نیست */
  const CODE_PREFIX = 'KHT1:'; /* برای تشخیص/اعتبارسنجی سریع کد */

  function encodeCode(obj){
    const json = JSON.stringify(obj);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    return CODE_PREFIX + b64;
  }
  function decodeCode(code){
    if(typeof code !== 'string') throw new Error('کد نامعتبر است');
    const trimmed = code.trim();
    if(!trimmed.startsWith(CODE_PREFIX)) throw new Error('این یک کد خط‌خطی نیست');
    const b64 = trimmed.slice(CODE_PREFIX.length);
    const json = decodeURIComponent(escape(atob(b64)));
    return JSON.parse(json);
  }

  /* منتظر می‌ماند تا جمع‌آوری کاندیدهای ICE تمام شود (یا حداکثر تایم‌اوت)
     تا offer/answer شامل همه‌ی مسیرهای شبکه‌ی محلی باشد. */
  function waitForIceGatheringComplete(pc, timeoutMs){
    if(pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve)=>{
      let done = false;
      const finish = ()=>{
        if(done) return;
        done = true;
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      function check(){
        if(pc.iceGatheringState === 'complete') finish();
      }
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(finish, timeoutMs || 2500);
    });
  }

  function genPeerId(){
    return 'p_' + Math.random().toString(36).slice(2,10);
  }

  /* ================= میزبان ================= */
  function createHost(handlers){
    handlers = handlers || {};
    const peers = new Map(); /* peerId -> {pc, channel} */

    function makePeerConnection(peerId){
      const pc = new RTCPeerConnection(RTC_CONFIG);
      const channel = pc.createDataChannel('game', { ordered: true });
      wireChannel(peerId, channel);
      pc.onconnectionstatechange = ()=>{
        if(['failed','closed','disconnected'].includes(pc.connectionState)){
          peers.delete(peerId);
          handlers.onPeerDisconnect && handlers.onPeerDisconnect(peerId);
        }
      };
      peers.set(peerId, { pc, channel });
      return { pc, channel };
    }

    function wireChannel(peerId, channel){
      channel.onopen = ()=> handlers.onPeerConnect && handlers.onPeerConnect(peerId);
      channel.onclose = ()=>{
        peers.delete(peerId);
        handlers.onPeerDisconnect && handlers.onPeerDisconnect(peerId);
      };
      channel.onmessage = (ev)=>{
        let msg;
        try{ msg = JSON.parse(ev.data); }catch(e){ return; }
        handlers.onPeerMessage && handlers.onPeerMessage(peerId, msg);
      };
    }

    async function createInviteCode(){
      const peerId = genPeerId();
      const { pc } = makePeerConnection(peerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);
      const code = encodeCode({ k:'offer', peerId, sdp: pc.localDescription });
      return { peerId, code };
    }

    async function acceptGuestCode(peerId, guestCode){
      const entry = peers.get(peerId);
      if(!entry) throw new Error('این peerId شناخته‌شده نیست؛ اول createInviteCode را صدا بزنید');
      const data = decodeCode(guestCode);
      if(data.k !== 'answer') throw new Error('این کد پاسخ مهمان نیست');
      await entry.pc.setRemoteDescription(data.sdp);
    }

    function sendTo(peerId, msg){
      const entry = peers.get(peerId);
      if(entry && entry.channel.readyState === 'open'){
        entry.channel.send(JSON.stringify(msg));
        return true;
      }
      return false;
    }
    function broadcast(msg, exceptPeerId){
      const str = JSON.stringify(msg);
      peers.forEach((entry, peerId)=>{
        if(peerId === exceptPeerId) return;
        if(entry.channel.readyState === 'open') entry.channel.send(str);
      });
    }
    function disconnectPeer(peerId){
      const entry = peers.get(peerId);
      if(entry){ try{ entry.pc.close(); }catch(e){} peers.delete(peerId); }
    }
    function listPeers(){ return Array.from(peers.keys()); }

    return { createInviteCode, acceptGuestCode, sendTo, broadcast, disconnectPeer, listPeers };
  }

  /* ================= مهمان ================= */
  function createGuest(handlers){
    handlers = handlers || {};
    let pc = null;
    let channel = null;

    async function joinWithInviteCode(hostCode){
      const data = decodeCode(hostCode);
      if(data.k !== 'offer') throw new Error('این کد دعوت میزبان نیست');
      pc = new RTCPeerConnection(RTC_CONFIG);
      pc.ondatachannel = (ev)=>{
        channel = ev.channel;
        channel.onopen = ()=> handlers.onConnect && handlers.onConnect();
        channel.onclose = ()=> handlers.onDisconnect && handlers.onDisconnect();
        channel.onmessage = (e)=>{
          let msg;
          try{ msg = JSON.parse(e.data); }catch(err){ return; }
          handlers.onMessage && handlers.onMessage(msg);
        };
      };
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGatheringComplete(pc);
      return encodeCode({ k:'answer', peerId: data.peerId, sdp: pc.localDescription });
    }

    function send(msg){
      if(channel && channel.readyState === 'open'){
        channel.send(JSON.stringify(msg));
        return true;
      }
      return false;
    }
    function isConnected(){ return !!channel && channel.readyState === 'open'; }
    function close(){ if(pc){ try{ pc.close(); }catch(e){} } }

    return { joinWithInviteCode, send, isConnected, close };
  }

  global.P2P = { createHost, createGuest, encodeCode, decodeCode };
})(window);
