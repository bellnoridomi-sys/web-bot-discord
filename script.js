const ROUTES = ['home','features','dashboard','commands','docs'];
const COMMANDS = [
 ['ping','Check bot latency'],['help','Show command help'],['server','Server overview'],['userinfo','Inspect a member'],['avatar','Show a member avatar'],['botinfo','Bot runtime info'],['poll','Create a reaction poll'],['8ball','Ask the anime orb'],['roll','Roll a random number'],['coinflip','Flip a coin'],['remind','Create a reminder'],['afk','Set AFK with optional image/GIF'],['warn','Warn a member'],['warnings','List member warnings'],['clear','Delete recent messages'],['slowmode','Set channel slowmode'],['lock','Lock a channel'],['unlock','Unlock a channel'],['kick','Kick a member'],['ban','Ban a member'],['timeout','Timeout a member'],['role','Add or remove a role'],['announce','Send a styled announcement'],['vc-join','Join a voice channel'],['vc-leave','Leave voice'],['auto-voice','Toggle automatic voice recovery']
];
const state = { route:'home', me:null, guild:null, config:null, channels:[], socket:null };
const $ = id => document.getElementById(id);
function escapeHtml(v=''){return String(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
async function fetchJson(url, options={}){const res=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(options.headers||{})},...options});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`);return data;}
function showRoute(route, push=true){
  if(!ROUTES.includes(route)) route='home';
  state.route=route;
  document.querySelectorAll('.page').forEach(page=>page.classList.toggle('active',page.dataset.page===route));
  document.querySelectorAll('[data-route]').forEach(el=>el.classList.toggle('active',el.dataset.route===route));
  if(push && location.hash.slice(1)!==route) history.pushState({},'',`#${route}`);
  const flash=$('transitionFlash'); flash?.classList.remove('run'); void flash?.offsetWidth; flash?.classList.add('run');
  window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  if(route==='dashboard') refreshDashboard();
}
function setupRoutes(){
  document.querySelectorAll('[data-route]').forEach(el=>el.addEventListener('click',e=>{const route=el.dataset.route;if(!route)return;if(el.tagName==='A')e.preventDefault();showRoute(route,true);}));
  addEventListener('hashchange',()=>showRoute(location.hash.slice(1)||'home',false));
  addEventListener('popstate',()=>showRoute(location.hash.slice(1)||'home',false));
  showRoute(location.hash.slice(1)||'home',false);
}
function renderCommands(){
  $('commandCatalog').innerHTML=COMMANDS.map(([name,desc],i)=>`<article class="command-item"><code>/${escapeHtml(name)}</code><p>${escapeHtml(desc)}</p><small>#${String(i+1).padStart(2,'0')}</small></article>`).join('');
}
function setupVisuals(){
  const canvas=$('space'),ctx=canvas?.getContext('2d'); if(!ctx)return;
  let w=innerWidth,h=innerHeight,dpr=Math.min(devicePixelRatio||1,2),stars=[];
  const stage=$('orbital'), glow=$('cursorGlow');
  const resize=()=>{w=innerWidth;h=innerHeight;dpr=Math.min(devicePixelRatio||1,2);canvas.width=w*dpr;canvas.height=h*dpr;canvas.style.width=w+'px';canvas.style.height=h+'px';ctx.setTransform(dpr,0,0,dpr,0,0);stars=Array.from({length:Math.min(120,Math.round(w/10))},()=>({x:Math.random()*w,y:Math.random()*h,r:Math.random()*1.1+.2,s:Math.random()*.5+.15}));};
  const frame=()=>{ctx.clearRect(0,0,w,h);for(const p of stars){p.y-=p.s;if(p.y<0)p.y=h;ctx.globalAlpha=.05+Math.random()*.12;ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fill();}ctx.globalAlpha=1;requestAnimationFrame(frame)};
  resize();addEventListener('resize',resize);requestAnimationFrame(frame);
  addEventListener('pointermove',e=>{if(glow){glow.style.left=e.clientX+'px';glow.style.top=e.clientY+'px';}if(stage && innerWidth>980&&!matchMedia('(prefers-reduced-motion: reduce)').matches){const ry=(e.clientX/innerWidth-.5)*10,rx=(.5-e.clientY/innerHeight)*8;stage.style.transform=`perspective(1500px) rotateX(${rx}deg) rotateY(${ry}deg)`;}});
  addEventListener('pointerleave',()=>{if(stage)stage.style.transform='';});
}
function renderLoggedOut(){
  $('dashboardPanel').hidden=true; $('loginGate').hidden=false; $('authButton').textContent='Sign in'; $('authButton').onclick=()=>showRoute('dashboard'); $('dashboardAuth').innerHTML='';
}
function renderLoggedIn(){
  $('dashboardPanel').hidden=false; $('loginGate').hidden=true;
  $('authButton').textContent='Logout'; $('authButton').onclick=()=>location.href='/auth/logout';
  const u=state.me.user||{};
  $('dashboardAuth').innerHTML=`<div class="auth-kicker">${u.provider==='discord'||u.discordId?'DISCORD LINKED':'SIGNED IN'}</div><b>${escapeHtml(u.username||'Aki user')}</b>${u.provider==='discord'||u.discordId?'':'<a class="auth-link" href="/auth/discord">LINK DISCORD →</a>'}`;
}
function updateTop(){const ready=!!state.me?.bot?.ready;$('topStatus').textContent=ready?'BOT ONLINE':'WEB ONLINE';$('heroPing').textContent=ready?`${state.me.bot.ping}ms`:'—';}
async function boot(){
  renderCommands();setupRoutes();setupVisuals();setupControls();renderLoggedOut();
  try{state.me=await fetchJson('/api/me');}catch{state.me={authenticated:false};}
  if(state.me.authenticated){renderLoggedIn();populateGuilds();}updateTop();refreshOverview();
  if(window.io){state.socket=io({transports:['websocket','polling']});state.socket.on('bot-status',()=>{refreshOverview();});state.socket.on('activity',()=>{if(state.route==='dashboard')refreshActivity();});}
}
async function refreshOverview(){try{const d=await fetchJson('/api/overview');$('heroCommands').textContent=d.bot.commands;$('heroPing').textContent=d.bot.ready?`${d.bot.ping}ms`:'—';$('metricCommands').textContent=d.bot.commands;$('metricPing').textContent=d.bot.ready?`${d.bot.ping}ms`:'—';$('matrixGateway').textContent=d.bot.ready?'connected':'waiting';$('matrixDb').textContent=d.persistence;$('matrixVoice').textContent=d.bot.ready?'ready':'standby';$('botDot').classList.toggle('on',!!d.bot.ready);if(state.me)state.me.bot=d.bot;updateTop();}catch(e){}}
async function refreshDashboard(){if(!state.me?.authenticated)return;await populateGuilds();await refreshOverview();}
async function populateGuilds(){
  const select=$('guildSelect'),guilds=state.me?.guilds||[]; if(!select)return;
  if(!guilds.length){select.innerHTML='<option>No manageable server</option>';$('dashboardPanel').innerHTML='<div class="panel login-gate"><div class="login-orbit"><span>!</span></div><div><div class="eyebrow">SERVER GATE</div><h3>No manageable server</h3><p>Đăng nhập Discord rồi đảm bảo bot đã được mời vào server mà bạn có quyền Manage Server hoặc Administrator.</p></div></div>';return;}
  if(!state.guild||!guilds.some(g=>g.id===state.guild.id))state.guild=guilds[0];
  select.innerHTML=guilds.map(g=>`<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');select.value=state.guild.id;select.onchange=()=>{state.guild=guilds.find(g=>g.id===select.value);loadGuild();};await loadGuild();
}
async function loadGuild(){
  try{const d=await fetchJson(`/api/guilds/${state.guild.id}/config`);state.config=d.config;$('metricMembers').textContent=d.stats.members;$('metricChannels').textContent=d.stats.channels;$('metricPing').textContent=`${d.stats.ping}ms`;$('metricCommands').textContent=state.me.bot?.commands||26;$('autoVoice').checked=!!d.config.auto_voice_enabled;await loadChannels();await loadAfk();await refreshActivity();}catch(e){flash('responseBox',e.message,true);}
}
async function loadChannels(){
  const d=await fetchJson(`/api/guilds/${state.guild.id}/channels`);state.channels=d.channels||[];const voice=state.channels.filter(c=>[2,13].includes(c.type)),text=state.channels.filter(c=>[0,5].includes(c.type));
  $('voiceChannel').innerHTML=voice.length?voice.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join(''):'<option value="">No voice channel</option>';if(state.config?.auto_voice_channel_id)$('voiceChannel').value=state.config.auto_voice_channel_id;
  $('textChannel').innerHTML=text.length?text.map(c=>`<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join(''):'<option value="">Default text channel</option>';
}
async function loadAfk(){
  try{const d=await fetchJson(`/api/guilds/${state.guild.id}/afk`);if(d.active){$('afkReason').value=d.afk.reason||'';$('afkMedia').value=d.afk.media_url||'';$('afkStatus').textContent='ACTIVE';}else{$('afkReason').value='';$('afkMedia').value='';$('afkStatus').textContent='IDLE';}updateAfkPreview();}catch(e){$('afkStatus').textContent=e.message==='DISCORD_LINK_REQUIRED'?'LINK DISCORD':'UNAVAILABLE';}
}
function updateAfkPreview(){const reason=$('afkReason')?.value.trim()||'Your reason will appear here.';const url=$('afkMedia')?.value.trim();$('afkPreviewText').textContent=reason;const box=$('afkMediaPreview');box.innerHTML='';if(url&&/^https?:\/\//i.test(url)){const img=new Image();img.alt='AFK preview';img.onload=()=>box.appendChild(img);img.onerror=()=>{box.innerHTML='<span>MEDIA URL ERROR</span>';};img.src=url;}else box.innerHTML='<span>PREVIEW / AFK MEDIA</span>';}
function flash(id,msg,error=false){const el=$(id);if(!el)return;el.textContent=msg;el.dataset.error=error?'1':'0';clearTimeout(el._t);el._t=setTimeout(()=>el.dataset.error='',3500);}
async function refreshActivity(){if(!state.guild)return;try{const d=await fetchJson('/api/activity');const allowed=state.guild.id;const items=(d.items||[]).filter(x=>!x.guild_id||x.guild_id===allowed);$('activityList').innerHTML=items.length?items.slice(0,20).map(x=>`<div class="activity-item"><b>${escapeHtml(x.action||'event')}</b><small>${escapeHtml(x.details||'')} · ${escapeHtml(new Date(x.created_at).toLocaleString('vi-VN'))}</small></div>`).join(''):'<div class="empty-line">No events yet.</div>';}catch(e){}}
async function executeCommand(){if(!state.guild)return flash('responseBox','ERROR · SELECT A SERVER',true);try{const name=$('commandName').value.trim().replace(/^\//,'').toLowerCase();let args={};const raw=$('commandArgs').value.trim();if(raw){try{args=JSON.parse(raw);}catch{throw new Error('Arguments must be valid JSON.');}}const d=await fetchJson(`/api/guilds/${state.guild.id}/command`,{method:'POST',body:JSON.stringify({name,args,channelId:$('textChannel').value||undefined})});flash('responseBox',`OK · /${d.command}\n${d.payload}`);await refreshActivity();}catch(e){flash('responseBox',`ERROR · ${e.message}`,true);}}
function setupControls(){
  $('sparkleControl').addEventListener('click',()=>showRoute('dashboard'));
  $('saveVoice').addEventListener('click',async()=>{try{const enabled=$('autoVoice').checked,channelId=$('voiceChannel').value;await fetchJson(`/api/guilds/${state.guild.id}/config`,{method:'PUT',body:JSON.stringify({auto_voice_enabled:enabled,auto_voice_channel_id:channelId})});flash('responseBox',enabled?'AUTO VOICE ENABLED + JOINED':'AUTO VOICE DISABLED');$('matrixVoice').textContent=enabled?'active':'standby';}catch(e){flash('responseBox',`ERROR · ${e.message}`,true);}});
  $('leaveVoice').addEventListener('click',async()=>{try{await fetchJson(`/api/guilds/${state.guild.id}/voice/leave`,{method:'POST'});flash('responseBox','VOICE · LEFT');$('matrixVoice').textContent='standby';}catch(e){flash('responseBox',`ERROR · ${e.message}`,true);}});
  $('saveAfk').addEventListener('click',async()=>{try{await fetchJson(`/api/guilds/${state.guild.id}/afk`,{method:'PUT',body:JSON.stringify({reason:$('afkReason').value.trim(),media_url:$('afkMedia').value.trim()})});$('afkStatus').textContent='ACTIVE';flash('afkStatus','ACTIVE · profile saved');}catch(e){flash('afkStatus',`ERROR · ${e.message}`,true);}});
  $('clearAfk').addEventListener('click',async()=>{try{await fetchJson(`/api/guilds/${state.guild.id}/afk`,{method:'DELETE'});$('afkReason').value='';$('afkMedia').value='';updateAfkPreview();$('afkStatus').textContent='IDLE';}catch(e){flash('afkStatus',`ERROR · ${e.message}`,true);}});
  $('afkMedia').addEventListener('input',updateAfkPreview);$('afkReason').addEventListener('input',updateAfkPreview);
  $('sendCommand').addEventListener('click',executeCommand);$('refreshActivity').addEventListener('click',refreshActivity);
  document.querySelectorAll('[data-quick]').forEach(b=>b.addEventListener('click',()=>{$('commandName').value=b.dataset.quick;$('commandArgs').value='{}';executeCommand();}));
}
document.addEventListener('DOMContentLoaded',boot);
