(() => {
  const tg = window.Telegram?.WebApp;
  try { tg?.ready(); tg?.expand(); } catch {}
  const params = new URLSearchParams(location.search);
  const roomCode = (params.get("room") || "").toUpperCase();
  const stored = localStorage.getItem("ludo_player") || "{}";
  let me = JSON.parse(stored);
  if (!me.id) {
    me.id = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : crypto.randomUUID();
    me.name = tg?.initDataUnsafe?.user?.first_name || "Player";
    me.avatar = tg?.initDataUnsafe?.user?.photo_url || "";
    localStorage.setItem("ludo_player", JSON.stringify(me));
  }

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d", {alpha:false});
  const playersEl = document.getElementById("players");
  const rollBtn = document.getElementById("roll");
  const diceEl = document.getElementById("dice");
  const hintEl = document.getElementById("hint");
  const badge = document.getElementById("turnBadge");
  const roomEl = document.getElementById("roomCode");
  roomEl.textContent = roomCode || "------";

  let state = null, socket = null, myColor = null;
  let boardSize = 900;
  let pieces = {};
  let animating = false;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    boardSize = Math.min(canvas.width, canvas.height);
    ctx.setTransform(boardSize/900,0,0,boardSize/900,0,0);
  }
  addEventListener("resize", resize);
  resize();

  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}`;
  }

  function connect() {
    if (!roomCode) {
      hintEl.textContent = "Open a Ludo room link or add ?room=CODE.";
      return;
    }
    socket = new WebSocket(wsUrl());
    socket.onopen = () => socket.send(JSON.stringify({
      type:"join", code:roomCode, playerId:String(me.id), name:me.name, avatar:me.avatar
    }));
    socket.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type === "joined") { myColor = msg.color; return; }
      if (msg.type === "state") { state = msg.room; renderState(); }
      if (msg.type === "error") { hintEl.textContent = msg.error; }
    };
    socket.onclose = () => {
      hintEl.textContent = "Connection lost. Reconnecting…";
      setTimeout(connect, 1500);
    };
  }

  function send(obj) { if (socket?.readyState === 1) socket.send(JSON.stringify(obj)); }

  rollBtn.onclick = () => {
    if (!state) return;
    diceEl.classList.add("rolling");
    setTimeout(() => diceEl.classList.remove("rolling"), 600);
    send({type:"roll"});
  };

  function renderState() {
    playersEl.innerHTML = "";
    for (const p of state.players) {
      const el = document.createElement("div");
      el.className = "player";
      const av = p.avatar ? `<img src="${escapeHtml(p.avatar)}">` : escapeHtml((p.name||"?")[0].toUpperCase());
      el.innerHTML = `<div class="avatar ${p.color}">${av}</div><div class="pinfo"><div class="pname">${escapeHtml(p.name)}</div><div class="dots">${[0,1,2,3].map(()=>`<span class="dot ${p.color}"></span>`).join("")}</div></div>`;
      playersEl.appendChild(el);
    }
    while(playersEl.children.length<4) {
      const e=document.createElement("div");e.className="player";e.style.opacity=".25";e.innerHTML="<div class='avatar'>?</div><div class='pinfo'><div class='pname'>Waiting…</div></div>";playersEl.appendChild(e);
    }
    const cp = state.players[state.current];
    badge.textContent = state.status === "finished" ? "GAME FINISHED" : cp ? `${cp.name}'s turn` : "Waiting for players…";
    rollBtn.disabled = state.status !== "playing" || !cp || cp.id !== String(me.id) || state.dice !== null;
    hintEl.textContent = state.status === "waiting" ? "Share the room code. Minimum 2 players." :
      state.status === "finished" ? "Winner decided. Start a rematch from the game menu." :
      (cp?.id === String(me.id) ? (state.dice ? "Choose a highlighted token." : "Your turn — roll the dice.") : "Waiting for the other player.");
    diceEl.querySelector("span").textContent = state.dice || "?";
    draw();
  }

  function escapeHtml(s) {
    return String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  // Visual board. The server remains authoritative for all moves.
  const C = {red:"#f52f3f",green:"#1fd45f",yellow:"#ffc72c",blue:"#1687ff",cream:"#fff5df",dark:"#162234"};
  const path = [];
  for(let i=0;i<14;i++) path.push([i,6]);
  for(let i=1;i<6;i++) path.push([14,i]);
  for(let i=14;i>=1;i--) path.push([i,0]);
  for(let i=1;i<6;i++) path.push([0,i]);
  // fallback mapping for a 56-space loop, generated around the central cross
  const loop=[];
  for(let x=0;x<=14;x++) loop.push([x,6]);
  for(let y=5;y>=0;y--) loop.push([14,y]);
  for(let x=13;x>=0;x--) loop.push([x,0]);
  for(let y=1;y<=5;y++) loop.push([0,y]);
  for(let x=1;x<=14;x++) loop.push([x,6]);
  function cell(x,y,fill,stroke="#ffffff35"){
    const s=60, ox=0, oy=0;
    ctx.fillStyle=fill;ctx.fillRect(ox+x*s,oy+y*s,s-2,s-2);
    ctx.strokeStyle=stroke;ctx.lineWidth=1;ctx.strokeRect(ox+x*s,oy+y*s,s-2,s-2);
  }
  function rounded(x,y,w,h,r,fill,stroke){
    ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fillStyle=fill;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.stroke();}
  }
  function home(x,y,w,h,color,label){
    rounded(x,y,w,h,32,color);
    rounded(x+35,y+35,w-70,h-70,25,"#00000016","#ffffff35");
    ctx.fillStyle="#fff";ctx.font="900 22px system-ui";ctx.textAlign="center";ctx.fillText(label,x+w/2,y+28);
    [[x+110,y+120],[x+w-110,y+120],[x+110,y+h-120],[x+w-110,y+h-120]].forEach(([px,py])=>{
      ctx.beginPath();ctx.arc(px,py,29,0,Math.PI*2);ctx.fillStyle="#07111d45";ctx.fill();
    });
  }
  function draw(){
    const s=60;
    ctx.fillStyle="#f7ead3";ctx.fillRect(0,0,900,900);
    // premium background
    const g=ctx.createRadialGradient(450,450,80,450,450,650);g.addColorStop(0,"#fff9ee");g.addColorStop(1,"#ead9bb");ctx.fillStyle=g;ctx.fillRect(0,0,900,900);
    home(0,0,360,360,C.red,"RED");
    home(540,0,360,360,C.green,"GREEN");
    home(0,540,360,360,C.blue,"BLUE");
    home(540,540,360,360,C.yellow,"YELLOW");
    // center
    ctx.fillStyle=C.red;ctx.beginPath();ctx.moveTo(360,360);ctx.lineTo(540,360);ctx.lineTo(450,450);ctx.closePath();ctx.fill();
    ctx.fillStyle=C.green;ctx.beginPath();ctx.moveTo(540,360);ctx.lineTo(540,540);ctx.lineTo(450,450);ctx.closePath();ctx.fill();
    ctx.fillStyle=C.yellow;ctx.beginPath();ctx.moveTo(540,540);ctx.lineTo(360,540);ctx.lineTo(450,450);ctx.closePath();ctx.fill();
    ctx.fillStyle=C.blue;ctx.beginPath();ctx.moveTo(360,540);ctx.lineTo(360,360);ctx.lineTo(450,450);ctx.closePath();ctx.fill();
    ctx.fillStyle="#fff";ctx.font="900 50px system-ui";ctx.textAlign="center";ctx.fillText("♛",450,468);
    // track grid
    for(let i=0;i<15;i++) for(let j=0;j<15;j++){
      const inCenter=i>=6&&i<=8&&j>=6&&j<=8;
      const inHome=(i<6&&j<6)||(i>8&&j<6)||(i<6&&j>8)||(i>8&&j>8);
      if(!inCenter&&!inHome) cell(i,j,"#fff8ea");
    }
    // colored home lanes
    for(let i=6;i<=8;i++){cell(i,1,C.red);cell(i,2,C.red);cell(i,3,C.red);cell(i,4,C.red);cell(i,5,C.red);}
    for(let i=9;i<=13;i++) cell(i,7,C.yellow);
    for(let i=6;i<=8;i++){cell(i,9,C.blue);cell(i,10,C.blue);cell(i,11,C.blue);cell(i,12,C.blue);cell(i,13,C.blue);}
    for(let i=1;i<=5;i++) cell(i,7,C.blue);
    // stars
    [[1,6],[7,1],[13,8],[7,13]].forEach(([x,y])=>{ctx.fillStyle="#ffffff";ctx.font="900 29px system-ui";ctx.textAlign="center";ctx.fillText("★",x*s+29,y*s+40)});
    drawPieces();
  }

  function tokenPos(color,index,progress){
    const homeCoords={
      red:[[120,120],[240,120],[120,240],[240,240]],
      green:[[660,120],[780,120],[660,240],[780,240]],
      blue:[[120,660],[240,660],[120,780],[240,780]],
      yellow:[[660,660],[780,660],[660,780],[780,780]]
    };
    if(progress===-1) return homeCoords[color][index];
    if(progress>=57) return [450,450];
    const start=START[color];
    const n=(start+progress)%56;
    // approximate 56-step perimeter route around the board
    const coords=[];
    for(let x=1;x<=13;x++) coords.push([x,6]);
    for(let y=5;y>=1;y--) coords.push([14,y]);
    for(let x=13;x>=1;x--) coords.push([x,0]);
    for(let y=1;y<=5;y++) coords.push([0,y]);
    for(let x=1;x<=13;x++) coords.push([x,0]);
    for(let y=1;y<=6;y++) coords.push([14,y]);
    return coords[n%coords.length].map(v=>v*60+30);
  }
  function drawPieces(){
    if(!state)return;
    const order={red:0,green:1,yellow:2,blue:3};
    for(const p of state.players){
      p.tokens = p.tokens || [-1,-1,-1,-1];
      p.tokens.forEach((progress,i)=>{
        const [x,y]=tokenPos(p.color,i,progress);
        const c=C[p.color];
        ctx.save();ctx.shadowColor=c;ctx.shadowBlur=18;
        const grad=ctx.createRadialGradient(x-8,y-10,3,x,y,28);grad.addColorStop(0,"#fff");grad.addColorStop(.15,c);grad.addColorStop(1,"#111a2a");
        ctx.fillStyle=grad;ctx.beginPath();ctx.arc(x,y-8,24,0,Math.PI*2);ctx.fill();
        ctx.fillStyle=c;ctx.beginPath();ctx.arc(x,y+10,21,0,Math.PI*2);ctx.fill();
        ctx.fillStyle="#ffffff55";ctx.beginPath();ctx.arc(x-8,y-16,7,0,Math.PI*2);ctx.fill();
        ctx.restore();
      });
    }
  }

  canvas.addEventListener("click", e=>{
    if(!state || !state.dice || animating) return;
    const rect=canvas.getBoundingClientRect();
    const x=(e.clientX-rect.left)/rect.width*900;
    const y=(e.clientY-rect.top)/rect.height*900;
    const p=state.players.find(x=>x.id===String(me.id));
    if(!p || p.color!==myColor) return;
    let best=-1,dist=35;
    p.tokens.forEach((progress,i)=>{
      const pos=tokenPos(p.color,i,progress);
      const d=Math.hypot(pos[0]-x,pos[1]-y);
      if(d<dist){dist=d;best=i;}
    });
    if(best>=0){animating=true;send({type:"move",token:best});setTimeout(()=>animating=false,350);}
  });

  // 120Hz-capable rendering loop. Actual FPS is determined by the device/WebView.
  function frame(){ draw(); requestAnimationFrame(frame); }
  frame();
  connect();
})();