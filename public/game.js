const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const params = new URLSearchParams(location.search);
const tgStart = tg?.initDataUnsafe?.start_param || '';
const roomCode = (params.get('room') || params.get('tgWebAppStartParam') || tgStart || '').trim().toUpperCase();
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = `${wsProto}://${location.host}`;

const state = { room:null, ws:null, connected:false, reconnectTimer:null, me:null };
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

function getMe() {
  const u = tg?.initDataUnsafe?.user;
  if (u?.id) return { telegramId:String(u.id), username:u.username||'', firstName:u.first_name||'Player', photoUrl:u.photo_url||'' };
  let id = localStorage.getItem('velocity_ludo_guest_id');
  if (!id) { id = `guest_${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`; localStorage.setItem('velocity_ludo_guest_id', id); }
  return { telegramId:id, username:'', firstName:'Player', photoUrl:'' };
}
state.me = getMe();

const colors = ['#ff475d','#45d483','#ffd447','#4f8cff'];
const track = [];
for (let i=0;i<52;i++) {
  const a = -Math.PI/2 + (i/52)*Math.PI*2;
  track.push([500 + Math.cos(a)*340, 500 + Math.sin(a)*340]);
}
const homes = [[90,90],[610,90],[610,610],[90,610]];

function setStatus(t,error=false){ statusEl.textContent=t; statusEl.classList.toggle('error',error); }
function resize(){
  const r=canvas.getBoundingClientRect(), d=Math.min(devicePixelRatio||1,3);
  canvas.width=Math.floor(r.width*d); canvas.height=Math.floor(r.height*d);
  ctx.setTransform(d,0,0,d,0,0); draw();
}
window.addEventListener('resize',resize);

