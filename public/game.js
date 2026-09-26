const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const params = new URLSearchParams(location.search);
const tgStart = tg?.initDataUnsafe?.start_param || '';
const roomCode = (params.get('room') || params.get('tgWebAppStartParam') || tgStart || '').trim().toUpperCase();
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = `${wsProto}://${location.host}`;
const state = { room:null, ws:null, connected:false, me:null, anim:0 };
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const playersEl = document.getElementById('players');
const roomLabel = document.getElementById('roomLabel');
const connection = document.getElementById('connection');
const statusEl = document.getElementById('status');
const diceEl = document.getElementById('dice');
const rollBtn = document.getElementById('roll');
const startBtn = document.getElementById('start');
const rematchBtn = document.getElementById('rematch');

function me() {
  const u = tg?.initDataUnsafe?.user;
  return { telegramId: String(u?.id || `guest_${Math.random().toString(36).slice(2)}`), username:u?.username||'', firstName:u?.first_name||'Player', photoUrl:u?.photo_url||'' };
}
state.me = me();

function setStatus(t, error=false){ statusEl.textContent=t; statusEl.classList.toggle('error',error); }
function resize(){ const r=canvas.getBoundingClientRect(), d=Math.min(devicePixelRatio||1,3); canvas.width=Math.floor(r.width*d); canvas.height=Math.floor(r.height*d); ctx.setTransform(d,0,0,d,0,0); draw(); }
window.addEventListener('resize',resize);

function draw(){
  const w=canvas.clientWidth,h=canvas.clientHeight,s=Math.min(w,h),x=(w-s)/2,y=(h-s)/2;
  ctx.clearRect(0,0,w,h); ctx.save(); ctx.translate(x,y); ctx.scale(s/1000,s/1000);
  const g=ctx.createLinearGradient(0,0,1000,1000);g.addColorStop(0,'#20283b');g.addColorStop(1,'#101522');ctx.fillStyle=g;roundRect(0,0,1000,1000,38);ctx.fill();
  const colors=['#ff475d','#45d483','#ffd447','#4f8cff'];
  const homes=[[30,30],[570,30],[570,570],[30,570]];
  homes.forEach((p,i)=>{ctx.fillStyle=colors[i]+'dd';roundRect(p[0],p[1],400,400,34);ctx.fill();ctx.fillStyle='#0c1018aa';roundRect(p[0]+75,p[1]+75,250,250,28);ctx.fill();for(let k=0;k<4;k++){const ox=p[0]+115+(k%2)*130,oy=p[1]+115+Math.floor(k/2)*130;ctx.fillStyle='#ffffff22';ctx.beginPath();ctx.arc(ox,oy,34,0,Math.PI*2);ctx.fill()}});
  ctx.fillStyle='#eef2f8';for(let i=0;i<15;i++){const t=400+i*40;ctx.fillRect(t,400,40,40);ctx.fillRect(400,t,40,40)}
  ctx.fillStyle='#fff';ctx.beginPath();ctx.moveTo(500,405);ctx.lineTo(595,500);ctx.lineTo(500,595);ctx.lineTo(405,500);ctx.closePath();ctx.fill();
  for(let i=0;i<4;i++){const px=500+Math.cos(i*Math.PI/2-Math.PI/4)*55,py=500+Math.sin(i*Math.PI/2-Math.PI/4)*55; pawn(px,py,colors[i],.9)}
  ctx.restore();
}
function pawn(x,y,c,scale=1){ctx.save();ctx.translate(x,y);ctx.scale(scale,scale);ctx.shadowColor='#000b';ctx.shadowBlur=18;ctx.fillStyle=c;ctx.beginPath();ctx.arc(0,-25,25,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.moveTo(-25,-8);ctx.lineTo(-20,45);ctx.quadraticCurveTo(0,62,20,45);ctx.lineTo(25,-8);ctx.closePath();ctx.fill();ctx.shadowBlur=0;ctx.fillStyle='#fff5';ctx.beginPath();ctx.arc(-8,-34,8,0,Math.PI*2);ctx.fill();ctx.restore()}
function roundRect(x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}

function renderPlayers(){
  playersEl.innerHTML='';
  (state.room?.players||[]).forEach((p,i)=>{const el=document.createElement('div');el.className='player'+(i===state.room.current?' turn':'');el.innerHTML=`<img class="avatar" src="${escapeAttr(p.photoUrl||'')}" onerror="this.style.visibility='hidden'"><div class="pname">${escapeHtml(p.firstName||p.username||'Player')}</div>`;playersEl.appendChild(el)});
}
function render(){
  roomLabel.textContent=`ROOM ${state.room?.roomCode||roomCode||'—'}`;
  renderPlayers();
  diceEl.textContent=state.room?.dice||'?';
  const mine=state.room?.players?.[state.room.current]?.telegramId===state.me.telegramId;
  rollBtn.disabled=!(state.room?.status==='playing'&&mine&&!state.room?.dice);
  startBtn.classList.toggle('hidden',state.room?.status!=='waiting');
  startBtn.disabled=(state.room?.players?.length||0)<2;
  rematchBtn.classList.toggle('hidden',state.room?.status!=='finished');
  if(state.room?.status==='waiting') setStatus(`${state.room.players.length}/4 players • Waiting to start`);
  if(state.room?.status==='playing') setStatus(mine?'Your turn':'Waiting for '+(state.room.players?.[state.room.current]?.firstName||'player'));
  draw();
}
function connect(){
  if(!roomCode){setStatus('Room code missing',true);connection.textContent='NO ROOM';return;}
  state.ws=new WebSocket(wsUrl); connection.textContent='CONNECTING';
  state.ws.onopen=()=>{state.connected=true;connection.textContent='ONLINE';state.ws.send(JSON.stringify({type:'join',roomCode,player:state.me}));};
  state.ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='joined'||m.type==='state'){state.room=m.room;render();}if(m.type==='error'){setStatus(m.message||'Error',true);if(m.code==='ROOM_NOT_FOUND')connection.textContent='ROOM EXPIRED';}};
  state.ws.onclose=()=>{state.connected=false;connection.textContent='RECONNECTING';setTimeout(()=>{if(!state.connected)connect()},1500)};
  state.ws.onerror=()=>setStatus('Connection error',true);
}
function send(type,extra={}){if(state.ws?.readyState===1)state.ws.send(JSON.stringify({type,roomCode,telegramId:state.me.telegramId,...extra}));}
rollBtn.onclick=()=>send('roll');
startBtn.onclick=()=>send('start');
rematchBtn.onclick=()=>send('rematch');
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function escapeAttr(s){return escapeHtml(s)}
resize();connect();
