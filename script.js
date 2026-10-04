const state = {
  me: null,
  guild: null,
  config: null,
  channels: [],
  socket: null,
  routes: ['home','features','dashboard','commands','docs']
};

const COMMANDS = [
  ['ping','Latency / health check','utility'],['help','Danh sách toàn bộ lệnh','utility'],['server','Thông tin server','utility'],['userinfo','Thông tin thành viên','utility'],['avatar','Avatar thành viên','utility'],['botinfo','Thông tin bot core','utility'],
  ['poll','Tạo poll 2–4 lựa chọn','community'],['8ball','Quả cầu tiên tri','fun'],['roll','Xúc xắc 2–1000 mặt','fun'],['coinflip','Tung đồng xu','fun'],['remind','Nhắc việc 5s–7 ngày','productivity'],['afk','Bật trạng thái AFK','productivity'],
  ['warn','Cảnh cáo thành viên','moderation'],['warnings','Xem cảnh cáo','moderation'],['clear','Xoá 1–100 tin nhắn','moderation'],['slowmode','Đặt slowmode','moderation'],['lock','Khoá text channel','moderation'],['unlock','Mở khoá text channel','moderation'],['kick','Kick member','moderation'],['ban','Ban member','moderation'],['timeout','Timeout member','moderation'],['role','Add / remove role','moderation'],['announce','Thông báo embed','community'],
  ['vc-join','Bot vào voice channel','voice'],['vc-leave','Bot rời voice','voice'],['auto-voice','Tự động giữ voice + reconnect','voice']
];

document.addEventListener('DOMContentLoaded', () => {
  setupNavigation(); setupVisuals(); renderCommandLibrary(); renderCommandList(); setupControls(); boot();
});

function setupNavigation(){
  document.querySelectorAll('[data-route]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); navigate(a.dataset.route); }));
  const initial = location.hash.replace('#','') || 'home';
  navigate(state.routes.includes(initial) ? initial : 'home', false);
  window.addEventListener('popstate', () => navigate(location.hash.replace('#','') || 'home', false));
}
function navigate(route, push=true){
  if(!state.routes.includes(route)) route='home';
  if(push) history.pushState({},'',`#${route}`);
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view===route));
  document.querySelectorAll('[data-route]').forEach(a => a.classList.toggle('active', a.dataset.route===route));
  if(route==='dashboard') refreshDashboard();
}

function setupVisuals(){
  const canvas = document.getElementById('space'); const ctx=canvas.getContext('2d'); const glow=document.getElementById('cursorGlow'); const orbital=document.getElementById('orbital');
  const dots=[]; let width=innerWidth,height=innerHeight,dpr=Math.min(devicePixelRatio||1,2);
  function resize(){width=innerWidth;height=innerHeight;canvas.width=width*dpr;canvas.height=height*dpr;canvas.style.width=width+'px';canvas.style.height=height+'px';ctx.setTransform(dpr,0,0,dpr,0,0);dots.length=0;for(let i=0;i<Math.min(95,Math.floor(width/12));i++)dots.push({x:Math.random()*width,y:Math.random()*height,z:Math.random()*.9+.1,r:Math.random()*1.4+.2,v:(Math.random()-.5)*.08});}
  function frame(){ctx.clearRect(0,0,width,height);for(const p of dots){p.y-=p.v*2;if(p.y<-10)p.y=height+10; if(p.y>height+10)p.y=-10;ctx.globalAlpha=.1+p.z*.35;ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(p.x,p.y,p.r*p.z,0,Math.PI*2);ctx.fill();}ctx.globalAlpha=1;requestAnimationFrame(frame)} resize(); frame(); addEventListener('resize',resize);
  addEventListener('pointermove',e=>{glow.style.left=e.clientX+'px';glow.style.top=e.clientY+'px'; if(orbital && innerWidth>760){const rx=(e.clientY/innerHeight-.5)*-8, ry=(e.clientX/innerWidth-.5)*10; orbital.style.transform=`perspective(1000px) rotateX(${rx}deg) rotateY(${ry}deg)`;}});
  addEventListener('pointerleave',()=>{if(orbital) orbital.style.transform=''});
}

