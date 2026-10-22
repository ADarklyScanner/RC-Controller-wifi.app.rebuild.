// Android app only. LocalServer adds this after the shared screen (page.html), so the Termux version and the
// Chrome page stay exactly as they are. It runs after the page's own script and uses its names (cfg, touch, orbit...).
// Adds: tap-anywhere driving, a rebuilt one-thumb stick, a reverse speed limit with a gentle start, drift mode,
// a floor ruler over the picture, kick start, and three driving helpers: stuck stop, corner limit and side nudge
// (all from Nessari's drive screen, Oct 22).
(()=>{
const AD={tap:1,win:20,rev:.5,soft:1,dlow:.2,dfull:.7,dmax:1,dgain:1.4,dsnap:150,dflick:1,urate:20,crate:20,ruler:1,kick:1,stuck:1,corner:1,nudge:1};
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
const EXCL='button,input,.ib,#gears,#side,#sheet,#scrim,#gal,#viewer,#padt,#tmode,#off,#tpill';
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
const cam={motion:99,left:0,right:0,at:0,prev:null};
const ast={dir:0,since:0,stuckSince:0,stuckDir:0,veer:0};
let lastDrive=0;
setInterval(()=>{if(!window.CarApp||Date.now()-lastDrive>600){cam.prev=null;return}
 let b='';try{b=CarApp.look(32,18)}catch(e){}
 if(!b){cam.prev=null;return}
 const r=atob(b),g=new Uint8Array(r.length);for(let i=0;i<r.length;i++)g[i]=r.charCodeAt(i);
 if(cam.prev&&cam.prev.length===g.length){let sum=0,l=0,rr=0;for(let i=0;i<g.length;i++){const d=Math.abs(g[i]-cam.prev[i]);sum+=d;if(i%32<16)l+=d;else rr+=d}
  cam.motion=sum/g.length;cam.left=l/(g.length/2);cam.right=rr/(g.length/2);cam.at=Date.now()}
 cam.prev=g},125);
function helpers(t,s,g,now){const dir=t>0?1:t<0?-1:0;
 if(dir!==ast.dir){ast.dir=dir;ast.since=now;ast.stuckSince=0;ast.veer=0}
 if(ast.stuckDir){if(dir===ast.stuckDir)return{t:0,s};ast.stuckDir=0}
 if(A.stuck&&dir&&now-ast.since>1200&&now-cam.at<400){
  if(cam.motion<STILL){ast.stuckSince=ast.stuckSince||now;
   if(now-ast.stuckSince>1000){ast.stuckDir=dir;ast.stuckSince=0;toast('Stuck: let go of the throttle or go the other way');try{buzz(200,.6)}catch(e){}return{t:0,s}}}
  else ast.stuckSince=0}
 if(A.corner&&t>CORNER*g&&Math.abs(s)>=.75)t=CORNER*g;
 if(A.nudge&&t>.3*g&&Math.abs(s)<.15&&now-ast.since>700&&now-cam.at<400){const l=cam.left,r=cam.right,sum=l+r;
  const want=sum<2*STILL||Math.abs(r-l)/sum<.25?0:-1.4*(r-l)/sum;ast.veer=clamp(ast.veer*.5+want*.5);const v=ast.veer*.5;if(Math.abs(v)>.1)s=clamp(s+v)}
 else ast.veer=0;
 return{t,s}}
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
 lastDrive=now;if(!A.drift&&!orbit){const h=helpers(t,s,oc?1:cfg.sg/3,now);t=h.t;s=h.s}
 if(A.kick&&!A.drift&&!orbit&&t){const g=oc?1:cfg.sg/3,dir=t<0?-1:1;if(Math.abs(t)<.7*g&&(now>rollUntil||dir!==rollDir))kickUntil=now+KICK;
  rollDir=dir;rollUntil=now+450;if(now<kickUntil)t=dir*g}
 if(t<0){if(!revAt)revAt=now;let k=A.rev;if(A.soft)k*=Math.min(1,.35+.65*(now-revAt)/1200);t*=k}else revAt=0;
 q.set('t',t.toFixed(2));q.set('s',s.toFixed(2));return '/drive?'+q.toString()}
const f0=window.fetch.bind(window);
window.fetch=(u,o)=>{if(typeof u==='string'){if(u.indexOf('/drive?')===0){u=shape(u);drives++}else if(u.indexOf('/stop')===0){revAt=prevS=snapUntil=flickUntil=flicked=kickUntil=0;rollUntil=Math.min(rollUntil,Date.now()+150);ast.dir=ast.stuckDir=0}}return f0(u,o)};

// ---------- drift button (beside photo and record) ----------
const db=document.createElement('button');db.className='ib';db.id='drift';db.title='Drift mode';db.textContent='D';
$('#side').insertBefore(db,$('#side').firstChild);
db.onclick=()=>{A.drift=A.drift?0:1;db.classList.toggle('on',!!A.drift);toast(A.drift?'Drift mode on':'Drift mode off')};

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
 row('Side nudge',seg('a_nudge'))+info('Going straight forward, if something close is sweeping past one side, it steers a little away from it.')+'</div></details>');

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
const RN=['win','rev','dlow','dfull','dmax','dgain','dsnap','tthr'],SG=['tap','soft','dflick','urate','crate','tslot','ruler','kick','stuck','corner','nudge'];
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
readPad=function(){if(!mine){const n=Math.max(1,Math.round(A.urate/10));for(let k=1;k<n;k++)setTimeout(()=>{mine=true;try{tick()}finally{mine=false}},k*100/n)}return rp0()};
})();
