// Android app only. LocalServer adds this after the shared screen (page.html), so the Termux version and the
// Chrome page stay exactly as they are. It runs after the page's own script and uses its names (cfg, touch, orbit...).
// Adds: tap-anywhere driving, a rebuilt one-thumb stick, a reverse speed limit with a gentle start, drift mode,
// a floor ruler over the picture, kick start, and driving helpers: stuck stop, corner limit, side nudge, speed
// bubble, straight hold and auto trim (all from Nessari's drive screen, Oct 22).
(()=>{
const AD={tap:1,win:20,rev:.5,soft:1,dlow:.2,dfull:.7,dmax:1,dgain:1.4,dsnap:150,dflick:1,urate:20,crate:20,ruler:1,kick:1,stuck:1,corner:0,nudge:0,bubble:1,hold:0,autotrim:1,tapgo:1,v:2};
let A={...AD};try{const was=JSON.parse(localStorage.carapp||'{}');
 // (v 2, Oct 22, as Nessari v1.70: corner limit and side nudge start off, once, on a phone that remembered them on)
 if(was.v!==2)for(const k of ['corner','nudge','v'])delete was[k];Object.assign(A,was)}catch(e){}
A.drift=0;   // drift mode is off every time the app opens
const aSave=()=>{try{const k={...A};delete k.drift;localStorage.carapp=JSON.stringify(k)}catch(e){}};
const clamp=v=>Math.max(-1,Math.min(1,v));
// shared with modes.js (loaded only when a mode is first used): busy while a mode drives the car; floor / seek ask
// the look loop for the floor check or a small colour picture
const X=window.CarX={busy:0,floor:0,seek:null,cancel:null};

// ---------- looks ----------
const st=document.createElement('style');
st.textContent='#modesb{font:700 13px var(--display);color:var(--text)}body.tapany .slot{pointer-events:none}body.tapany #thr{left:8px}body.tapany #str{right:8px}body.tapany #joy.L{left:8px}body.tapany #joy.R{right:8px}'+
 '.tring{position:fixed;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:2px solid var(--acc);background:rgba(191,64,191,.15);pointer-events:none;z-index:5}'+
 '#drift{font:700 13px var(--display);color:var(--text)}#drift.on{color:var(--acc-ink)}';
document.head.appendChild(st);

// ---------- one-thumb stick: a wide straight zone, then steering that builds slowly and is full at 90 degrees ----------
// angle 0 = straight up (or down); inside the straight zone there is no steering at all.
// past it, steering grows on a curve (gentle first) and reaches full lock when the thumb points straight sideways.
// throttle is how far you push, easing off past 45 degrees so a pure sideways push only turns the wheels.
function joyMap(x,y){let m=Math.hypot(x,y);if(m<.08)return{t:0,s:0};if(m>1){x/=m;y/=m;m=1}
 const a=Math.atan2(Math.abs(x),Math.abs(y))*180/Math.PI,W=A.win;
 const f=a<=W?0:Math.pow((a-W)/(90-W),1.7);
 const t=(y<0?-1:1)*m*Math.min(1,Math.cos(a*Math.PI/180)/Math.cos(Math.PI/4));
 return{t:+t.toFixed(3),s:+((x<0?-1:1)*f*Math.min(1,m*1.4)).toFixed(3)}}
// the stick on screen (used when tap anywhere is off)
let jDown=false;
function jread2(e){const r=J.getBoundingClientRect(),R=jrad();const o=joyMap((e.clientX-r.left-r.width/2)/R,-(e.clientY-r.top-r.height/2)/R);touch.t=o.t;touch.s=o.s}
J.onpointerdown=e=>{J.setPointerCapture(e.pointerId);jDown=true;jread2(e);if(orbit)setOrbit(0)};
J.onpointermove=e=>{if(jDown)jread2(e)};
J.onpointerup=J.onpointercancel=()=>{jDown=false;touch.t=touch.s=null};

// ---------- tap anywhere: the spot you press is the centre ----------
// Two thumbs: left half is throttle (up / down), right half is steering (left / right). The distance for full
// is half the length of the slider on screen, so the Size setting still sets it.
// Stick L / Stick R: anywhere on that half is the stick, as big as the stick on screen.
const EXCL='button,input,.ib,#gears,#side,#sheet,#scrim,#gal,#viewer,#padt,#tmode,#off,#tpill,#mpanel,#mpill';
const ptrs=new Map();
document.addEventListener('pointerdown',e=>{if(!A.tap||e.target.closest(EXCL))return;
 const left=e.clientX<innerWidth/2;let role=null;
 if(cfg.style==='sliders')role=left?'t':'s';else if(left===(cfg.style==='joyL'))role='j';
 if(!role)return;for(const p of ptrs.values())if(p.role===role)return;   // one thumb per control
 const ring=document.createElement('div');ring.className='tring';ring.style.left=e.clientX+'px';ring.style.top=e.clientY+'px';document.body.appendChild(ring);
 ptrs.set(e.pointerId,{role,x0:e.clientX,y0:e.clientY,ring});if(orbit)setOrbit(0);pmove(e)});
function pmove(e){const p=ptrs.get(e.pointerId);if(!p)return;const dx=e.clientX-p.x0,dy=e.clientY-p.y0;
 if(p.role==='t'){const el=$('#thr');touch.t=clamp(-dy/Math.max(20,(el.clientHeight-T.k.offsetWidth)/2))}
 else if(p.role==='s'){const el=$('#str');touch.s=clamp(dx/Math.max(20,(el.clientWidth-S.k.offsetWidth)/2))}
 else{const R=Math.max(20,jrad()),o=joyMap(dx/R,-dy/R);touch.t=o.t;touch.s=o.s}}
function pup(e){const p=ptrs.get(e.pointerId);if(!p)return;ptrs.delete(e.pointerId);p.ring.remove();
 if(p.role!=='s')touch.t=null;if(p.role!=='t')touch.s=null}
addEventListener('pointermove',pmove);addEventListener('pointerup',pup);addEventListener('pointercancel',pup);

// ---------- reverse limit and drift mode, applied to every drive message the screen sends ----------
// Reverse: this car reverses faster than it goes forward, so reverse is scaled down (Reverse speed), and with
// Gentle start it begins at about a third of that and builds to it over 1.2 s.
// Drift: throttle is either light or full (Drift full power, which can be lowered so slick tyres don't just spin),
// and steering is stronger and not reduced at speed. Two helpers for turn-in, both settings:
//  snap: a sudden turn goes to full lock for a moment (Drift steering snap, ms), so the nose comes round fast;
//  flick: reaching full lock with full throttle cuts the throttle for one message (0.1 s), like a lift-off flick.
const KICK=120;let rollDir=0,rollUntil=0,kickUntil=0;
let drives=0,revAt=0,prevS=0,snapUntil=0,snapDir=0,flickUntil=0,flicked=0;
// ---------- driving helpers (from Nessari v1.66), each with its own switch ----------
// The app hands the page a tiny grey copy of the picture (32 x 18) 8 times a second, only while the car is driven.
// From it: how much the picture changed since the last look, in the left and right halves (of 255).
//  stuck stop: pushing throttle but the picture hasn't moved for a second: stop pushing that way until the stick is
//    let go or turned the other way (saves the motor and battery against a wall).
//  corner limit: at full lock going forward, ease off to 75% of the gear so it doesn't slide wide.
//  side nudge: going straight forward, if one side is sweeping past much faster (something close there), steer a
//    little away from it.
const STILL=2.5,CORNER=.75;
const cam={motion:99,left:0,right:0,at:0,prev:null,detail:99,detailAvg:null};
const ast={dir:0,since:0,stuckSince:0,stuckDir:0,veer:0};
let lastDrive=0;
setInterval(()=>{if(!window.CarApp||(Date.now()-lastDrive>600&&!X.busy)){cam.prev=null;return}
 let b='';try{b=CarApp.look(32,18)}catch(e){}
 if(!b){cam.prev=null;return}
 const r=atob(b),g=new Uint8Array(r.length);for(let i=0;i<r.length;i++)g[i]=r.charCodeAt(i);
 if(cam.prev&&cam.prev.length===g.length){let sum=0,l=0,rr=0;for(let i=0;i<g.length;i++){const d=Math.abs(g[i]-cam.prev[i]);sum+=d;if(i%32<16)l+=d;else rr+=d}
  cam.motion=sum/g.length;cam.left=l/(g.length/2);cam.right=rr/(g.length/2);cam.at=Date.now()}
 if(g.length===576){let m=0,mm=0;for(let y=0;y<9;y++)for(let x=8;x<24;x++){const v=g[y*32+x];m+=v;mm+=v*v}
  m/=144;cam.detail=Math.sqrt(Math.max(0,mm/144-m*m));cam.detailAvg=cam.detailAvg==null?cam.detail:cam.detailAvg*.9+cam.detail*.1}
 cam.prev=g;bigLook(Date.now())},125);
function helpers(t,s,g,now){const dir=t>0?1:t<0?-1:0;
 if(dir!==ast.dir){if(ast.dir)autoTrim();ast.dir=dir;ast.since=now;ast.stuckSince=0;ast.veer=0;holdOff()}
 if(dir)rollingAt=now;
 if(ast.stuckDir){if(dir===ast.stuckDir)return{t:0,s};ast.stuckDir=0}
 if(A.stuck&&dir&&now-ast.since>1200&&now-cam.at<400){
  if(cam.motion<STILL){ast.stuckSince=ast.stuckSince||now;
   if(now-ast.stuckSince>1000){ast.stuckDir=dir;ast.stuckSince=0;toast('Stuck: let go of the throttle or go the other way');try{buzz(200,.6)}catch(e){}return{t:0,s}}}
  else ast.stuckSince=0}
 if(A.corner&&t>CORNER*g&&Math.abs(s)>=.75)t=CORNER*g;
 if(A.nudge&&t>.3*g&&Math.abs(s)<.15&&now-ast.since>700&&now-cam.at<400){const l=cam.left,r=cam.right,sum=l+r;
  // (a wall or box close in front fills both halves: then which half is busier is chance, and it used to steer
  //  into the wall. Nothing then; the speed bubble and stuck stop deal with what's ahead)
  const want=sum<2*STILL||Math.abs(r-l)/sum<.25||Math.min(l,r)>4*STILL?0:-1.4*(r-l)/sum;ast.veer=clamp(ast.veer*.5+want*.5);const v=ast.veer*.5;if(Math.abs(v)>.1)s=clamp(s+v)}
 else ast.veer=0;
 s=hold(t,s,dir,now);
 return{t,s}}
// ---------- speed bubble, straight hold and auto trim (from Nessari v1.64-v1.70) ----------
// While one of them needs it, the app also hands over a bigger copy of the picture (320 x 180, once per look):
//  the floor just ahead (160 x 90 in colour, its lower part) for the speed bubble, and the room above the floor
//  (grey, full width) for the room compass that straight hold steers by. Nothing is read when they're off.
const bigBuf={};
const unb64=(b,key)=>{const r=atob(b),n=r.length;let a=bigBuf[key];if(!a||a.length!==n)a=bigBuf[key]=new Uint8Array(n);for(let i=0;i<n;i++)a[i]=r.charCodeAt(i);return a};
// speed bubble (hand driving, Nessari v1.70): it never slows you. It brakes with a short burst of reverse only when
// something it's sure of is inside the distance the car needs to stop from the speed it's going, and it won't go
// forward with the nose within 2 cm of it. Sure means seen on the floor in two looks running within 40 cm, or a
// wall suddenly filling the picture. No fresh look, the floor not learned yet (the first few seconds of driving),
// or far too dark to judge: your speed is left alone.
const FL={yh:.483,k:3.214,nose:4.5,w:160,h:90};   // (horizon 48% down; the floor's distance per row, from the tape photos, Oct 22)
const rowAt=cm=>FL.yh*FL.h+FL.k*FL.h/cm,FY0=Math.ceil(rowAt(40)),FYL=Math.floor(rowAt(15));   // (the next 40 cm; the strip under the nose it learns the floor from)
const flo={pal:new Map(),ok:null,learned:0,ring:[],lum:0,hits:0,at:0,cm:0,blocked:false,dim:false};
const RING=20,LATE=3000,GAP=180;   // (a look is learned from 3 s late, so a sock it's heading for doesn't become floor on the way in)
const fbin=(d,i)=>((d[i]>>4)<<8)|((d[i+1]>>4)<<4)|(d[i+2]>>4);
const glow=(d,i)=>d[i+2]>d[i]+30&&d[i+2]>d[i+1]+20;   // (the car's own blue lights on the floor: neither floor nor something on it)
const lum=(d,i)=>d[i]*.3+d[i+1]*.59+d[i+2]*.11;
function floorOk(){if(flo.ok)return flo.ok;let tot=0;for(const v of flo.pal.values())tot+=v;const ok=new Set();
 for(const [k,c] of flo.pal)if(c>tot*.001)for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++)for(let e=-1;e<=1;e++)ok.add(k+(a<<8)+(b<<4)+e);
 return flo.ok=ok}
// d: colour rows y0 to the bottom of the 160 x 90 picture
function floorLearn(d,y0,careful){const w=FL.w,h=FL.h;let tot=0;for(const v of flo.pal.values())tot+=v;
 const ok=careful&&tot?floorOk():null,x0=Math.floor(w*.3),x1=Math.ceil(w*.7);
 if(tot>200000)for(const [k,c] of flo.pal){if(c<4)flo.pal.delete(k);else flo.pal.set(k,c>>1)}
 let L=0,m=0;
 for(let y=FYL;y<h;y++){const r=(y-y0)*w*3;
  if(ok){let rb=0,rn=0;for(let x=x0;x<x1;x++){const i=r+x*3;if(glow(d,i))continue;rn++;if(!ok.has(fbin(d,i)))rb++}if(rn&&rb/rn>.3)continue}
  for(let x=0;x<w;x++){const i=r+x*3;if(glow(d,i))continue;const k=fbin(d,i);flo.pal.set(k,(flo.pal.get(k)||0)+1);L+=lum(d,i);m++}}
 flo.ok=null;return m?L/m:0}
// how much of the middle of the next 40 cm looks like floor, how many rows are mostly something else, how far the nearest is
function floorCheck(d){const w=FL.w,h=FL.h,ok=floorOk(),x0=Math.floor(w*.3),x1=Math.ceil(w*.7);let n=0,bad=0,rows=0,near=0,L=0;
 if(ok.size)for(let y=FY0;y<h;y++){const r=(y-FY0)*w*3;let rb=0,rn=0;
  for(let x=x0;x<x1;x++){const i=r+x*3;if(glow(d,i))continue;rn++;L+=lum(d,i);if(!ok.has(fbin(d,i)))rb++}
  n+=rn;bad+=rb;if(rn>=(x1-x0)*.25&&rb/rn>.3){rows++;near=y}}
 return{pct:n?Math.round(100*(1-bad/n)):0,rows,cm:near?Math.round(FL.k*h/(near-FL.yh*h)):0,lum:n?Math.round(L/n):0}}
const learnLook=e=>{const L=floorLearn(e.d,FYL,flo.learned>=20);if(L)flo.lum=flo.lum?flo.lum*.9+L*.1:L;e.free=false;flo.learned++};
function floorFrame(d,now){flo.at=now;const free=cam.motion>STILL,off=(FYL-FY0)*FL.w*3,len=(FL.h-FYL)*FL.w*3;   // (learns only while rolling)
 for(const e of flo.ring)if(e.free&&now-e.at>LATE)learnLook(e);
 if(!flo.ring.length||now-flo.ring[flo.ring.length-1].at>=GAP){const old=flo.ring.length>=RING?flo.ring.shift():null,e=old||{d:new Uint8Array(len)};
  if(old&&old.free)learnLook(old);e.d.set(d.subarray(off,off+len));e.at=now;e.free=free;flo.ring.push(e)}
 const ready=flo.learned>=20,r=floorCheck(d);
 flo.dim=ready&&flo.lum>0&&r.lum<flo.lum*.55;
 flo.hits=ready&&!flo.dim&&r.rows>=3?flo.hits+1:0;   // (two looks running: one glint of glare isn't a sock)
 flo.blocked=flo.hits>=2;flo.cm=r.cm}
const wallAhead=()=>cam.detail<8&&cam.detail<cam.detailAvg*.5;   // (a wall or box right in front: the upper middle goes flat)
const clr={cm:Infinity,at:0};
function clearAhead(now){if(now-flo.at>700||now-cam.at>500)return clr.at&&now-clr.at<1200?clr.cm:Infinity;
 clr.at=now;const cm=flo.blocked&&flo.cm?Math.max(0,flo.cm-FL.nose):Infinity;return clr.cm=wallAhead()?8:cm<=40?cm:Infinity}
// its speed (cm/s) at a drive message's throttle: speed 2 flat out is about 55 cm/s (tile test, Oct 21), 50% about 20,
// 30% barely moves; MAX taken as half again speed 2's (never measured; a guess on the safe side)
const SPD=[[0,0],[.3,0],[.5,20],[.7,41],[1,55.5]];
const vOf=(t,oc)=>{const a=Math.abs(t)*(oc?127:76)/51;if(a>=1)return 55.5*Math.min(1.5,a);
 for(let i=1;i<SPD.length;i++)if(a<=SPD[i][0]){const[x0,y0]=SPD[i-1],[x1,y1]=SPD[i];return y0+(y1-y0)*(a-x0)/(x1-x0)}return 55.5};
const HAND={near:1,delay:.25,brake:220,nose:2};   // (cm; s of picture delay; cm/s² of a hard reverse burst; no forward this close)
const handStop=v=>HAND.near+v*HAND.delay+v*v/(2*HAND.brake);
const bub={v:0,at:0,until:0,panic:0,block:0,saidAt:0};
function bubble(t,g,oc,now){
 if(now<bub.until)return{brake:1,t:bub.panic?-1:-g,oc:bub.panic};
 const dt=bub.at?Math.min(1,(now-bub.at)/1000):1,v0=bub.at&&now-bub.at<1500?bub.v:0;
 if(t<=0){bub.v=v0*Math.max(0,1-dt/.8);bub.at=now;bub.block=0;return null}   // (backing up or coasting: its forward speed dies away)
 const cm=clearAhead(now),want=vOf(t,oc);
 if(cm<=HAND.nose){bub.v=0;bub.at=now;return{hold:1}}
 // (after a brake, forward waits until you let go or back up, or the thing is out of reach: it used to brake, then
 //  drive straight on into the wall)
 if(bub.block){if(cm>handStop(want)+5)bub.block=0;else{bub.v=0;bub.at=now;return{hold:1}}}
 if(v0>12&&handStop(v0)>=cm){const panic=cm<=HAND.near+4,ms=Math.round(Math.max(80,Math.min(300,1000*v0/HAND.brake)));
  bub.until=now+ms;bub.panic=panic?1:0;bub.block=1;bub.v=0;bub.at=now;
  if(now-bub.saidAt>3000){bub.saidAt=now;toast(panic?'Speed bubble: panic stop':'Speed bubble: braked, something close ahead')}
  try{buzz(120,.5)}catch(e){}
  return{brake:1,t:panic?-1:-g,oc:panic}}
bub.v=v0+(want-v0)*Math.min(1,dt/(want>v0?.4:.8));bub.at=now;return null}
// room compass (Nessari v1.47-v1.60): when the car turns, everything above the floor slides sideways across the
// picture. Each look's room row (how much edge each column has, 8% to 44% down, laid out by angle through the lens)
// is matched against a kept one, so small errors don't pile up. Left and right halves are matched on their own:
// driving forward spreads them apart, turning slides both the same way, so the turn is their average.
const YW=320,YH=180,YR0=Math.floor(YH*.08),YR1=Math.floor(YH*.44);
let rmap=null;
function roomMap(){if(rmap)return rmap;const w=YW,h=YH,y=h*.26,ang=new Float64Array(w);
 for(let x=0;x<w;x++){const u=(x+.5-w/2)/w,v=(y-LENS.cy*h)/w,s=1+LENS.k*(u*u+v*v);ang[x]=Math.atan(u/s/LENS.f)*180/Math.PI}
 const half=Math.min(-ang[0],ang[w-1]),src=new Float32Array(w);
 for(let k=0,x=0;k<w;k++){const a=-half+(k+.5)*2*half/w;while(x<w-2&&ang[x+1]<a)x++;src[k]=x+(a-ang[x])/(ang[x+1]-ang[x])}
 return rmap={src,half}}
const pxdeg=()=>YW/(2*roomMap().half);
function roomRow(d){const w=YW,n=YR1-YR0,q=new Float32Array(w);
 for(let y=0;y<n;y++){let prev=0;for(let x=0;x<w;x++){const L=d[y*w+x];if(x)q[x]+=Math.abs(L-prev);prev=L}}
 q[0]=q[1];
 const sm=new Float32Array(w);for(let x=0;x<w;x++){let t=0,c=0;for(let k=Math.max(0,x-3);k<=Math.min(w-1,x+3);k++){t+=q[k];c++}sm[x]=t/c}
 const {src}=roomMap();for(let k=0;k<w;k++){const x=src[k],x0=Math.max(0,Math.min(w-2,Math.floor(x))),f=Math.max(0,Math.min(1,x-x0));q[k]=sm[x0]*(1-f)+sm[x0+1]*f}
 let m=0,v=0;for(let x=0;x<w;x++)m+=q[x];m/=w;
 for(let x=0;x<w;x++){q[x]-=m;v+=q[x]*q[x]}
 v=Math.sqrt(v/w);if(v<1e-6||m<n*1.5)return null;   // (a blank wall or the dark: nothing to go by)
 for(let x=0;x<w;x++)q[x]/=v;return q}
function roomShift(a,b,guess,span,x0,x1,mo=.5){const w=a.length,sc=new Map();let best=-2,bs=0;
 for(let s0=Math.round(guess)-span;s0<=Math.round(guess)+span;s0++){const lo=Math.max(x0,-s0),hi=Math.min(x1,w-s0);if(hi-lo<(x1-x0)*mo)continue;
  let c=0,aa=0,bb=0;for(let x=lo;x<hi;x++){const u=a[x+s0],v=b[x];c+=u*v;aa+=u*u;bb+=v*v}
  const r=c/Math.sqrt(aa*bb+1e-9);sc.set(s0,r);if(r>best){best=r;bs=s0}}
 const l=sc.get(bs-1),r=sc.get(bs+1);let sub=0;
 if(l!=null&&r!=null){const den=l-2*best+r;if(den<0)sub=Math.max(-.5,Math.min(.5,.5*(l-r)/den))}
 let second=-2;for(const [k,v] of sc)if(Math.abs(k-bs)>4&&v>second)second=v;   // (blinds or a shelf match nearly as well a few pixels off)
 return{px:bs+sub,score:Math.max(0,best),clear:best-second}}
function roomTurn(a,b,guess,span){const w=b.length,L=roomShift(a,b,guess,span,0,w>>1),R=roomShift(a,b,guess,span,w>>1,w),score=Math.min(L.score,R.score),spread=Math.abs(L.px-R.px)>16;
 return{px:(L.px+R.px)/2,score,ok:score>=.5&&Math.min(L.clear,R.clear)>=.06&&!spread}}
const yaw={on:0,deg:0,ref:null,refDeg:0,shift:0,v:0,score:0,at:0,good:0,bad:0};
let rollingAt=0;
function yawStep(row,now){const k=pxdeg();yaw.at=now;if(row){yaw.last=row;yaw.lastAt=now}
 if(now-rollingAt>600)yaw.v=0;   // (a look it can't read carries the turn on only while the wheels turn)
 if(!row){yaw.score=0;if(yaw.ref){yaw.shift+=yaw.v;yaw.deg=yaw.refDeg+yaw.shift/k;yaw.bad++}return}
 if(!yaw.ref){yaw.ref=row;yaw.refDeg=yaw.deg;yaw.shift=0;yaw.v=0;yaw.score=1;return}
 const sure=yaw.good>1&&!yaw.bad,m=roomTurn(yaw.ref,row,yaw.shift+yaw.v,sure?30:75);yaw.score=m.ok?m.score:0;
 if(!m.ok){yaw.shift+=yaw.v;yaw.deg=yaw.refDeg+yaw.shift/k;
  if(++yaw.bad>4||Math.abs(yaw.shift)>60){yaw.ref=row;yaw.refDeg=yaw.deg;yaw.shift=0;yaw.bad=0;yaw.v*=.5}return}
 yaw.v=yaw.bad?yaw.v:m.px-yaw.shift;yaw.bad=0;yaw.good++;yaw.shift=m.px;yaw.deg=yaw.refDeg+m.px/k;
 if(Math.abs(m.px)>60){yaw.ref=row;yaw.refDeg=yaw.deg;yaw.shift=0}}
const yawStart=()=>{if(!yaw.on++){yaw.ref=null;yaw.good=0;yaw.bad=0;yaw.v=0;yaw.deg=0}};
const yawStop=()=>{yaw.on=Math.max(0,yaw.on-1)};
// straight hold: with steering at straight (the stick's straight zone, or the steering thumb off), it keeps the
// heading it started with when a tile edge knocks the car crooked, steering back at most half way.
// auto trim: after a drive with 2.5 s or more of straight hold, if it kept steering one way on average, the car's
// trim moves 2 steps that way (and back, the other way round from then on, if that made it worse).
const hst={holding:false,aim:null,trimSum:0,trimN:0,lastAvg:null,lastStep:0};
const holdOff=()=>{if(hst.holding){hst.holding=false;hst.aim=null;yawStop()}};
function setTrim(v){cfg.trim=Math.max(-40,Math.min(40,Math.round(v/2)*2));apply();save();sendTrim()}
const tname=v=>(v>0?'R ':v<0?'L ':'')+Math.abs(v);
function autoTrim(){const n=hst.trimN,avg=n?hst.trimSum/n:0;hst.trimSum=0;hst.trimN=0;
 if(!A.autotrim||!A.hold||n<20)return;
 if(hst.lastAvg!=null&&Math.abs(avg)>Math.abs(hst.lastAvg)+.03&&Math.sign(avg)===Math.sign(hst.lastAvg)){   // (worse after the last step: the trim runs the other way)
  A.trimSign=-(A.trimSign||1);aSave();setTrim(cfg.trim-2*hst.lastStep);hst.lastAvg=null;toast('Auto trim: back to '+tname(cfg.trim));return}
 if(Math.abs(avg)<.08){hst.lastAvg=null;return}
 const step=Math.sign(avg)*(A.trimSign||1);hst.lastStep=step;hst.lastAvg=avg;setTrim(cfg.trim+2*step);toast('Auto trim: trim '+tname(cfg.trim))}
function hold(t,s,dir,now){
 if(A.hold&&t&&s===0&&now-ast.since>300){
  if(!hst.holding){hst.holding=true;hst.aim=null;yawStart()}
  if(yaw.score>=.5&&now-yaw.at<400){if(hst.aim==null)hst.aim=yaw.deg;
   const err=yaw.deg-hst.aim;if(Math.abs(err)>1)s=Math.max(-.5,Math.min(.5,-dir*err/(.6*60)));   // (about 60° a second at full lock)
   if(dir>0){hst.trimSum+=s;hst.trimN++}}}
 else holdOff();
 return s}
// the bigger look, in the same 8-a-second beat as the small one, only while driving and only what's switched on
function bigLook(now){const needFloor=(A.bubble&&!A.drift&&!orbit&&now-fwdAt<1500)||X.floor,needRoom=hst.holding||yaw.on>0,needSeek=!!X.seek;
 if(!needFloor&&!needRoom&&!needSeek)return;
 let ok=false;try{ok=CarApp.grab(YW,YH)}catch(e){}
 if(!ok)return;
 if(needRoom){let b='';try{b=CarApp.rows(YR0,YR1,1,false)}catch(e){}if(b){const d=unb64(b,'room');if(d.length===YW*(YR1-YR0))yawStep(roomRow(d),now)}}
 if(needFloor){let b='';try{b=CarApp.rows(FY0*2,YH,2,true)}catch(e){}if(b){const d=unb64(b,'floor');if(d.length===FL.w*(FL.h-FY0)*3)floorFrame(d,now)}}
 if(needSeek){let b='';try{b=CarApp.rows(0,YH,4,true)}catch(e){}if(b){const d=unb64(b,'seek');if(d.length===80*45*3)try{X.seek(d,80,45,now)}catch(e){}}}}
let fwdAt=0;

function shape(u){const q=new URLSearchParams(u.slice(7));let t=+q.get('t')||0,s=+q.get('s')||0;const oc=q.get('oc')==='1',now=Date.now();
 if(A.drift&&!orbit){const g=oc?1:cfg.sg/3,d=1-cfg.ssr*Math.abs(t)*(oc?1:76/127),raw=t/g,a=Math.abs(raw);
  const s0=d>.05?s/d:s;   // put back the steering the screen took away at speed
  const full=a>=A.dfull;t=(raw<0?-1:1)*(a<.12?0:full?A.dmax:A.dlow)*g;s=clamp(s0*A.dgain);
  if(A.dsnap&&Math.abs(s)>=.5&&Math.abs(prevS)<.3){snapUntil=now+A.dsnap;snapDir=s<0?-1:1}
  if(now<snapUntil&&(s<0?-1:1)===snapDir&&Math.abs(s)>.2)s=snapDir;else snapUntil=0;
  if(Math.abs(s)<.3)flicked=0;   // one flick per turn
  if(A.dflick&&!flicked&&full&&t>0&&Math.abs(s)>=.95){flicked=1;flickUntil=now+80}
  if(now<flickUntil)t=0;
  prevS=s}else prevS=0
 // kick start (from Nessari v1.65): a motor needs more push to start turning than to keep going, so a slow throttle
// from a stop, or a change between forward and back, gets about a tenth of a second at full first (full for the
// speed gear), then drops to what was asked. 70% of the gear and more needs none. Off in drift mode and circling.
 lastDrive=now;if(!A.drift&&!orbit){const g=oc?1:cfg.sg/3;if(t>0)fwdAt=now;
  const b=A.bubble?bubble(t,g,oc,now):null;
  if(b&&b.brake){revAt=0;rollUntil=0;q.set('t',b.t.toFixed(2));q.set('s','0');if(b.oc)q.set('oc','1');return '/drive?'+q.toString()}   // (a brake skips the reverse limit and kick start)
  if(b&&b.hold)t=0;
  const h=helpers(t,s,g,now);t=h.t;s=h.s}
 if(A.kick&&!A.drift&&!orbit&&t){const g=oc?1:cfg.sg/3,dir=t<0?-1:1;if(Math.abs(t)<.7*g&&(now>rollUntil||dir!==rollDir))kickUntil=now+KICK;
  rollDir=dir;rollUntil=now+450;if(now<kickUntil)t=dir*g}
 if(t<0){if(!revAt)revAt=now;let k=A.rev;if(A.soft)k*=Math.min(1,.35+.65*(now-revAt)/1200);t*=k}else revAt=0;
 q.set('t',t.toFixed(2));q.set('s',s.toFixed(2));return '/drive?'+q.toString()}
const f0=window.fetch.bind(window);
window.fetch=(u,o)=>{if(typeof u==='string'){if(X.busy&&X.cancel&&(u.indexOf('/drive?')===0||u.indexOf('/stop')===0))X.cancel();   // (any stick, tap or Stop takes over from a mode)
 if(u.indexOf('/drive?')===0){u=shape(u);drives++}else if(u.indexOf('/stop')===0){revAt=prevS=snapUntil=flickUntil=flicked=kickUntil=0;rollUntil=Math.min(rollUntil,Date.now()+150);if(ast.dir)autoTrim();ast.dir=ast.stuckDir=0;holdOff();bub.until=bub.block=0}}return f0(u,o)};

// ---------- drift button (beside photo and record) ----------
const db=document.createElement('button');db.className='ib';db.id='drift';db.title='Drift mode';db.textContent='D';
$('#side').insertBefore(db,$('#side').firstChild);
db.onclick=()=>{A.drift=A.drift?0:1;db.classList.toggle('on',!!A.drift);toast(A.drift?'Drift mode on':'Drift mode off')};
// ---------- modes (modes.js, loaded the first time one is used, so it costs nothing until then) ----------
let mp=null;
function modes(f){if(!mp)mp=new Promise((ok,no)=>{const sc=document.createElement('script');sc.src='/modes.js';sc.onload=()=>window.CarModes?ok(window.CarModes):no();sc.onerror=no;document.body.appendChild(sc)});
 mp.then(f).catch(()=>{mp=null;toast('Modes could not load')})}
const mb=document.createElement('button');mb.className='ib';mb.id='modesb';mb.title='Modes';mb.textContent='M';
$('#side').insertBefore(mb,db.nextSibling);mb.onclick=()=>modes(m=>m.open());
// tap to go: two quick taps on the floor in the picture and it drives there
let lastTap=null;const downAt=new Map();
document.addEventListener('pointerdown',e=>downAt.set(e.pointerId,{at:Date.now(),x:e.clientX,y:e.clientY}),true);
document.addEventListener('pointerup',e=>{const d=downAt.get(e.pointerId);downAt.delete(e.pointerId);
 if(!A.tapgo||!d||Date.now()-d.at>300||Math.hypot(e.clientX-d.x,e.clientY-d.y)>15||e.target.closest(EXCL+',#mpanel,#mpill'))return;
 const now=Date.now();if(lastTap&&now-lastTap.at<400&&Math.hypot(e.clientX-lastTap.x,e.clientY-lastTap.y)<40){lastTap=null;const x=e.clientX,y=e.clientY;modes(m=>m.tapGo(x,y))}
 else lastTap={at:now,x:e.clientX,y:e.clientY}},true);

// ---------- settings: each group folds open on its own (one at a time) ----------
st.textContent+='details.dd{border-bottom:1px solid var(--line)}details.dd>summary{list-style:none;display:flex;justify-content:space-between;align-items:center;padding:13px 0;color:var(--text);font:700 14px var(--display);letter-spacing:.02em;cursor:pointer}'+
 'details.dd>summary::-webkit-details-marker{display:none}details.dd>summary::after{content:"";width:7px;height:7px;border-right:2px solid var(--faint);border-bottom:2px solid var(--faint);transform:rotate(45deg);margin-right:4px;transition:transform .2s}'+
 'details.dd[open]>summary::after{transform:rotate(-135deg)}.ddb{padding:0 0 10px}#tmb{width:100%;justify-content:center;margin:14px 0 8px}'+
 '#tmode{position:fixed;inset:0;background:var(--bg);z-index:8;display:none;flex-direction:column;touch-action:pan-y}#tmode.on{display:flex}#tmbody{overflow-y:auto;padding:0 16px 24px;width:100%;max-width:640px;margin:0 auto}'+
 '#tmbody h3{margin:16px 0 8px;font-size:14px;color:var(--text);font-family:var(--display)}.go{width:100%;justify-content:center;margin:6px 0}.go.on{background:var(--acc);border-color:var(--acc);color:var(--acc-ink)}'+
 '.meter{display:flex;justify-content:space-between;padding:5px 0;color:var(--text);font-size:13px}.meter b{font:700 14px var(--display);font-variant-numeric:tabular-nums;color:var(--acc)}';
const sh=$('#sheet'),groups={};let body=null;
for(const el of [...sh.children]){
 if(el.id==='reset'){body=null;continue}
 if(el.tagName==='H3'){const d=document.createElement('details');d.className='dd';d.innerHTML='<summary>'+el.textContent+'</summary><div class=ddb></div>';
  el.replaceWith(d);body=d.lastChild;groups[el.textContent]=body;continue}
 if(el.classList.contains('sep')){el.remove();continue}
 if(body)body.appendChild(el)}
const seg=(id,opts)=>'<div class=seg id='+id+'>'+(opts||[[0,'Off'],[1,'On']]).map(o=>'<button data-v='+o[0]+'>'+o[1]+'</button>').join('')+'</div>';
const rng=(id,lo,hi,step)=>'<input type=range id='+id+' min='+lo+' max='+hi+' step='+step+'><output></output>';
const row=(label,inner)=>'<div class=row><label>'+label+'</label>'+inner+'</div>';
const info=t=>'<p class=info>'+t+'</p>';
groups['Controls'].insertAdjacentHTML('beforeend',row('Tap anywhere',seg('a_tap'))+
 info('Press anywhere that is not a button and that spot becomes the centre. Two thumbs: left half throttle, right half steering. Stick: anywhere on the stick’s half. Moving half a slider’s length is full.')+
 row('Tap to go',seg('a_tapgo'))+info('Two quick taps on the floor in the picture and the car drives there (8 cm to 3 m). Any stick, tap or Stop takes over.')+
 row('Stick straight zone',rng('a_win',5,45,1))+info('One-thumb stick: no steering inside this angle either side of straight, then it builds gently to full lock at 90°.'));
groups['Driving'].insertAdjacentHTML('beforeend',row('Reverse speed',rng('a_rev',.25,1,.05))+row('Gentle reverse start',seg('a_soft'))+
 info('100% and Off is the old reverse. Gentle start begins slow and builds up over about a second.'));
groups['Driving'].closest('details').insertAdjacentHTML('afterend','<details class=dd><summary>Drift</summary><div class=ddb>'+
 row('Light throttle',rng('a_dlow',.05,.5,.05))+row('Full throttle past',rng('a_dfull',.4,.95,.05))+row('Full power',rng('a_dmax',.3,1,.05))+row('Steering',rng('a_dgain',1,2,.1))+
 row('Steering snap',rng('a_dsnap',0,400,50))+row('Flick on turn-in',seg('a_dflick'))+
 info('Drift mode (the D button): throttle is light or full, nothing between, and steering is stronger. Full power can be lowered for slick tyres. Snap: a quick turn goes to full lock for a moment. Flick: full lock at full throttle cuts power for 0.1 s to kick the back out. Drift mode is off each time the app opens.')+'</div></details>');
groups['Picture'].insertAdjacentHTML('beforeend',row('Floor ruler',seg('a_ruler'))+
 info('Lines on the floor at 5, 10, 20, 30 and 50 cm and 1 m in front of the car, each a tile (30 cm) wide, with a dotted line straight ahead. Measured on this car’s camera (Oct 22). Right while the car sits flat on the floor.'));
groups['Driving'].insertAdjacentHTML('beforeend',row('Kick start',seg('a_kick'))+
 info('A slow speed from a stop gets about a tenth of a second at full first, so it actually gets going, then drops to what you asked.'));

groups['Driving'].closest('details').insertAdjacentHTML('afterend','<details class=dd><summary>Helpers</summary><div class=ddb>'+
 row('Stuck stop',seg('a_stuck'))+info('Pushing throttle but the picture hasn’t moved for a second: it stops pushing that way until you let go or go the other way. Saves the motor and battery against a wall.')+
 row('Corner limit',seg('a_corner'))+info('At full turn going forward it eases off to 75% so it doesn’t slide wide.')+
 row('Side nudge',seg('a_nudge'))+info('Going straight forward, if something close is sweeping past one side, it steers a little away from it.')+
 row('Speed bubble',seg('a_bubble'))+info('Never slows you. Brakes with a short burst of reverse only when something it’s sure of on the floor (or a wall) is closer than the car can stop from its speed, and won’t go forward with the nose 2 cm from it. Learns the floor in your first 10 seconds or so of driving.')+
 row('Straight hold',seg('a_hold'))+info('With the steering at straight, it watches the room and keeps the heading you started with when a tile edge knocks the car crooked.')+
 row('Auto trim',seg('a_autotrim'))+info('With straight hold on: if it kept steering one way during a drive, the car’s trim moves 2 steps that way after you let go.')+'</div></details>');

// ---------- floor ruler (from Nessari v1.43-v1.60) ----------
// The car's lens, measured from chart photos at 10 to 50 cm (Oct 22): f its reach as a share of the picture's width,
// k how much it bends (division model, per width squared), cy the middle's height as a share of the picture's height,
// h the camera's height and nose how far it sits behind the car's front, in cm. Straight lines on the floor show up
// curved, so the ruler's lines are drawn curved too. Drawn once per screen size or setting, never per picture.
const LENS={f:.443,k:-1.163,cy:.479,h:4.22,nose:4.4},VW=1280,VH=720;
const bend=(u,v)=>{const r=Math.hypot(u,v),k=LENS.k,q=r<1e-9?1:(1-Math.sqrt(1-4*k*r*r))/(2*k*r*r);return[VW/2+u*q*VW,LENS.cy*VH+v*q*VW]};
const floorAt=(x,d)=>{const z=Math.max(.5,d+LENS.nose);return bend(LENS.f*x/z,LENS.f*LENS.h/z)};
st.textContent+='#ruler{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;transform-origin:center;display:none}#ruler polyline,#ruler line{fill:none}#ruler .side{stroke-dasharray:4 4}#ruler .mid{stroke-dasharray:3 6}';
$('#view').insertAdjacentHTML('beforeend','<svg id=ruler xmlns="http://www.w3.org/2000/svg"></svg>');
let rulerKey='';
function drawRuler(){const sv=$('#ruler');if(!sv)return;sv.style.display=A.ruler?'block':'none';if(!A.ruler)return;
 const key=[cfg.fit,cfg.zoom,innerWidth,innerHeight].join();sv.style.transform='scale('+cfg.zoom+')';if(key===rulerKey)return;rulerKey=key;
 sv.setAttribute('viewBox','0 0 '+VW+' '+VH);sv.setAttribute('preserveAspectRatio',cfg.fit==='fill'?'xMidYMid slice':'xMidYMid meet');
 const fs=Math.round(VH*.026),inside=p=>p[0]>=0&&p[0]<=VW&&p[1]<=VH;
 const poly=(pts,cls)=>'<polyline'+(cls?' class='+cls:'')+' points="'+pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ')+'"/>';
 let g='',prev=null;
 for(const d of [5,10,20,30,50,100]){const pts=[];for(let i=0;i<=24;i++){const p=floorAt(-15+i*1.25,d);if(inside(p)&&p[1]<=VH-2)pts.push(p)}
  if(pts.length<2)continue;g+=poly(pts);
  if(prev!=null)for(const sx of [-15,15]){const side=[];for(let i=0;i<=10;i++){const p=floorAt(sx,prev+(d-prev)*i/10);if(inside(p))side.push(p)}if(side.length>1)g+=poly(side,'side')}
  const e=pts[pts.length-1],lx=Math.min(e[0]+fs*.4,VW-fs*3.2),ly=lx<e[0]?e[1]-fs*.4:e[1]+fs*.35;
  g+='<text x="'+lx.toFixed(1)+'" y="'+ly.toFixed(1)+'">'+(d<100?d+' cm':'1 m')+'</text>';prev=d}
 g+='<line class=mid x1="'+VW/2+'" y1="'+VH+'" x2="'+VW/2+'" y2="'+floorAt(0,100)[1].toFixed(1)+'"/>';   // straight ahead, to line the car up
 sv.innerHTML='<g stroke="#fff" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-opacity=".6" font-size="'+fs+'" fill="#fff" fill-opacity=".85" paint-order="stroke" style="font-family:system-ui,sans-serif">'+g+'</g>'}
const ap0=apply;apply=function(){ap0();drawRuler()};addEventListener('resize',drawRuler);

// the old Tests group moves to Test mode
const oldTests=groups['Tests'];
// inside a .tests box so the controller's D-pad reaches it (the shared screen's list takes '#sheet .tests button')
$('#reset').insertAdjacentHTML('beforebegin','<div class=tests style="display:block"><button class=pill id=tmb>Test mode</button></div>');
document.querySelectorAll('#sheet details.dd').forEach(d=>d.addEventListener('toggle',()=>{if(d.open)document.querySelectorAll('#sheet details.dd').forEach(o=>{if(o!==d)o.open=false})}));
// controller navigation (D-pad) walks the rows; the group holding the picked row opens
const fs0=fShow;fShow=function(){fs0();const el=document.querySelector('#sheet .gpf'),d=el&&el.closest('details');if(d&&!d.open){d.open=true;el.scrollIntoView({block:'nearest'})}};

// ---------- test mode ----------
document.body.insertAdjacentHTML('beforeend','<div id=tmode><div class=bar><h2>Test mode</h2><div style="display:flex;gap:8px"><button class=pill id=tmstop>Stop</button>'+
 '<button class=ib id=tmx title=Close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div></div><div id=tmbody>'+
 '<h3>Speed check</h3>'+
 '<div class=meter><span>Screen refresh</span><b id=m_fps>–</b></div>'+
 '<div class=meter><span>Touch reports (drag a finger here)</span><b id=m_touch>–</b></div>'+
 '<div class=meter><span>Screen updates to the car</span><b id=m_upd>–</b></div>'+
 '<div class=meter><span>Messages sent to the car</span><b id=m_sent>–</b></div>'+
 '<div class=meter><span>Camera pictures</span><b id=m_cam>–</b></div>'+
 info('Per second. Screen updates only count while you drive, so use a controller with this open to see them. Messages to the car go out all the time.')+
 row('Screen updates',seg('a_urate',[[10,'10'],[20,'20'],[30,'30'],[50,'50']]))+
 row('Messages to car',seg('a_crate',[[20,'20'],[30,'30'],[50,'50'],[100,'100']]))+
 info('Per second. The stock app sends 20 messages a second. Try more and see whether the car answers any quicker; go back to 20 if it stutters or ignores some.')+
 '<h3>Steering speed</h3>'+info('Wheels off the ground. Swings the steering full left and right, faster and faster (every 500 ms down to 40 ms). Watch for the point where the wheels stop reaching full lock: that is as fast as the car itself can steer.')+
 '<button class="pill go" id=t_steer>Run steering speed test</button>'+
 '<h3>Slot B or C with the motor running</h3>'+info('Wheels off the ground. Runs the motor at a steady throttle and steps the slot through its values, 2 s each (the value shows at the top of the screen). If the motor speed or sound changes with the value, that slot adjusts the throttle.')+
 row('Slot',seg('a_tslot',[[1,'B'],[2,'C']]))+row('Throttle',rng('a_tthr',.1,.5,.05))+
 '<button class="pill go" id=t_motor>Run motor test</button>'+
 '<h3>Slots, one value at a time</h3><div id=tmold></div>'+
 '<h3>Controller</h3><button class="pill go" id=t_pad>Test controller &amp; dead zones</button>'+
 '</div></div>');
while(oldTests.firstChild)$('#tmold').appendChild(oldTests.firstChild);oldTests.closest('details').remove();
const tm=on=>{$('#tmode').classList.toggle('on',on);if(on){sheet(false);touch.t=touch.s=null;fetch('/stop').catch(()=>{})}};
$('#tmb').onclick=()=>tm(true);$('#tmx').onclick=()=>tm(false);$('#tmstop').onclick=()=>$('#stop').onclick();
$('#t_pad').onclick=()=>{tm(false);$('#ptb').onclick()};
// starting a test closes the panel so the car, the camera and the value at the top can be watched
document.querySelectorAll('#tmold .tests button,#mhold').forEach(b=>b.addEventListener('click',()=>tm(false)));
const pill=t=>{$('#tpill span').textContent=t;$('#tpill').classList.add('on')};
let tRun=null;
function tEnd(){if(!tRun)return;clearTimeout(tRun.timer);tRun=null;fetch('/extra').catch(()=>{});f0('/stop').catch(()=>{});$('#tpill').classList.remove('on')}
function tStart(){tEnd();endTest();mstop();setOrbit(0);tm(false);tRun={timer:0}}
$('#t_steer').onclick=()=>{tStart();const P=[500,400,300,200,150,120,100,80,60,50,40];let i=0,side=1,at=Date.now();
 const step=()=>{if(!tRun)return;if(Date.now()-at>2500){i++;at=Date.now()}
  if(i>=P.length){tEnd();toast('Steering speed test done');return}
  side=-side;pill('Steering swing every '+P[i]+' ms');f0('/drive?t=0&s='+side+'&ms=600').catch(()=>{});tRun.timer=setTimeout(step,P[i])};step()};
$('#t_motor').onclick=()=>{tStart();const V=[0,1,2,4,8,16,32,64,128,192,255,0],sl=A.tslot||1,n='ABC'[sl];let i=0,held=0;
 const step=()=>{if(!tRun)return;if(i>=V.length){tEnd();toast('Motor test done');return}
  pill('Slot '+n+'  =  '+V[i]+'   throttle '+Math.round(A.tthr*100)+'%  ('+(i+1)+'/'+V.length+')');
  f0('/extra?slot='+sl+'&v='+V[i]).catch(()=>{});f0('/drive?t='+A.tthr+'&s=0&ms=700').catch(()=>{});
  if(++held>=4){held=0;i++}tRun.timer=setTimeout(step,500)};step()};
const st0=$('#stop').onclick;$('#stop').onclick=()=>{tEnd();st0()};
// meters, only while the panel is open
let fpsN=0,touchN=0,last=null;
(function raf(){fpsN++;requestAnimationFrame(raf)})();
$('#tmode').addEventListener('pointermove',()=>touchN++);
setInterval(()=>{const now=Date.now();
 if(!$('#tmode').classList.contains('on')){last=null;fpsN=touchN=0;drives=0;return}
 f0('/speed',{cache:'no-store'}).then(r=>r.json()).then(j=>{
  if(last){const dt=(now-last.t)/1000;
   $('#m_fps').textContent=Math.round(fpsN/dt);$('#m_touch').textContent=touchN?Math.round(touchN/dt):'–';
   $('#m_upd').textContent=Math.round(drives/dt);$('#m_sent').textContent=Math.round((j.sent-last.sent)/dt);
   $('#m_cam').textContent=Math.round((j.frames-last.frames)/dt)}
  last={t:now,sent:j.sent,frames:j.frames};fpsN=touchN=drives=0}).catch(()=>{})},1000);

// ---------- settings rows ----------
A.tslot=A.tslot||1;A.tthr=A.tthr||.2;
const fmtA={win:v=>Math.round(v)+'°',rev:v=>Math.round(v*100)+'%',dlow:v=>Math.round(v*100)+'%',dfull:v=>Math.round(v*100)+'% push',dmax:v=>Math.round(v*100)+'%',dsnap:v=>v?Math.round(v)+' ms':'Off',dgain:v=>(+v).toFixed(1)+'×',tthr:v=>Math.round(v*100)+'%'};
const RN=['win','rev','dlow','dfull','dmax','dgain','dsnap','tthr'],SG=['tap','soft','dflick','urate','crate','tslot','ruler','kick','stuck','corner','nudge','bubble','hold','autotrim','tapgo'];
const sendRate=()=>f0('/rate?ms='+Math.round(1000/A.crate)).catch(()=>{});
function aApply(){document.body.classList.toggle('tapany',!!A.tap);drawRuler();db.classList.toggle('on',!!A.drift);
 for(const k of RN){const i=$('#a_'+k);i.value=A[k];i.nextElementSibling.textContent=fmtA[k](A[k])}
 for(const k of SG)document.querySelectorAll('#a_'+k+' button').forEach(b=>b.classList.toggle('sel',+b.dataset.v===+A[k]))}
for(const k of RN)$('#a_'+k).oninput=e=>{A[k]=+e.target.value;aApply();aSave()};
for(const k of SG)document.querySelectorAll('#a_'+k+' button').forEach(b=>b.onclick=()=>{A[k]=+b.dataset.v;aApply();aSave();if(k==='crate')sendRate()});
const r0=$('#reset').onclick;$('#reset').onclick=()=>{r0();A={...AD,drift:A.drift,tslot:A.tslot,tthr:A.tthr};aApply();aSave();sendRate()};
aApply();sendRate();
// the shared screen updates the car 10 times a second; extra updates in between bring it to Screen updates (default 20)
let mine=false;const rp0=readPad;
Object.assign(X,{A,cam,flo,yaw,LENS,FL,STILL,f0,toast,buzz,clearAhead,wallAhead,vOf,handStop,roomRow,roomShift,pxdeg,yawStart,yawStop,unb64,YW,YH,YR0,YR1});
readPad=function(){if(!mine){const n=Math.max(1,Math.round(A.urate/10));for(let k=1;k<n;k++)setTimeout(()=>{mine=true;try{tick()}finally{mine=false}},k*100/n)}return rp0()};
})();