async function boot(){
  renderLoggedOut();
  try{state.me=await fetchJson('/api/me');}catch{state.me={authenticated:false};}
  updateTopStatus();
  if(state.me.authenticated){renderLoggedIn(); populateGuilds();}
  state.socket=window.io?.({transports:['websocket','polling']});
  state.socket?.on('bot-status',()=>{updateTopStatus(); if(document.querySelector('[data-view="dashboard"].active')) refreshOverview();});
  state.socket?.on('activity',item=>prependActivity(item));
  refreshOverview();
}

function renderLoggedOut(){document.getElementById('dashboardPanel').hidden=true;document.getElementById('loginGate').hidden=false;document.getElementById('authButton').textContent='Sign in';document.getElementById('dashboardAuth').innerHTML='';}
function renderLoggedIn(){document.getElementById('dashboardPanel').hidden=false;document.getElementById('loginGate').hidden=true;document.getElementById('authButton').textContent='Logout';document.getElementById('authButton').onclick=()=>location.href='/auth/logout';const u=state.me.user;document.getElementById('dashboardAuth').innerHTML=`<div style="color:#888;font-size:10px;letter-spacing:.12em">${u.googleLinked?'DISCORD LINKED':'SIGNED IN'}</div><b>${escapeHtml(u.username)}</b>${u.googleLinked?'':' <a style="display:block;margin-top:8px;color:#aaa;font-size:9px;letter-spacing:.1em" href="/auth/discord">LINK DISCORD →</a>'}`;}
function updateTopStatus(){const ready=Boolean(state.me?.bot?.ready);document.getElementById('topStatus').textContent=ready?'BOT ONLINE':'WEB ONLINE';document.querySelector('.status-pill i').style.opacity=ready?'1':'.65';}

