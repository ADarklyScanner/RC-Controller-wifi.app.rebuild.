// Android app only, loaded by app.js the first time a mode is used (the M button, or two taps on the floor).
// Modes from Nessari's drive screen (v1.50-v1.70), without her brain or voice: tap to go, come back, turn around,
// race mode with a lap timer, follow (laser dot, tape, between two lines, a wall, the light, the dark), explore, and
// two set-up tests (turning and speed). Uses app.js's shared pieces (window.CarX): the room compass, the floor
// check, the lens and the small looks at the picture. Modes drive at speed 2, the speed every measurement was made at.
// Any stick, tap or the Stop button takes over from a mode.
(()=>{
const X=window.CarX;if(!X||window.CarModes)return;
const $=s=>document.querySelector(s),pause=ms=>new Promise(r=>setTimeout(r,ms));
const G2=2/3;   // (speed 2: drive messages count speed 3 as 1)
const say=m=>{try{X.toast(m)}catch(e){}};
// what the tests learned, kept on this phone
let D={};try{D=JSON.parse(localStorage.carmodes||'{}')||{}}catch(e){}
const dSave=()=>{try{localStorage.carmodes=JSON.stringify(D)}catch(e){}};

// ---------- the lens (the same chart-photo numbers as the floor ruler) ----------
const L=X.LENS;
const unbend=(x,y,w,h)=>{const u=(x-w/2)/w,v=(y-L.cy*h)/w,s=1+L.k*(u*u+v*v);return[u/s,v/s]};
const bend=(u,v,w,h)=>{const r=Math.hypot(u,v),k=L.k,s=r<1e-9?1:(1-Math.sqrt(1-4*k*r*r))/(2*k*r*r);return[w/2+u*s*w,L.cy*h+v*s*w]};
const lensAngle=(x,y,w,h)=>Math.atan(unbend(x,y,w,h)[0]/L.f)*180/Math.PI;
// where on the floor a picture point is: cm right of the middle, cm ahead of the nose (null above the horizon)
const floorFrom=(x,y,w,h)=>{const[u,v]=unbend(x,y,w,h);if(!(v>.004))return null;const z=L.f*L.h/v;return{x:u*z/L.f,d:z-L.nose}};
const floorAt=(x,d,w,h)=>{const z=Math.max(.5,d+L.nose);return bend(L.f*x/z,L.f*L.h/z,w,h)};

// ---------- running one mode at a time ----------
let run=null;
const stopped=()=>!run||run.stop;
const send=(t,s,ms)=>X.f0('/drive?t='+t.toFixed(3)+'&s='+s.toFixed(2)+'&ms='+Math.round(ms)).catch(()=>{});
const halt=()=>X.f0('/stop').catch(()=>{});
function pill(text){let p=$('#mpill');if(!p){document.body.insertAdjacentHTML('beforeend','<button id=mpill></button>');p=$('#mpill');p.onclick=()=>{if(run)run.stop=true;halt()}}
 p.textContent=text?text+'  ·  tap to stop':'';p.classList.toggle('on',!!text)}
async function start(label,fn){if(run){run.stop=true;await pause(150)}
 const me={label,stop:false};run=me;X.busy=1;X.cancel=()=>{me.stop=true};pill(label);closePanel();
 try{await fn()}catch(e){}finally{if(run===me){await halt();run=null;X.busy=0;X.floor=0;X.seek=race.on?raceLook:null;X.cancel=null;pill('')}}}
const camOk=async()=>{const t0=Date.now();while(Date.now()-X.cam.at>500&&Date.now()-t0<3000&&!stopped())await pause(100);return Date.now()-X.cam.at<=500};

// ---------- driving a stretch: throttle t (of speed 2), steering s, for ms ----------
// hold: the room compass keeps the heading it started with; bubble: stops short of something on the floor ahead;
// stuck: stops when the picture hasn't moved for a second after it got going. Says how long and whether it was blocked.
async function drive(t,s,ms,o={}){const t0=Date.now();let st=s,aim=null,still=0,blocked=null;const v=X.vOf(t*G2,false);
 if(o.hold)X.yawStart();if(o.bubble)X.floor=1;
 try{while(Date.now()-t0<ms&&!stopped()){const now=Date.now();
  if(o.hold&&X.yaw.score>=.5&&now-X.yaw.at<400){if(aim==null)aim=X.yaw.deg;const err=X.yaw.deg-aim;st=Math.max(-.7,Math.min(.7,-Math.sign(t)*err/36))}
  if(o.stuck&&now-t0>1200&&now-X.cam.at<400){if(X.cam.motion<X.STILL){still=still||now;if(now-still>1000){blocked=0;break}}else still=0}
  if(o.bubble&&t>0){const cm=X.clearAhead(now);if(cm<X.handStop(v)+3){blocked=cm;break}}
  const left=ms-(now-t0);send(t*G2,st,Math.min(400,Math.max(150,left)));await pause(Math.min(100,Math.max(20,left)))}}
 finally{await halt();if(o.hold)X.yawStop();if(o.bubble&&!o.keepFloor)X.floor=0}
 return{took:Date.now()-t0,blocked}}

// ---------- turning, measured parked (Nessari v1.50-v1.62: counting while moving over-counted) ----------
// Pulses at full lock are whole drive messages (50 ms apart); forward with the wheel one way and back with it the
// other both turn it the same way, so taking turns it stays about where it is. How far each pulse turns comes from
// the turning test, or the numbers measured on Oct 22 until it has run.
const PK0={2:5.5,3:11,4:20.7,5:29};
const stepsPerDeg=()=>X.pxdeg()*(D.pxScale||1);
const pkDeg=(fwd,n)=>{const a=D.pk&&D.pk[fwd?'f':'b']&&D.pk[fwd?'f':'b'][n];if(a&&a.length){const b=[...a].sort((x,y)=>x-y);return b[b.length>>1]}return PK0[n]==null?null:PK0[n]};
const pkLearn=(fwd,n,deg)=>{if(n<1||n>8||!(deg>0)||deg>60)return;D.pk=D.pk||{};const d=D.pk[fwd?'f':'b']=D.pk[fwd?'f':'b']||{};d[n]=[...(d[n]||[]),Math.round(deg*10)/10].slice(-7)};
const pkFor=(fwd,deg,most=8)=>{let best=null;for(let n=2;n<=most;n++){const d=pkDeg(fwd,n);if(d==null)continue;const e=Math.abs(d-Math.abs(deg));if(!best||e<best.e)best={n,deg:d,e}}return best};
async function pulse(fwd,side,n){const ms=n*50-25;send(fwd?G2:-G2,fwd?side:-side,ms);await pause(ms+60);await halt()}
const parkedTurn=(a,b,guess=0,span=200)=>{if(!a||!b)return null;const m=X.roomShift(a,b,guess,span,0,b.length,.33);return{px:m.px,score:m.score,ok:m.score>=.6&&m.clear>=.05}};
function parkedNear(a,b,guess=0){const m=parkedTurn(a,b,guess);if(!m||m.ok)return m;
 const n=X.roomShift(a,b,guess,Math.round(Math.max(12*stepsPerDeg(),Math.abs(guess))),0,b.length,.33);
 if(n.score>=.55&&n.clear>=.05)return{px:n.px,score:n.score,ok:true};
 const k=stepsPerDeg(),w=Math.round(8*k),sc=[];   // (two look-alike things: of the best peaks near where the move should have left it, the nearest)
 for(let s0=Math.round(guess)-w-1;s0<=Math.round(guess)+w+1;s0++)sc.push([s0,X.roomShift(a,b,s0,0,0,b.length,.33).score]);
 const peaks=sc.filter((p,i)=>i>0&&i<sc.length-1&&p[1]>=sc[i-1][1]&&p[1]>=sc[i+1][1]),top=Math.max(0,...peaks.map(p=>p[1]));
 const pick=peaks.filter(p=>p[1]>=Math.max(.75,top-.05)).sort((x,y)=>Math.abs(x[0]-guess)-Math.abs(y[0]-guess))[0];
 return pick?{px:pick[0],score:pick[1],ok:true}:m}
// parked: waits for it to stop rocking, then five looks; the middle one if three agree within a degree
async function lookParked(ref,guess=0){X.yawStart();try{for(let tries=0;tries<3;tries++){await pause(tries?300:800);const got=[];let seen=0;const t0=Date.now();
  while(got.length<5&&Date.now()-t0<4000){await pause(70);if(stopped())return null;const y=X.yaw;if(y.last&&y.lastAt>seen){seen=y.lastAt;got.push(y.last)}}
  if(!got.length)continue;if(!ref)return{row:got[got.length-1],px:0,score:1};
  const r=got.map(row=>Object.assign({row},parkedNear(ref,row,guess))).filter(x=>x.ok).sort((a,b)=>a.px-b.px);
  if(r.length<3)continue;const k=stepsPerDeg(),mid=r[r.length>>1];if(r.filter(x=>Math.abs(x.px-mid.px)<=k).length>=3)return{row:mid.row,px:mid.px,score:mid.score}}
 return null}finally{X.yawStop()}}
// turns deg degrees (plus right) in parked steps; says how far off it ended, or null if it lost the room
async function turnParked(deg,from=null){let prev=from||await lookParked(null);if(!prev)return null;let done=0,fwd=true,guessed=0;
 for(let i=0;i<40&&!stopped();i++){const left=deg-done;if(Math.abs(left)<Math.max(1.5,(pkDeg(fwd,2)||5)/2))break;
  const side=left>0?1:-1,p=pkFor(fwd,Math.min(Math.abs(left),pkDeg(fwd,4)||20),4);await pulse(fwd,side,p.n);
  let r=await lookParked(prev.row,side*p.deg*stepsPerDeg());
  if(!r&&!stopped()){await pause(1500);r=await lookParked(prev.row,side*p.deg*stepsPerDeg())}
  if(!r){if(guessed>=3||stopped())return null;const still=await lookParked(null);if(!still)return null;guessed++;done+=side*p.deg;prev=still;fwd=!fwd;continue}
  const turned=r.px/stepsPerDeg(),t=side*turned;if(t>.5*p.deg&&t<1.8*p.deg)pkLearn(fwd,p.n,t);fwd=!fwd;done+=turned;prev=r}
 dSave();return{off:Math.round((done-deg)*10)/10,last:prev}}

// ---------- where it is, and going to a spot ----------
// x cm right of where it started, y cm ahead, h degrees right of the way it first faced. Turns are measured parked,
// straight runs come from the speed table in legs of at most 50 cm with the compass holding the heading. A new
// start is taken after 10 minutes, or with Start here.
const pos={x:0,y:0,h:0,at:0};
const posReset=()=>Object.assign(pos,{x:0,y:0,h:0,at:Date.now()});
const wrap=d=>((d%360)+540)%360-180;
const spotFrom=(right,ahead)=>{const r=pos.h*Math.PI/180;return{x:pos.x+right*Math.cos(r)+ahead*Math.sin(r),y:pos.y-right*Math.sin(r)+ahead*Math.cos(r)}};
const legTo=(x,y)=>{const dx=x-pos.x,dy=y-pos.y,cm=Math.hypot(dx,dy);return{turn:cm<1?0:wrap(Math.atan2(dx,dy)*180/Math.PI-pos.h),cm}};
const GO_T=.7;
const speedAt=t=>{const pc=Math.round(Math.abs(t)*100),s=D.spd&&D.spd[t<0?'b':'f'];return s&&s[pc]?s[pc]:X.vOf(t*G2,false)};
const lagAt=t=>{const pc=Math.round(Math.abs(t)*100),s=D.spd&&D.spd.lag&&D.spd.lag[t<0?'b':'f'];return s&&s[pc]!=null?s[pc]:Math.abs(t)>=.95?160:Math.abs(t)>=.65?355:700};
const msFor=(cm,t)=>Math.round(Math.max(150,Math.min(6000,cm/Math.max(10,speedAt(t))*1000+lagAt(t))));
function goRun(label,target,faceAfter){if(Date.now()-pos.at>600000)posReset();
 return start(label,async()=>{const tgt=target();let why='';
  if(!(await camOk()))return say('No picture from the car');
  X.floor=1;
  for(let leg=0;leg<12&&!stopped();leg++){const g=legTo(tgt.x,tgt.y);if(g.cm<8)break;
   if(Math.abs(g.turn)>6){const r=await turnParked(g.turn);if(!r){why='room';break}pos.h=wrap(pos.h+g.turn+r.off);pos.at=Date.now();continue}
   const cm=Math.min(50,g.cm),before=await lookParked(null),ms=msFor(cm,GO_T);
   const res=await drive(GO_T,0,ms,{hold:true,bubble:true,stuck:true,keepFloor:true});await pause(300);if(stopped())break;
   const went=res.blocked!=null?cm*Math.min(1,res.took/ms):cm;
   const after=before?await lookParked(before.row):null,drift=after?after.px/stepsPerDeg():0;
   pos.h=wrap(pos.h+drift/2);const r=pos.h*Math.PI/180;pos.x+=went*Math.sin(r);pos.y+=went*Math.cos(r);pos.h=wrap(pos.h+drift/2);pos.at=Date.now();
   if(res.blocked!=null){why='blocked';break}}
  if(!why&&faceAfter!=null&&!stopped()){const t=wrap(faceAfter-pos.h);if(Math.abs(t)>6){const r=await turnParked(t);if(r)pos.h=wrap(pos.h+t+r.off)}}
  if(stopped())return;const left=legTo(tgt.x,tgt.y).cm;
  say(why==='blocked'?'Something in the way, stopped short':why==='room'?'Lost track of the room, stopped':left>=8?'There, about '+Math.round(left)+' cm short':'There')})}
const goTo=(right,ahead)=>goRun('Going to the spot',()=>spotFrom(right,ahead),null);
function tapGo(cx,cy){const v=$('#view');if(!v)return;const r=v.getBoundingClientRect(),c=typeof cfg!=='undefined'?cfg:{};
 const s=(c.fit==='fill'?Math.max:Math.min)(r.width/1280,r.height/720)*(+c.zoom||1);
 const px=(cx-r.left-r.width/2)/s+640,py=(cy-r.top-r.height/2)/s+360,p=floorFrom(px,py,1280,720);
 if(!p||p.d<8||p.d>300||Math.abs(p.x)>300)return say('Tap twice on the floor, 8 cm to 3 m away');
 say('Going '+Math.round(p.d)+' cm ahead, '+Math.abs(Math.round(p.x))+' cm '+(p.x<0?'left':'right'));goTo(p.x,p.d)}

// ---------- following (Nessari v1.68): a small colour picture (80 x 45) about 8 times a second ----------
const SEEK_R=44;   // (its tightest turn, cm: a circle at full lock)
const seek={mode:null,color:null,side:1,res:null,lastX:null,gap:null};
const colorOf=(r,g,b)=>{const mx=Math.max(r,g,b),mn=Math.min(r,g,b),sat=mx?(mx-mn)/mx:0;
 if(mx<50)return'black';if(sat<.2)return mx>190?'white':'';if(sat<.35||mx<70)return'';
 let h=mx===r?60*(((g-b)/(mx-mn))%6):mx===g?60*((b-r)/(mx-mn)+2):60*((r-g)/(mx-mn)+4);if(h<0)h+=360;
 return h<20||h>=330?'red':h<40?'orange':h<72?'yellow':h<165?'green':h<260?'blue':'purple'};
const laserHit=(c,r,g,b)=>c==='red'?r>170&&r>g*1.5&&r>b*1.5:c==='green'?g>170&&g>r*1.3&&g>b*1.15:b>170&&b>r*1.3&&b>g*1.1;
const steerTo=(x,d)=>{const L2=x*x+d*d;return L2?Math.max(-1,Math.min(1,2*x*SEEK_R/L2)):0};
const steerAt=deg=>Math.max(-1,Math.min(1,deg/20));
function seekLook(d,w,h){const px=(x,y)=>(y*w+x)*3,mode=seek.mode,color=seek.color;
 if(mode==='laser'){let n=0,sx=0,sy=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=px(x,y);if(laserHit(color,d[i],d[i+1],d[i+2])){n++;sx+=x;sy+=y}}
  if(!n||n>w*h*.04)return{found:false};
  const cx=sx/n+.5,cy=sy/n+.5,p=floorFrom(cx,cy,w,h);
  if(p&&p.d<300)return{found:true,s:steerTo(p.x,Math.max(1,p.d)),t:.6,arrived:p.d<15};
  return{found:true,s:steerAt(lensAngle(cx,cy,w,h)),t:.6,arrived:false}}
 if(mode==='bright'||mode==='dark'){const cols=11,Lc=new Array(cols).fill(0),y0=Math.floor(h*.1),y1=Math.floor(h*.85);
  for(let y=y0;y<y1;y++)for(let x=0;x<w;x++){const i=px(x,y);Lc[Math.min(cols-1,Math.floor(x*cols/w))]+=d[i]*.3+d[i+1]*.59+d[i+2]*.11}
  const per=(y1-y0)*w/cols,sm=Lc.map((v,i)=>((i?Lc[i-1]:v)+v*2+(i<cols-1?Lc[i+1]:v))/4/per);
  const ext=mode==='bright'?Math.max(...sm):Math.min(...sm);let best=0,bd=99;
  for(let i=0;i<cols;i++)if(Math.abs(sm[i]-ext)<=3&&Math.abs(i-(cols-1)/2)<bd){bd=Math.abs(i-(cols-1)/2);best=i}
  const all=sm.reduce((a,b)=>a+b,0)/cols;return{found:true,s:steerAt(lensAngle((best+.5)*w/cols,h*.5,w,h)),t:.6,arrived:mode==='dark'?all<22:false}}
 if(mode==='tape'||mode==='between'){const pts=[];
  for(const cm of [15,22,30]){const y=Math.round(floorAt(0,cm,w,h)[1]);if(y<0||y>=h)continue;
   let med=null;if(!color)med=[0,1,2].map(c=>{const v=[];for(let x=0;x<w;x+=2)v.push(d[px(x,y)+c]);v.sort((a,b)=>a-b);return v[v.length>>1]});
   const hit=x=>{const i=px(x,y);return color?colorOf(d[i],d[i+1],d[i+2])===color:Math.abs(d[i]-med[0])+Math.abs(d[i+1]-med[1])+Math.abs(d[i+2]-med[2])>120};
   const runs=[];let a=-1;for(let x=0;x<=w;x++){const on=x<w&&hit(x);if(on&&a<0)a=x;if(!on&&a>=0){if(x-a<=w*.3)runs.push((a+x-1)/2);a=-1}}
   if(!runs.length)continue;const fl=r=>floorFrom(r,y+.5,w,h);let target=null;
   if(mode==='tape'){const want=seek.lastX==null?0:seek.lastX;let be=1e9;for(const r of runs){const p=fl(r);if(p&&Math.abs(p.x-want)<be){be=Math.abs(p.x-want);target=p}}}
   else{const ps=runs.map(fl).filter(Boolean),Lp=ps.filter(p=>p.x<0).sort((p,q)=>q.x-p.x)[0],Rp=ps.filter(p=>p.x>=0).sort((p,q)=>p.x-q.x)[0];
    if(Lp&&Rp){seek.gap=Rp.x-Lp.x;target={x:(Lp.x+Rp.x)/2,d:(Lp.d+Rp.d)/2}}
    else if(Lp||Rp){const g=seek.gap||30,p=Lp||Rp;target={x:p.x+(Lp?g/2:-g/2),d:p.d}}}
   if(target)pts.push(target)}
  if(!pts.length)return{found:false};const far=pts[pts.length-1];if(mode==='tape')seek.lastX=far.x*.7;
  return{found:true,s:steerTo(far.x,far.d),t:.55,arrived:false}}
 return{found:false}}
// along a wall: keeps the wall's half of the picture busier than the other by about a third
const wallSteer=(l,r,side)=>{const near=side>0?r:l,far=side>0?l:r,sum=near+far;if(sum<2*X.STILL)return side*.25;return Math.max(-.6,Math.min(.6,side*-1.5*((near-far)/sum-.33)))};
const SEEK_NAME={laser:'Following the dot',tape:'Following the tape',between:'Between the lines',bright:'Finding the light',dark:'Finding a dark spot',wall:'Following the wall'};
function seekRun(mode,color=null,side=1,secs=60){Object.assign(seek,{mode,color,side,res:null,lastX:null});
 return start(SEEK_NAME[mode],async()=>{if(!(await camOk()))return say('No picture from the car');
  const t0=Date.now();let lostSince=0,why='';
  if(mode!=='wall')X.seek=lookAll;if(mode!=='tape'&&mode!=='between')X.floor=1;
  while(!stopped()&&Date.now()-t0<secs*1000){let r;
   if(mode==='wall')r={found:true,s:wallSteer(X.cam.left,X.cam.right,side),t:.6};else r=seek.res&&Date.now()-seek.res.at<700?seek.res:null;
   const carLaps=race.on&&race.who==='car'&&mode==='between';if(carLaps&&race.n>=race.want){why='laps';break}
   if(!r||!r.found){if(carLaps&&!lostSince)race.lost++;await halt();lostSince=lostSince||Date.now();if(Date.now()-lostSince>(mode==='laser'?20000:3000)){why='lost';break}await pause(150);continue}
   lostSince=0;
   if(r.arrived){await halt();if(mode==='laser'){await pause(200);continue}why='there';break}
   let t=carLaps?raceRec().t:r.t;
   if(mode==='tape'||mode==='between'){if(X.wallAhead())t=0}
   else{const cm=X.clearAhead(Date.now());if(cm<X.handStop(X.vOf(t*G2,false))+3)t=0}
   if(t<=0){await halt();if(mode==='wall'){await drive(.6,-side,800);continue}if(mode==='laser'){await pause(200);continue}why=mode==='bright'||mode==='dark'?'there':'blocked';break}
   if(X.A.corner&&Math.abs(r.s)>=.8)t=Math.min(t,.75);
   send(t*G2,r.s,400);await pause(150)}
  if(stopped())return;
  if(race.on&&race.who==='car'){race.who='you';say(race.n+' laps done. '+raceWords())}
  else say(why==='lost'?'Lost it':why==='blocked'?'Something in the way, stopped':why==='there'?'Got there':'Done')})}

// ---------- race mode (Nessari v1.68): a strip of tape across the track is the start line ----------
// Each crossing (3 s or more after the last) ends a lap: yours when you drive, the car's when it drives between the
// lines ("Car's laps"). A clean lap and the car goes 5% faster next time, a lap where it lost the lines and it backs
// off 10%. Best times are kept.
const race={on:false,who:'you',last:0,n:0,want:3,lost:0};
const raceRec=()=>(D.race=D.race||{t:.55,best:{you:null,car:null}});
// (the floor's colour is taken from the row 30 cm ahead: a line across the whole row would be its own median, which
//  is how Nessari's version misses a wide start line)
function startLine(d,w,h){const yr=Math.round(floorAt(0,30,w,h)[1]);if(yr<0||yr>=h)return false;const ir=yr*w*3;
 const med=[0,1,2].map(c=>{const v=[];for(let x=0;x<w;x+=2)v.push(d[ir+x*3+c]);v.sort((a,b)=>a-b);return v[v.length>>1]});
 for(const cm of [14,18]){const y=Math.round(floorAt(0,cm,w,h)[1]);if(y<0||y>=h)continue;
  const x0=Math.floor(w*.15),x1=Math.ceil(w*.85),i0=y*w*3;let n=0;
  for(let x=x0;x<x1;x++){const i=i0+x*3;if(Math.abs(d[i]-med[0])+Math.abs(d[i+1]-med[1])+Math.abs(d[i+2]-med[2])>120)n++}
  if(n>(x1-x0)*.5)return true}
 return false}
function raceCross(now){if(now-race.last<3000)return;const was=race.last;race.last=now;
 if(!was){say(race.who==='car'?'Go!':'Clock running');return}
 const s=Math.round((now-was)/100)/10,rec=raceRec(),who=race.who,best=rec.best[who]==null||s<rec.best[who];race.n++;if(best)rec.best[who]=s;
 if(who==='car'){rec.t=Math.round(Math.max(.45,Math.min(1,race.lost<3?rec.t+.05:rec.t-.1))*100)/100;race.lost=0}
 dSave();const other=rec.best[who==='car'?'you':'car'];
 say((who==='car'?'Car':'Your')+' lap '+race.n+': '+s+' s'+(best?' (best'+(other!=null?s<other?', beats '+(who==='car'?'yours':'the car'):'':'')+')':''));
 try{X.buzz(80,.4)}catch(e){}}
const raceWords=()=>{const b=raceRec().best;return'Your best '+(b.you==null?'–':b.you+' s')+', car '+(b.car==null?'–':b.car+' s')};
function raceLook(d,w,h,now){if(race.on&&startLine(d,w,h))raceCross(now)}
function lookAll(d,w,h,now){if(run&&seek.mode&&seek.mode!=='wall')seek.res=Object.assign(seekLook(d,w,h),{at:now});raceLook(d,w,h,now)}
function raceSet(on){race.on=on;race.who='you';race.last=0;race.n=0;race.lost=0;if(!run)X.seek=on?raceLook:null;say(on?'Race mode on: cross the start line to start the clock':'Race mode off');paint()}
function carLaps(n=3){race.on=true;race.who='car';race.want=n;race.last=0;race.n=0;race.lost=0;paint();return seekRun('between',null,1,30+n*60)}

// ---------- explore (Nessari v1.17-v1.45, without place memory): drives itself by its camera ----------
// A little faster when the next foot of floor is clear, veers from something close on one side, backs off and turns
// before a wall or something on the floor, and when a bump stops the picture it tries harder and harder to get free.
const veer=(l,r,was)=>{const sum=l+r,want=sum<2*X.STILL||Math.abs(r-l)/sum<.25||Math.min(l,r)>4*X.STILL?0:-1.4*(r-l)/sum;return Math.max(-1,Math.min(1,was*.5+want*.5))};
const pick=a=>a[Math.floor(Math.random()*a.length)];
function explore(secs=60){return start('Exploring',async()=>{if(!(await camOk()))return say('No picture from the car');
 X.floor=1;const end=Date.now()+secs*1000;let bumps=0;
 const step=async(t,s,ms)=>{const t0=Date.now();let peak=0;while(Date.now()-t0<ms&&!stopped()){send(t*G2,s,300);await pause(150);if(Date.now()-t0>400)peak=Math.max(peak,X.cam.motion)}await halt();return peak};
 while(Date.now()<end&&!stopped()){
  if(Date.now()-X.cam.at>1500){await halt();await pause(500);if(Date.now()-X.cam.at>5000)break;continue}
  const s=(Math.random()-.5)*.7,legEnd=Date.now()+1500+Math.random()*2500,t0=Date.now();let still=0,hit=false,vr=0;
  while(Date.now()<legEnd&&!stopped()){const now=Date.now(),clear=X.flo.learned>=20&&!X.flo.blocked&&!X.flo.dim;
   let t=clear?.8:.6;const steer=Math.max(-1,Math.min(1,s+vr));if(X.clearAhead(now)<X.handStop(X.vOf(t*G2,false))+3)t=0;if(X.A.corner&&Math.abs(steer)>=.8)t=Math.min(t,.75);
   send(t*G2,steer,300);await pause(150);
   if(now-t0>700){vr=veer(X.cam.left,X.cam.right,vr);
    if(X.wallAhead()||X.flo.blocked||t===0){await step(-.6,0,400);await step(.6,pick([-1,1]),700);break}}
   if(now-t0<700)continue;
   if(X.cam.motion<X.STILL){still=still||now;if(now-still>800){hit=true;break}}else still=0}
  if(stopped())break;
  if(hit){bumps++;const away=pick([-1,1]);let free=false;
   for(const [t,st,ms] of [[-.6,away,800],[-1,-away,900],[1,away,700],[-1,away,500],[-1,-away,500],[1,-away,600]]){if(stopped())break;if(await step(t,st,ms)>=X.STILL*1.5){free=true;break}}
   if(stopped())break;if(!free){say('Stuck: back it out by hand');break}await step(.6,-away,700)}
  else if(Math.random()<.35)await step(.5,pick([-1,1]),500+Math.random()*600)}
 if(!stopped())say('Done exploring: '+(bumps?bumps+' bump'+(bumps>1?'s':''):'no bumps'))})}

// ---------- set-up tests (once, kept on this phone) ----------
// Turning test: the same 4-message pulse at full lock again and again, forward and back by turns, parked and looked
// at after each, until the view matches the first one. Then the steps add up to exactly 360 degrees, which sets the
// compass scale and how far each pulse turns. Then 2, 3 and 5-message pulses, each looked at.
async function circleBySteps(start0,step,most=60){const views=[start0],tot=[0];let cand=null;const full=360*X.pxdeg();
 for(let i=1;i<=most&&!stopped();i++){const r=await step(i);if(!r)return null;views.push(r.row);tot.push(tot[i-1]+r.px);
  if(cand){const d=parkedTurn(views[1],r.row,0,120),circ=d&&d.ok?tot[i]-tot[1]-d.px:null;if(circ!=null&&Math.abs(circ-cand.px)<3*stepsPerDeg())return{steps:i-1,px:(circ+cand.px)/2,tot};cand=null}
  if(Math.abs(tot[i])>2.5*full)return null;
  if(Math.abs(tot[i])>.4*full){const c=parkedTurn(start0,r.row,0,120),circ=c&&c.ok?tot[i]-c.px:null;if(circ!=null&&Math.abs(circ)>.5*full&&Math.abs(circ)<2*full)cand={px:circ}}}
 return null}
function turnTest(){return start('Turning test',async()=>{if(!(await camOk()))return say('No picture from the car');
 const first=await lookParked(null);if(!first)return say('Can’t read the room here: try somewhere with things around, 60 cm clear');
 let prev=first,fwd=true;const steps=[];
 const res=await circleBySteps(first,async()=>{const f=fwd;await pulse(f,1,4);fwd=!fwd;
  const r=await lookParked(prev.row,pkDeg(f,4)*stepsPerDeg());if(!r)return null;prev=r;steps.push({f,px:r.px});return r});
 if(stopped())return;
 if(!res)return say('Lost the room partway: try again somewhere with more to see');
 const scale=res.px/(360*X.pxdeg());if(scale>.5&&scale<2)D.pxScale=Math.round(scale*1000)/1000;
 for(const s of steps.slice(0,res.steps))pkLearn(s.f,4,s.px/stepsPerDeg());
 for(const n of [2,3,5])for(let k=0;k<4&&!stopped();k++){const f=k%2===0,before=await lookParked(null);if(!before)break;await pulse(f,k<2?1:-1,n);
  const r=await lookParked(before.row,(k<2?1:-1)*pkDeg(f,n)*stepsPerDeg());if(r)pkLearn(f,n,Math.abs(r.px)/stepsPerDeg())}
 dSave();say('Turning test done: '+res.steps+' steps a circle, a 4-message pulse turns about '+Math.round(pkDeg(true,4))+'°')})}
// Speed test on the tiles (Nessari v1.37-v1.44): the line where one tile meets the next shows as a sharp change from
// one row to the next, and its row says how far off it is. Parked looks before and after runs of one and two tiles,
// forward and back, at 50, 70 and 100% of speed 2, give cm a second and how long it takes to get going.
const TILE=30.5;
function floorLines(d,w,h){const yh=X.FL.yh*h,k3=X.FL.k*h,rowAt=cm=>yh+k3/cm,x0=Math.floor(w*.42),x1=Math.ceil(w*.58);
 const Lp=(x,y)=>d[y*w+x],row=y=>{let s=0;for(let x=x0;x<x1;x++)s+=Lp(x,y);return s/(x1-x0)};
 const top=Math.ceil(rowAt(90)),k=Math.max(1,Math.round(h/180)),g=new Float32Array(h),m=new Float32Array(h);
 for(let y=top;y<h;y++)m[y]=row(y);
 for(let y=top+k;y<h-k;y++){let s=0;for(let x=x0;x<x1;x++)s+=Math.abs(Lp(x,y+k)-Lp(x,y-k));g[y]=s/(x1-x0)}
 const v=[...g.slice(top+k,h-k)].sort((a,b)=>a-b),med=v[v.length>>1]||0,out=[],r=3*k;
 for(let y=h-1-k-2*r;y>top+k+r;y--){if(g[y]<Math.max(8,med*3))continue;let peak=true;for(let j=-r;j<=r;j++)if(g[y+j]>g[y]){peak=false;break}if(!peak)continue;
  let near=0,far=0;for(let j=r;j<3*r;j++){near+=m[Math.min(h-1,y+j)];far+=m[y-j]}
  const cm=k3/(y-yh);if(cm>=6&&cm<=60)out.push({cm:Math.round(cm*10)/10,light:near>far});y-=r}
 return out}
function linesNow(){try{if(!CarApp.grab(X.YW,X.YH))return null;const b=CarApp.rows(0,X.YH,1,false);if(!b)return null;return floorLines(X.unb64(b,'tiles'),X.YW,X.YH)}catch(e){return null}}
async function tileSpot(){await pause(700);const got=[];for(let i=0;i<3;i++){const r=linesNow();if(r&&r.length)got.push(r[0]);await pause(120)}
 for(const a of got){const agree=got.filter(b=>Math.abs(b.cm-a.cm)<=2&&b.light===a.light);if(agree.length>=2)return{cm:agree.reduce((s,b)=>s+b.cm,0)/agree.length,light:a.light}}
 return null}
const tileMoved=(a,b,guess)=>{let m=a.cm-b.cm+(a.light===b.light?0:TILE);m-=Math.round((m-guess)/(2*TILE))*2*TILE;return Math.round(m*10)/10};
function fitRuns(runs){const ok=runs.filter(p=>p.cm>0&&p.ms>0);if(!ok.length)return null;
 if(ok.length===1||new Set(ok.map(p=>Math.round(p.ms/50))).size===1){const p=ok[0];return{v:Math.round(p.cm/Math.max(100,p.ms-150)*1000),lag:150}}
 const n=ok.length,mx=ok.reduce((s,p)=>s+p.ms,0)/n,my=ok.reduce((s,p)=>s+p.cm,0)/n,sl=ok.reduce((s,p)=>s+(p.ms-mx)*(p.cm-my),0)/ok.reduce((s,p)=>s+(p.ms-mx)**2,0);
 if(!(sl>0))return null;return{v:Math.round(sl*1000),lag:Math.round(Math.max(0,Math.min(800,mx-my/sl)))}}
function speedTest(){return start('Speed test',async()=>{if(!(await camOk()))return say('No picture from the car');
 let at=await tileSpot();if(!at)return say('Can’t see the tile lines: point it straight along the tiles with a metre clear');
 const out=[];
 for(const t of [.5,.7,1]){const pc=Math.round(t*100),f=[],b=[];
  for(const n of [1,2])for(const dir of [1,-1]){if(stopped())return;
   const est=fitRuns(dir>0?f:b),want=n*TILE,ms=est?Math.round(Math.max(150,Math.min(6000,want/est.v*1000+est.lag))):msFor(want,t*dir);
   const res=await drive(t*dir,0,ms,{hold:true});const v0=est?est.v:speedAt(t*dir),guess=Math.max(0,res.took-(est?est.lag:lagAt(t)))*v0/1000;
   const now=await tileSpot();if(stopped())return;if(!now){at=await tileSpot();if(!at)return say('Lost the tile lines');continue}
   const moved=tileMoved(at,now,dir*guess);(dir>0?f:b).push({ms:res.took,cm:moved*dir>0?Math.abs(moved):0});at=now}
  const ff=fitRuns(f),bb=fitRuns(b);D.spd=D.spd||{f:{},b:{},lag:{f:{},b:{}}};
  if(ff){D.spd.f[pc]=ff.v;D.spd.lag.f[pc]=ff.lag;out.push(pc+'%: '+ff.v+' cm/s')}if(bb){D.spd.b[pc]=bb.v;D.spd.lag.b[pc]=bb.lag}dSave()}
 say(out.length?'Speed test done: '+out.join(', '):'Speed test: nothing measured')})}

// ---------- the panel (M button) ----------
const css=document.createElement('style');
css.textContent='#mpanel{position:fixed;inset:0;background:var(--bg);z-index:8;display:none;flex-direction:column;touch-action:pan-y}#mpanel.on{display:flex}'+
 '#mpbody{overflow-y:auto;padding:0 16px 24px;width:100%;max-width:640px;margin:0 auto}#mpbody h3{margin:16px 0 8px;font-size:14px;color:var(--text);font-family:var(--display)}'+
 '.mgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.mgrid .pill{justify-content:center;width:100%}.mgrid .pill.on{background:var(--acc);border-color:var(--acc);color:var(--acc-ink)}'+
 '#mpill{position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:7;display:none;padding:8px 14px;border-radius:20px;border:1px solid var(--acc);background:var(--bg);color:var(--text);font:600 13px var(--display)}#mpill.on{display:block}';
document.head.appendChild(css);
const info=t=>'<p class=info>'+t+'</p>',btn=(id,t)=>'<button class=pill id='+id+'>'+t+'</button>';
document.body.insertAdjacentHTML('beforeend','<div id=mpanel><div class=bar><h2>Modes</h2><button class=ib id=mpx title=Close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div><div id=mpbody>'+
 '<h3>Go</h3>'+info('Tap the floor twice in the picture and it drives there. It keeps track of where it started: Come back drives there and faces the way it first did.')+
 '<div class=mgrid>'+btn('m_home','Come back')+btn('m_turn','Turn around')+btn('m_here','Start here')+'</div>'+
 '<h3>Race</h3>'+info('Lay a strip of tape across the track as the start line. Race mode times your laps; Car’s laps drives 3 laps between two lines of tape and learns to go faster.')+
 '<div class=mgrid>'+btn('m_race','Race mode')+btn('m_carlaps','Car’s laps')+'</div><p class=info id=m_best></p>'+
 '<h3>Follow</h3>'+info('Laser: shine the dot on the floor in front of it. Tape: a line on the floor. Wall: about a hand’s width off it.')+
 '<div class=mgrid>'+btn('m_laser','Laser dot')+btn('m_tape','Tape line')+btn('m_between','Between lines')+btn('m_walll','Wall on left')+btn('m_wallr','Wall on right')+btn('m_light','Find the light')+btn('m_dark','Find the dark')+'</div>'+
 '<div class=row style="margin-top:8px"><label>Laser colour</label><div class=seg id=m_lc><button data-v=red>Red</button><button data-v=green>Green</button><button data-v=blue>Blue</button></div></div>'+
 '<h3>Explore</h3>'+info('It drives itself for a minute by its camera.')+'<div class=mgrid>'+btn('m_explore','Explore')+'</div>'+
 '<h3>Set-up tests</h3>'+info('Once each, kept on this phone. Turning test: about 60 cm clear all round, with things to see. Speed test: point it along the floor tiles with a metre clear in front. Both make Go more accurate.')+
 '<div class=mgrid>'+btn('m_tt','Turning test')+btn('m_st','Speed test')+'</div><p class=info id=m_learned></p>'+
 '</div></div>');
function paint(){const b=$('#m_race');if(b)b.classList.toggle('on',race.on);const m=$('#m_best');if(m)m.textContent=raceWords()+'. Car drives at '+Math.round(raceRec().t*100)+'%.';
 const l=$('#m_learned');if(l)l.textContent=(D.pxScale?'Turning learned (scale '+D.pxScale+'). ':'Turning: not measured yet. ')+(D.spd&&D.spd.f&&D.spd.f[100]?'Speed learned: full '+D.spd.f[100]+' cm/s.':'Speed: not measured yet.');
 const lc=D.lc||'red';document.querySelectorAll('#m_lc button').forEach(x=>x.classList.toggle('sel',x.dataset.v===lc))}
function open(){paint();$('#mpanel').classList.add('on')}
function closePanel(){const p=$('#mpanel');if(p)p.classList.remove('on')}
$('#mpx').onclick=closePanel;
$('#m_home').onclick=()=>goRun('Coming back',()=>({x:0,y:0}),0);
$('#m_turn').onclick=()=>start('Turning around',async()=>{if(!(await camOk()))return say('No picture from the car');const r=await turnParked(180);if(r){pos.h=wrap(pos.h+180+r.off);pos.at=Date.now()}else if(!stopped())say('Lost the room turning')});
$('#m_here').onclick=()=>{posReset();say('This is the start now');closePanel()};
$('#m_race').onclick=()=>raceSet(!race.on);
$('#m_carlaps').onclick=()=>carLaps(3);
$('#m_laser').onclick=()=>seekRun('laser',D.lc||'red');
$('#m_tape').onclick=()=>seekRun('tape');
$('#m_between').onclick=()=>seekRun('between');
$('#m_walll').onclick=()=>seekRun('wall',null,-1);
$('#m_wallr').onclick=()=>seekRun('wall',null,1);
$('#m_light').onclick=()=>seekRun('bright');
$('#m_dark').onclick=()=>seekRun('dark');
$('#m_explore').onclick=()=>explore(60);
$('#m_tt').onclick=()=>turnTest();
$('#m_st').onclick=()=>speedTest();
document.querySelectorAll('#m_lc button').forEach(x=>x.onclick=()=>{D.lc=x.dataset.v;dSave();paint()});
posReset();
window.CarModes={open,tapGo,_t:{floorFrom,floorAt,seekLook,seek,startLine,floorLines,tileMoved,fitRuns,parkedNear,legTo,spotFrom,pos,wrap}};
})();
