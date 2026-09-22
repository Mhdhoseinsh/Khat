/* ============================================================
   local-mode.js — پل بین رابط بازی (index.html) و بازی محلی
   بدون اینترنت (WebRTC + موتور اجراشونده در مرورگر میزبان)
   ============================================================
   این فایل یک شیء شبیه‌به‌WebSocket می‌سازد (همان رابط: readyState،
   send، addEventListener('open'/'message'/'close')) تا کد فعلی
   index.html (تابع connectWs/sendMsg) بدون هیچ تغییری با آن کار کند.
   نیازمند: p2p-transport.js و local-engine.js (هر دو باید قبل از
   این فایل لود شوند).
*/
(function(global){
  'use strict';

  /* شیء شبیه‌ساز WebSocket */
  class FakeSocket{
    constructor(){
      this.readyState = 0; /* 0 connecting, 1 open, 2 closing, 3 closed */
      this._listeners = { open:[], message:[], close:[], error:[] };
    }
    addEventListener(type, fn){ (this._listeners[type] || (this._listeners[type]=[])).push(fn); }
    removeEventListener(type, fn){
      if(!this._listeners[type]) return;
      this._listeners[type] = this._listeners[type].filter(f=> f!==fn);
    }
    _emit(type, ev){ (this._listeners[type]||[]).slice().forEach(fn=>{ try{ fn(ev||{}); }catch(e){ console.error(e); } }); }
    _open(){ this.readyState = 1; this._emit('open'); }
    _receive(jsonStr){ this._emit('message', { data: jsonStr }); }
    _close(){ this.readyState = 3; this._emit('close'); }
    send(str){ throw new Error('send() باید override شود'); }
    close(){ this._close(); }
  }

  /* ================= حالت میزبان (Host) ================= */
  /* میزبان یک نمونه از موتور بازی را در همین صفحه اجرا می‌کند.
     خودِ میزبان از طریق یک اتصال لوپ‌بک (بدون شبکه) با موتور صحبت می‌کند؛
     مهمان‌های دیگر از طریق WebRTC (P2P) وصل می‌شوند. */
  function startHost(){
    const engine = window.createLocalEngine();
    const fake = new FakeSocket();

    /* --- خودِ میزبان به‌عنوان یک بازیکن، از طریق لوپ‌بک --- */
    const hostConn = { roomCode:null, playerId:null, socket:{
      send: (str)=> setTimeout(()=> fake._receive(str), 0)
    }};
    fake.send = function(str){
      setTimeout(()=>{
        let msg; try{ msg = JSON.parse(str); }catch(e){ return; }
        try{ engine.handleMessage(hostConn, msg); }catch(e){ console.error('engine error:', e); }
      }, 0);
    };
    setTimeout(()=> fake._open(), 0);

    /* --- مهمان‌های راه‌دور، از طریق WebRTC DataChannel --- */
    const peerConns = new Map(); /* peerId -> conn */
    const p2pHost = P2P.createHost({
      onPeerMessage: (peerId, msg)=>{
        let conn = peerConns.get(peerId);
        if(!conn){
          conn = { roomCode:null, playerId:null, socket:{
            send: (str)=> p2pHost.sendTo(peerId, JSON.parse(str))
          }};
          peerConns.set(peerId, conn);
        }
        try{ engine.handleMessage(conn, msg); }catch(e){ console.error('engine error:', e); }
      },
      onPeerDisconnect: (peerId)=>{
        const conn = peerConns.get(peerId);
        if(conn){ try{ engine.handleDisconnect(conn); }catch(e){} peerConns.delete(peerId); }
        peerConns.delete(peerId);
      }
    });

    async function inviteNewGuest(){
      const { peerId, code } = await p2pHost.createInviteCode();
      return {
        peerId, inviteCode: code,
        acceptAnswer: (answerCode)=> p2pHost.acceptGuestCode(peerId, answerCode)
      };
    }

    return { socket: fake, inviteNewGuest };
  }

  /* ================= حالت مهمان (Guest) ================= */
  function startGuest(){
    const fake = new FakeSocket();
    const p2pGuest = P2P.createGuest({
      onConnect: ()=> fake._open(),
      onDisconnect: ()=> fake._close(),
      onMessage: (msg)=> fake._receive(JSON.stringify(msg))
    });
    fake.send = function(str){
      let msg; try{ msg = JSON.parse(str); }catch(e){ return; }
      p2pGuest.send(msg);
    };
    async function joinWithInviteCode(hostCode){
      return p2pGuest.joinWithInviteCode(hostCode); /* برمی‌گرداند: answerCode برای دادن به میزبان */
    }
    return { socket: fake, joinWithInviteCode };
  }

  global.LocalMode = { startHost, startGuest };
})(window);