async function refreshDashboard(){if(!state.me?.authenticated)return;await populateGuilds();await refreshOverview();}
async function populateGuilds(){
  const select=document.getElementById('guildSelect'); if(!select)return; const guilds=state.me?.guilds||[];
  if(!guilds.length){select.innerHTML='<option>No manageable server</option>'; document.getElementById('dashboardPanel').innerHTML='<div class="dashboard-empty glass" style="min-height:520px"><div class="empty-orbit"><span>!</span></div><h3>No manageable server</h3><p>Discord account đã đăng nhập nhưng bot chưa ở server có quyền quản lý. Hãy invite bot vào server rồi reload.</p></div>'; return;}
  if(!state.guild || !guilds.some(g=>g.id===state.guild?.id))state.guild=guilds[0];
  select.innerHTML=guilds.map(g=>`<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');select.value=state.guild.id;select.onchange=()=>{state.guild=guilds.find(g=>g.id===select.value);loadGuild();};await loadGuild();
}
async function loadGuild(){if(!state.guild)return;const data=await fetchJson(`/api/guilds/${state.guild.id}/config`);state.config=data.config;document.getElementById('metricMembers').textContent=data.stats.members;document.getElementById('metricChannels').textContent=data.stats.channels;document.getElementById('metricPing').textContent=data.stats.ping+'ms';document.getElementById('metricCommands').textContent=state.me.bot.commands||COMMANDS.length;document.getElementById('autoVoice').checked=!!state.config.auto_voice_enabled;await loadChannels();await refreshActivity();setVoiceMatrix();}
async function loadChannels(){const data=await fetchJson(`/api/guilds/${state.guild.id}/channels`);state.channels=data.channels||[];const voices=state.channels.filter(c=>[2,13].includes(c.type));const texts=state.channels.filter(c=>[0,5].includes(c.type));document.getElementById('voiceChannel').innerHTML=voices.length?voices.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join(''):'<option value="">No voice channel</option>';if(state.config?.auto_voice_channel_id)document.getElementById('voiceChannel').value=state.config.auto_voice_channel_id;document.getElementById('textChannel').innerHTML=texts.length?texts.map(c=>`<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join(''):'<option value="">No text channel</option>';}
async function refreshOverview(){try{const data=await fetchJson('/api/overview');document.getElementById('heroCommands').textContent=data.bot.commands;document.getElementById('heroPing').textContent=data.bot.ready?data.bot.ping+'ms':'—';document.getElementById('metricPing').textContent=data.bot.ready?data.bot.ping+'ms':'—';document.getElementById('metricCommands').textContent=data.bot.commands;document.getElementById('matrixGateway').textContent=data.bot.ready?'connected':'waiting';document.getElementById('matrixDb').textContent=data.persistence;document.getElementById('botDot').classList.toggle('on',data.bot.ready);document.getElementById('matrixVoice').textContent=data.bot.ready?'ready':'standby';}catch{}}

function setupControls(){
  document.getElementById('authButton').onclick=()=>navigate('dashboard');
  document.getElementById('saveVoice').onclick=async()=>{try{const enabled=document.getElementById('autoVoice').checked;const channelId=document.getElementById('voiceChannel').value;await fetchJson(`/api/guilds/${state.guild.id}/config`,{method:'PUT',body:JSON.stringify({auto_voice_enabled:enabled,auto_voice_channel_id:channelId})});flash('responseBox','AUTO VOICE '+(enabled?'ENABLED + JOINED':'DISABLED'));setVoiceMatrix();}catch(e){flash('responseBox','ERROR · '+e.message,true)}};
  document.getElementById('leaveVoice').onclick=async()=>{try{await fetchJson(`/api/guilds/${state.guild.id}/voice/leave`,{method:'POST'});flash('responseBox','VOICE · LEFT');}catch(e){flash('responseBox','ERROR · '+e.message,true)}};
  document.getElementById('sendCommand').onclick=executeWebCommand;
  document.querySelectorAll('[data-quick]').forEach(btn=>btn.onclick=()=>{document.getElementById('commandName').value=btn.dataset.quick;document.getElementById('commandArgs').value='{}';executeWebCommand();});
  document.getElementById('refreshActivity').onclick=refreshActivity;
}
async function executeWebCommand(){
  if(!state.guild)return;const name=document.getElementById('commandName').value.trim().replace(/^\//,'');if(!name)return flash('commandResponse','ENTER A COMMAND',true);let args={};try{args=JSON.parse(document.getElementById('commandArgs').value||'{}');}catch{return flash('commandResponse','INVALID JSON ARGS',true)}
  try{const data=await fetchJson(`/api/guilds/${state.guild.id}/command`,{method:'POST',body:JSON.stringify({name,args,channelId:document.getElementById('textChannel').value})});flash('commandResponse',`EXECUTED /${data.command} · ${data.messageId?'message '+data.messageId:'done'}`);await refreshActivity();}catch(e){flash('commandResponse','ERROR · '+e.message,true)}
}
function setVoiceMatrix(){document.getElementById('matrixVoice').textContent=document.getElementById('autoVoice').checked?'auto':'manual';}
async function refreshActivity(){if(!state.me?.authenticated)return;try{const data=await fetchJson('/api/activity');const list=document.getElementById('activityList');if(!data.items?.length){list.innerHTML='<div class="activity-empty">No events yet.</div>';return;}list.innerHTML=data.items.slice(0,15).map(activityHtml).join('');}catch{}}
function prependActivity(item){const list=document.getElementById('activityList');if(!list||list.querySelector('.activity-empty')){if(list)list.innerHTML=activityHtml(item);return;}list.insertAdjacentHTML('afterbegin',activityHtml(item));while(list.children.length>15)list.lastElementChild.remove();}
function activityHtml(x){const date=new Date(x.created_at||Date.now());return `<div class="activity-item"><time>${date.toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'})}</time><div><b>${escapeHtml(x.action||'event')}</b><p>${escapeHtml(String(x.details||''))}</p></div></div>`}

function renderCommandLibrary(){const el=document.getElementById('commandLibrary');el.innerHTML=COMMANDS.map(([n,d,t],i)=>`<article class="cmd-card"><span class="badge">${t.toUpperCase()}</span><code>/${n}</code><p>${d}</p></article>`).join('');}
function renderCommandList(){document.getElementById('commandList').innerHTML=COMMANDS.map(([n])=>`<option value="${n}"></option>`).join('');}
function flash(id,text,error=false){const el=document.getElementById(id);el.textContent=text;el.style.color=error?'#fff':'#aaa';setTimeout(()=>{if(el)el.style.color='#6c6c6c'},2500)}
async function fetchJson(url,options={}){const init={...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}};const r=await fetch(url,init);let data=null;try{data=await r.json()}catch{}if(!r.ok)throw new Error(data?.error||`HTTP ${r.status}`);return data}
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