function draw(){
  const w=canvas.clientWidth,h=canvas.clientHeight,s=Math.min(w,h),x=(w-s)/2,y=(h-s)/2;
  ctx.clearRect(0,0,w,h); ctx.save(); ctx.translate(x,y); ctx.scale(s/1000,s/1000);

  ctx.fillStyle='#111725'; roundRect(0,0,1000,1000,38); ctx.fill();

  // Homes
  homes.forEach((p,i)=>{
    ctx.fillStyle=colors[i]+'32'; roundRect(p[0],p[1],300,300,34); ctx.fill();
    ctx.strokeStyle=colors[i]+'88'; ctx.lineWidth=4; ctx.stroke();
    for(let k=0;k<4;k++){
      const ox=p[0]+85+(k%2)*130, oy=p[1]+85+Math.floor(k/2)*130;
      ctx.fillStyle='#080b12aa'; ctx.beginPath(); ctx.arc(ox,oy,34,0,Math.PI*2); ctx.fill();
    }
  });

  // Track
  for(let i=0;i<52;i++){
    const [px,py]=track[i];
    ctx.fillStyle=colors[i%4]+'55';
    ctx.beginPath();ctx.arc(px,py,23,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='#ffffff15';ctx.lineWidth=2;ctx.stroke();
  }
  // Finish center
  ctx.fillStyle='#f5f7fb'; ctx.beginPath();ctx.arc(500,500,115,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#101522'; ctx.font='900 24px system-ui'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(state.room?.status==='finished' ? 'FINISH' : 'LUDO',500,500);

  const tokens=state.room?.tokens||[];
  tokens.forEach((playerTokens,pi)=>{
    playerTokens.forEach((progress,ti)=>{
      const [px,py]=tokenPosition(pi,ti,progress);
      const movable = state.room?.status==='playing' &&
        state.room.current===pi &&
        state.room.dice &&
        state.room.players?.[pi]?.telegramId===state.me.telegramId &&
        validClientMove(progress,state.room.dice);
      pawn(px,py,colors[pi],1,movable,ti);
    });
  });
  ctx.restore();
}

function tokenPosition(pi,ti,progress){
  if(progress === -1 || progress >= 52){
    const [hx,hy]=homes[pi];
    return [hx+85+(ti%2)*130,hy+85+Math.floor(ti/2)*130];
  }
  const idx=(pi*13+progress)%52;
  return track[idx];
}
function validClientMove(progress,dice){
  if(progress>=57) return false;
  return progress===-1 ? dice===6 : progress+dice<=57;
}
function pawn(x,y,c,scale=1,active=false,ti=0){
  ctx.save();ctx.translate(x,y);ctx.scale(scale,scale);
  ctx.shadowColor='#000b';ctx.shadowBlur=active?22:12;
  ctx.fillStyle=c;ctx.beginPath();ctx.arc(0,-18,21,0,Math.PI*2);ctx.fill();
  ctx.beginPath();ctx.moveTo(-21,-4);ctx.lineTo(-18,34);ctx.quadraticCurveTo(0,49,18,34);ctx.lineTo(21,-4);ctx.closePath();ctx.fill();
  if(active){ctx.strokeStyle='#fff';ctx.lineWidth=5;ctx.beginPath();ctx.arc(0,0,34,0,Math.PI*2);ctx.stroke();}
  ctx.shadowBlur=0;ctx.fillStyle='#fff8';ctx.beginPath();ctx.arc(-7,-27,7,0,Math.PI*2);ctx.fill();
  ctx.restore();
}
function roundRect(x,y,w,h,r){
  ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();
}

function renderPlayers(){
  playersEl.innerHTML='';
  (state.room?.players||[]).forEach((p,i)=>{
    const el=document.createElement('div');
    el.className='player'+(i===state.room.current?' turn':'');
    const score=(state.room?.tokens?.[i]||[]).filter(v=>v===57).length;
    el.innerHTML=`<img class="avatar" src="${escapeAttr(p.photoUrl||'')}" onerror="this.style.visibility='hidden'">
      <div class="pname">${escapeHtml(p.firstName||p.username||'Player')} ${score?`<small>${score}/4</small>`:''}</div>`;
    playersEl.appendChild(el);
  });
}

function render(){
  roomLabel.textContent=`ROOM ${state.room?.roomCode||roomCode||'—'}`;
  renderPlayers();
  diceEl.textContent=state.room?.dice||'?';

  const meIndex=(state.room?.players||[]).findIndex(p=>String(p.telegramId)===state.me.telegramId);
  const mine=state.room?.current===meIndex;
  const canRoll=state.room?.status==='playing' && mine && state.room?.dice==null;
  rollBtn.disabled=!canRoll;

  startBtn.classList.toggle('hidden',state.room?.status!=='waiting');
  startBtn.disabled=!(meIndex===0 && (state.room?.players?.length||0)>=2);

  rematchBtn.classList.toggle('hidden',state.room?.status!=='finished');
  rematchBtn.disabled=meIndex!==0;

  if(state.room?.status==='waiting') setStatus(`${state.room.players.length}/4 players • ${meIndex===0?'You are host':'Waiting for host'}`);
  if(state.room?.status==='playing') {
    const p=state.room?.players?.[state.room.current];
    setStatus(mine ? (state.room.dice ? 'Choose a token to move' : 'Your turn — roll the dice') : `Waiting for ${p?.firstName||'player'}`);
  }
  if(state.room?.status==='finished') {
    const winner=state.room.players?.[state.room.winner];
    setStatus(`${winner?.firstName||'Player'} won the game!`);
  }
  draw();
}

function connect(){
  if(!roomCode){setStatus('Room code missing',true);connection.textContent='NO ROOM';return;}
  if(state.ws && state.ws.readyState<=1) return;
  connection.textContent='CONNECTING';
  state.ws=new WebSocket(wsUrl);
  state.ws.onopen=()=>{
    state.connected=true; connection.textContent='ONLINE';
    state.ws.send(JSON.stringify({type:'join',roomCode,player:state.me}));
  };
  state.ws.onmessage=e=>{
    let m; try{m=JSON.parse(e.data)}catch{return}
    if(m.type==='joined'||m.type==='state'){state.room=m.room;render();}
    if(m.type==='error'){
      setStatus(m.message||'Error',true);
      if(m.code==='ROOM_NOT_FOUND') connection.textContent='ROOM EXPIRED';
    }
  };
  state.ws.onclose=()=>{
    state.connected=false;
    if(connection.textContent!=='ROOM EXPIRED'){
      connection.textContent='RECONNECTING';
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer=setTimeout(connect,1500);
    }
  };
  state.ws.onerror=()=>setStatus('Connection error',true);
}
function send(type,extra={}){
  if(state.ws?.readyState!==1){setStatus('Not connected',true);return;}
  state.ws.send(JSON.stringify({type,roomCode,telegramId:state.me.telegramId,...extra}));
}

canvas.addEventListener('click',e=>{
  const room=state.room;
  if(!room || room.status!=='playing' || room.dice==null) return;
  const meIndex=room.players.findIndex(p=>String(p.telegramId)===state.me.telegramId);
  if(meIndex!==room.current) return;

  const r=canvas.getBoundingClientRect();
  const d=Math.min(devicePixelRatio||1,3);
  const s=Math.min(r.width,r.height);
  const ox=(r.width-s)/2, oy=(r.height-s)/2;
  const bx=(e.clientX-r.left-ox)*1000/s, by=(e.clientY-r.top-oy)*1000/s;

  let best=-1,bestDist=55;
  (room.tokens?.[meIndex]||[]).forEach((progress,ti)=>{
    if(!validClientMove(progress,room.dice)) return;
    const [px,py]=tokenPosition(meIndex,ti,progress);
    const dist=Math.hypot(px-bx,py-by);
    if(dist<bestDist){bestDist=dist;best=ti;}
  });
  if(best>=0) send('move',{tokenIndex:best});
});

rollBtn.onclick=()=>send('roll');
startBtn.onclick=()=>send('start');
rematchBtn.onclick=()=>send('rematch');
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function escapeAttr(s){return escapeHtml(s)}

resize();connect();
