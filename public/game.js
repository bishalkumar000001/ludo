const tg=window.Telegram?.WebApp;tg?.ready();tg?.expand();
const params=new URLSearchParams(location.search),start=tg?.initDataUnsafe?.start_param||'';
const roomCode=(params.get('room')||params.get('tgWebAppStartParam')||start||'').trim().toUpperCase();
const wsProto=location.protocol==='https:'?'wss':'ws',wsUrl=`${wsProto}://${location.host}`;
const state={room:null,ws:null,reconnect:null,me:null};
const board=document.getElementById('board'),players=document.getElementById('players'),dice=document.getElementById('dice'),roll=document.getElementById('roll'),startBtn=document.getElementById('start'),rematch=document.getElementById('rematch'),status=document.getElementById('status');
const colors=['r','g','y','b'];
const colorNames=['RED','GREEN','YELLOW','BLUE'];
// Classic 15x15 Ludo ring, clockwise from Red's start.
const track=[];
track.push(...Array.from({length:5},(_,i)=>[6,i+1]));
track.push(...Array.from({length:5},(_,i)=>[5-i,6]));
track.push(...[[0,6],[0,7],[0,8]]);
track.push(...Array.from({length:5},(_,i)=>[1+i,8]));
track.push(...Array.from({length:5},(_,i)=>[6,9+i]));
track.push(...[[6,14],[7,14],[8,14]]);
track.push(...Array.from({length:5},(_,i)=>[8,13-i]));
track.push(...Array.from({length:5},(_,i)=>[9+i,8]));
track.push(...[[14,8],[14,7],[14,6]]);
track.push(...Array.from({length:5},(_,i)=>[13-i,6]));
track.push(...Array.from({length:5},(_,i)=>[8,5-i]));
track.push(...[[8,0],[7,0],[6,0]]);
const safe=new Set([0,8,13,21,26,34,39,47]);
const startCells=[0,13,26,39];
const lanes=[
  [[7,1],[7,2],[7,3],[7,4],[7,5]],
  [[1,7],[2,7],[3,7],[4,7],[5,7]],
  [[7,13],[7,12],[7,11],[7,10],[7,9]],
  [[13,7],[12,7],[11,7],[10,7],[9,7]]
];
const yards=[
  [[1,1],[1,4],[4,1],[4,4]],
  [[1,10],[1,13],[4,10],[4,13]],
  [[10,10],[10,13],[13,10],[13,13]],
  [[10,1],[10,4],[13,1],[13,4]]
];
function me(){const u=tg?.initDataUnsafe?.user;if(u?.id)return{telegramId:String(u.id),username:u.username||'',firstName:u.first_name||u.username||'Player',lastName:u.last_name||'',photoUrl:u.photo_url||''};let id=localStorage.ludoGuest;if(!id)localStorage.ludoGuest=id='guest_'+crypto.randomUUID();return{telegramId:id,username:'',firstName:'Guest',lastName:'',photoUrl:''}}state.me=me();
function say(t,e=false){status.textContent=t;status.classList.toggle('error',e)}
function cell(r,c,cls=''){const d=document.createElement('div');d.className='cell '+cls;d.dataset.r=r;d.dataset.c=c;return d}
function build(){
  board.innerHTML='';
  const cells=new Map(), trackMap=new Set(track.map(([r,c])=>r+','+c));
  for(let r=0;r<15;r++)for(let c=0;c<15;c++){
    let cls='';
    if(r<6&&c<6) cls='home r';
    else if(r<6&&c>8) cls='home g';
    else if(r>8&&c>8) cls='home y';
    else if(r>8&&c<6) cls='home b';
    else cls='field';
    if(trackMap.has(r+','+c)) cls+=' track';
    for(let pi=0;pi<4;pi++) if(lanes[pi].some(([lr,lc])=>lr===r&&lc===c)) cls+=' lane '+colors[pi];
    const ti=track.findIndex(([tr,tc])=>tr===r&&tc===c);
    if(ti>=0 && safe.has(ti)) cls+=' safe';
    if(ti>=0 && startCells.includes(ti)) cls+=' start '+colors[startCells.indexOf(ti)];
    if(r>=6&&r<=8&&c>=6&&c<=8) cls+=' center-cell';
    const d=cell(r,c,cls);cells.set(r+','+c,d);board.appendChild(d);
  }
  yards.forEach((list,pi)=>list.forEach(([r,c],ti)=>cells.get(r+','+c)?.classList.add('yard',colors[pi],`yard-${ti}`)));
  const finish=document.createElement('div');finish.className='finish';finish.innerHTML='<span>★</span>';board.appendChild(finish);
  return cells;
}
const cells=build();
function pos(pi,ti,p){
  if(p===-1)return yards[pi][ti];
  if(p>=52&&p<57)return lanes[pi][p-52];
  if(p>=57)return [7,7];
  return track[(pi*13+p)%52];
}
function render(){
  const r=state.room;if(!r)return;
  document.getElementById('roomLabel').textContent='ROOM '+r.roomCode;
  document.getElementById('connection').textContent=state.ws?.readyState===1?'ONLINE':'RECONNECTING';
  players.innerHTML='';
  r.players.forEach((p,i)=>{const x=document.createElement('div');x.className='player '+colors[i]+(i===r.current?' turn':'');const avatar=p.photoUrl?`<img class="avatar" src="${esc(p.photoUrl)}">`:`<div class="avatar initials">${esc((p.firstName||'P').slice(0,1).toUpperCase())}</div>`;x.innerHTML=`${avatar}<div class="pname"><b>${esc(p.firstName||p.username||'Player')}</b><small>${p.username?'@'+esc(p.username):'Player '+(i+1)} · ${colorNames[i]}</small></div>`;players.appendChild(x)});
  dice.textContent=r.dice??'–';
  dice.classList.toggle('rolled',r.dice!=null);
  const meI=r.players.findIndex(p=>String(p.telegramId)===state.me.telegramId);
  roll.disabled=!(r.status==='playing'&&meI===r.current&&r.dice==null);
  startBtn.classList.toggle('hidden',r.status!=='waiting');startBtn.disabled=!(meI===0&&r.players.length>=2);
  rematch.classList.toggle('hidden',r.status!=='finished');rematch.disabled=meI!==0;
  say(r.status==='waiting'?`${r.players.length}/4 players · ${meI===0?'You are host':'Waiting for host'}`:r.status==='finished'?`${r.players[r.winner]?.firstName||'Player'} won the game!`:meI===r.current?(r.dice?'Choose a highlighted token':'Your turn · roll the dice'):`Waiting for ${r.players[r.current]?.firstName||'player'}`);
  draw(r);
}
function draw(r){
  document.querySelectorAll('.token').forEach(x=>x.remove());if(!r.tokens)return;
  r.tokens.forEach((ts,pi)=>ts.forEach((p,ti)=>{
    const [rr,cc]=pos(pi,ti,p),d=cells.get(rr+','+cc);if(!d)return;
    const x=document.createElement('button');x.className='token '+colors[pi];x.textContent=ti+1;x.title=`${colorNames[pi]} token ${ti+1}`;
    const meI=r.players.findIndex(q=>String(q.telegramId)===state.me.telegramId);
    const movable=r.status==='playing'&&r.current===pi&&pi===meI&&r.dice&&((p===-1&&r.dice===6)||(p>=0&&p+r.dice<=57));
    if(movable)x.classList.add('movable');
    x.onclick=()=>{if(movable)send('move',{tokenIndex:ti})};d.appendChild(x);
  }));
}
function esc(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function send(type,extra={}){if(state.ws?.readyState!==1)return say('Not connected',true);state.ws.send(JSON.stringify({type,roomCode,telegramId:state.me.telegramId,...extra}));tg?.HapticFeedback?.impactOccurred('light')}
function connect(){if(!roomCode)return say('Room code missing',true);if(state.ws?.readyState<=1)return;state.ws=new WebSocket(wsUrl);state.ws.onopen=()=>{state.ws.send(JSON.stringify({type:'join',roomCode,player:state.me}))};state.ws.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.room){state.room=m.room;render()}if(m.type==='error')say(m.message||'Error',true)}catch{}};state.ws.onclose=()=>{clearTimeout(state.reconnect);state.reconnect=setTimeout(connect,1200)};state.ws.onerror=()=>say('Connection error',true)}
roll.onclick=()=>send('roll');startBtn.onclick=()=>send('start');rematch.onclick=()=>send('rematch');connect();render();
