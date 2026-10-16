// Android app only. LocalServer adds this after the shared screen (page.html), so the Termux version and the
// Chrome page stay exactly as they are. It runs after the page's own script and uses its names (cfg, touch, orbit...).
// Adds: tap-anywhere driving, a rebuilt one-thumb stick, a reverse speed limit with a gentle start, and drift mode.
(()=>{
const AD={tap:1,win:20,rev:.5,soft:1,dlow:.2,dfull:.7,dmax:1,dgain:1.4,dsnap:150,dflick:1};
let A={...AD};try{Object.assign(A,JSON.parse(localStorage.carapp||'{}'))}catch(e){}
A.drift=0;   // drift mode is off every time the app opens
const aSave=()=>{try{const k={...A};delete k.drift;localStorage.carapp=JSON.stringify(k)}catch(e){}};
const clamp=v=>Math.max(-1,Math.min(1,v));

// ---------- looks ----------
const st=document.createElement('style');
st.textContent='body.tapany .slot{pointer-events:none}body.tapany #thr{left:8px}body.tapany #str{right:8px}body.tapany #joy.L{left:8px}body.tapany #joy.R{right:8px}'+
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
const EXCL='button,input,.ib,#gears,#side,#sheet,#scrim,#gal,#viewer,#padt,#off,#tpill';
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
let revAt=0,prevS=0,snapUntil=0,snapDir=0,flickUntil=0,flicked=0;
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
 if(t<0){if(!revAt)revAt=now;let k=A.rev;if(A.soft)k*=Math.min(1,.35+.65*(now-revAt)/1200);t*=k}else revAt=0;
 q.set('t',t.toFixed(2));q.set('s',s.toFixed(2));return '/drive?'+q.toString()}
const f0=window.fetch.bind(window);
window.fetch=(u,o)=>{if(typeof u==='string'){if(u.indexOf('/drive?')===0)u=shape(u);else if(u.indexOf('/stop')===0)revAt=prevS=snapUntil=flickUntil=flicked=0}return f0(u,o)};

// ---------- drift button (beside photo and record) ----------
const db=document.createElement('button');db.className='ib';db.id='drift';db.title='Drift mode';db.textContent='D';
$('#side').insertBefore(db,$('#side').firstChild);
db.onclick=()=>{A.drift=A.drift?0:1;db.classList.toggle('on',!!A.drift);toast(A.drift?'Drift mode on':'Drift mode off')};

// ---------- settings ----------
const fmtA={win:v=>Math.round(v)+'°',rev:v=>Math.round(v*100)+'%',dlow:v=>Math.round(v*100)+'%',dfull:v=>Math.round(v*100)+'% push',dmax:v=>Math.round(v*100)+'%',dsnap:v=>v?Math.round(v)+' ms':'Off',dgain:v=>(+v).toFixed(1)+'×'};
const seg=(id)=>'<div class=seg id='+id+'><button data-v=0>Off</button><button data-v=1>On</button></div>';
const rng=(id,lo,hi,step)=>'<input type=range id='+id+' min='+lo+' max='+hi+' step='+step+'><output></output>';
const row=(label,inner)=>'<div class=row><label>'+label+'</label>'+inner+'</div>';
$('#trim').closest('.row').insertAdjacentHTML('afterend','<div class=sep></div><h3>App</h3>'+
 row('Tap anywhere',seg('a_tap'))+
 '<p class=info>Press anywhere that is not a button and that spot becomes the centre. Two thumbs: left half throttle, right half steering. Stick: anywhere on the stick’s half. Moving half a slider’s length is full.</p>'+
 row('Stick straight zone',rng('a_win',5,45,1))+
 '<p class=info>One-thumb stick: no steering inside this angle either side of straight, then it builds gently to full lock at 90°.</p>'+
 row('Reverse speed',rng('a_rev',.25,1,.05))+row('Gentle reverse start',seg('a_soft'))+
 '<p class=info>100% and Off is the old reverse. Gentle start begins slow and builds up over about a second.</p>'+
 row('Drift light throttle',rng('a_dlow',.05,.5,.05))+row('Drift full throttle past',rng('a_dfull',.4,.95,.05))+row('Drift full power',rng('a_dmax',.3,1,.05))+row('Drift steering',rng('a_dgain',1,2,.1))+
 row('Drift steering snap',rng('a_dsnap',0,400,50))+row('Drift flick on turn-in',seg('a_dflick'))+
 '<p class=info>Drift mode (the D button): throttle is light or full, nothing between, and steering is stronger. Full power can be lowered for slick tyres. Snap: a quick turn goes to full lock for a moment. Flick: full lock at full throttle cuts power for 0.1 s to kick the back out. Drift mode is off each time the app opens.</p>');
const RN=['win','rev','dlow','dfull','dmax','dgain','dsnap'],SG=['tap','soft','dflick'];
function aApply(){document.body.classList.toggle('tapany',!!A.tap);db.classList.toggle('on',!!A.drift);
 for(const k of RN){const i=$('#a_'+k);i.value=A[k];i.nextElementSibling.textContent=fmtA[k](A[k])}
 for(const k of SG)document.querySelectorAll('#a_'+k+' button').forEach(b=>b.classList.toggle('sel',+b.dataset.v===+A[k]))}
for(const k of RN)$('#a_'+k).oninput=e=>{A[k]=+e.target.value;aApply();aSave()};
for(const k of SG)document.querySelectorAll('#a_'+k+' button').forEach(b=>b.onclick=()=>{A[k]=+b.dataset.v;aApply();aSave()});
const r0=$('#reset').onclick;$('#reset').onclick=()=>{r0();A={...AD,drift:A.drift};aApply();aSave()};
aApply();
// the shared screen updates the car 10 times a second; the app sends to the car 20 times a second (as the stock app),
// so a second update half-way between makes the screen keep up with it: half the delay from thumb to car.
let mine=false;const rp0=readPad;
readPad=function(){if(!mine)setTimeout(()=>{mine=true;try{tick()}finally{mine=false}},50);return rp0()};
})();
