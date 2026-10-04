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
  ['poll','Tạo poll 2–4 lựa chọn','community'],['8ball','Quả cầu tiên tri','fun'],['roll','Xúc xắc 2–1000 mặt','fun'],['coinflip','Tung đồng xu','fun'],['remind','Nhắc việc 5s–7 ngày','productivity'],['afk','AFK + ảnh/GIF riêng','productivity'],
  ['warn','Cảnh cáo thành viên','moderation'],['warnings','Xem cảnh cáo','moderation'],['clear','Xoá 1–100 tin nhắn','moderation'],['slowmode','Đặt slowmode','moderation'],['lock','Khoá text channel','moderation'],['unlock','Mở khoá text channel','moderation'],['kick','Kick member','moderation'],['ban','Ban member','moderation'],['timeout','Timeout member','moderation'],['role','Add / remove role','moderation'],['announce','Thông báo embed','community'],
  ['vc-join','Bot vào voice channel','voice'],['vc-leave','Bot rời voice','voice'],['auto-voice','Tự động giữ voice + reconnect','voice']
];

const $ = id => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupVisuals();
  renderCommandLibrary();
  renderCommandList();
  setupControls();
  boot();
});

function setupNavigation(){
  document.querySelectorAll('[data-route]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); navigate(a.dataset.route); }));
  const initial = location.hash.replace('#','') || 'home';
  navigate(state.routes.includes(initial) ? initial : 'home', false);
  window.addEventListener('popstate', () => navigate(location.hash.replace('#','') || 'home', false));
}
function navigate(route, push=true){
  if(!state.routes.includes(route)) route='home';
  const current = document.querySelector('.view.active');
  const next = document.querySelector(`.view[data-view="${route}"]`);
  if(!next) return;
  if(current && current !== next){
    document.body.classList.remove('route-pulse');
    void document.body.offsetWidth;
    document.body.classList.add('route-pulse');
  }
  if(push) history.pushState({},'',`#${route}`);
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v === next));
  document.querySelectorAll('[data-route]').forEach(a => a.classList.toggle('active', a.dataset.route===route));
  window.scrollTo({top:0,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  if(route==='dashboard') refreshDashboard();
}

function setupVisuals(){
  const canvas = $('space');
  const ctx = canvas?.getContext('2d');
  const glow = $('cursorGlow');
  const stage = $('orbital');
  if(!ctx) return;
  const stars=[]; const streaks=[];
  let width=innerWidth,height=innerHeight,dpr=Math.min(devicePixelRatio||1,2);
  function resize(){
    width=innerWidth;height=innerHeight;canvas.width=width*dpr;canvas.height=height*dpr;canvas.style.width=width+'px';canvas.style.height=height+'px';ctx.setTransform(dpr,0,0,dpr,0,0);
    stars.length=0; streaks.length=0;
    const count=Math.min(150,Math.floor(width/7));
    for(let i=0;i<count;i++) stars.push({x:Math.random()*width,y:Math.random()*height,z:Math.random()*.95+.05,r:Math.random()*1.4+.2,v:(Math.random()-.5)*.24});
    for(let i=0;i<12;i++) streaks.push({x:Math.random()*width,y:Math.random()*height,len:Math.random()*90+30,v:Math.random()*0.5+.15,a:Math.random()*.22+.05});
  }
  function frame(t){
    ctx.clearRect(0,0,width,height);
    const pulse=(Math.sin(t*.0007)+1)/2;
    for(const p of stars){
      p.y-=p.v; if(p.y<-8)p.y=height+8; if(p.y>height+8)p.y=-8;
      ctx.globalAlpha=.05+p.z*.30; ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(p.x,p.y,p.r*p.z,0,Math.PI*2); ctx.fill();
    }
    ctx.lineWidth=1;
    for(const s of streaks){
      s.x += s.v*1.8; s.y += s.v*.55; if(s.x>width+120){s.x=-120;s.y=Math.random()*height}
      ctx.globalAlpha=s.a*(.7+pulse*.6); ctx.strokeStyle='#fff'; ctx.beginPath(); ctx.moveTo(s.x,s.y); ctx.lineTo(s.x-s.len,s.y-s.len*.22); ctx.stroke();
    }
    ctx.globalAlpha=1; requestAnimationFrame(frame);
  }
  resize(); requestAnimationFrame(frame); addEventListener('resize',resize);
  addEventListener('pointermove',e=>{
    if(glow){glow.style.left=e.clientX+'px';glow.style.top=e.clientY+'px'}
    if(stage && innerWidth>760){
      const rx=(e.clientY/innerHeight-.5)*-7, ry=(e.clientX/innerWidth-.5)*10;
      stage.style.transform=`perspective(1500px) rotateX(${rx}deg) rotateY(${ry}deg)`;
    }
  });
  addEventListener('pointerleave',()=>{if(stage) stage.style.transform=''});
}

function setupTilt(){
  const items=[...document.querySelectorAll('.tilt')];
  items.forEach(el=>{
    el.addEventListener('pointermove',e=>{
      if(innerWidth<900 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const r=el.getBoundingClientRect(), x=(e.clientX-r.left)/r.width-.5, y=(e.clientY-r.top)/r.height-.5;
      el.style.transform=`perspective(900px) rotateX(${(-y*5).toFixed(2)}deg) rotateY(${(x*6).toFixed(2)}deg) translateY(-5px)`;
    });
    el.addEventListener('pointerleave',()=>{el.style.transform=''});
  });
}

async function boot(){
  renderLoggedOut();
  try{state.me=await fetchJson('/api/me');}catch{state.me={authenticated:false};}
  updateTopStatus();
  if(state.me.authenticated){renderLoggedIn(); populateGuilds();}
  state.socket=window.io?.({transports:['websocket','polling']});
  state.socket?.on('bot-status',()=>{updateTopStatus(); refreshOverview();});
  state.socket?.on('activity',item=>prependActivity(item));
  refreshOverview();
}

function renderLoggedOut(){
  const panel=$('dashboardPanel'), gate=$('loginGate');
  if(panel) panel.hidden=true; if(gate) gate.hidden=false;
  $('authButton').textContent='Sign in'; $('dashboardAuth').innerHTML='';
}
function renderLoggedIn(){
  $('dashboardPanel').hidden=false; $('loginGate').hidden=true;
  $('authButton').textContent='Logout'; $('authButton').onclick=()=>location.href='/auth/logout';
  const u=state.me.user;
  $('dashboardAuth').innerHTML=`<div class="auth-kicker">${u.provider==='discord' || u.discordId ? 'DISCORD LINKED' : 'SIGNED IN'}</div><b>${escapeHtml(u.username)}</b>${u.provider==='discord' || u.discordId?'':'<a class="auth-link" href="/auth/discord">LINK DISCORD →</a>'}`;
}
function updateTopStatus(){
  const ready=Boolean(state.me?.bot?.ready); $('topStatus').textContent=ready?'BOT ONLINE':'WEB ONLINE';
  const dot=document.querySelector('.status-pill i'); if(dot) dot.style.opacity=ready?'1':'.65';
}

async function refreshDashboard(){if(!state.me?.authenticated)return;await populateGuilds();await refreshOverview();}
async function populateGuilds(){
  const select=$('guildSelect'); if(!select)return;
  const guilds=state.me?.guilds||[];
  if(!guilds.length){
    select.innerHTML='<option>No manageable server</option>';
    $('dashboardPanel').innerHTML='<div class="dashboard-empty glass"><div class="empty-orbit"><span>!</span></div><h3>No manageable server</h3><p>Discord account đã đăng nhập nhưng bot chưa ở server có quyền quản lý. Invite bot vào server rồi reload.</p></div>';
    return;
  }
  if(!state.guild || !guilds.some(g=>g.id===state.guild?.id))state.guild=guilds[0];
  select.innerHTML=guilds.map(g=>`<option value="${g.id}">${escapeHtml(g.name)}</option>`).join(''); select.value=state.guild.id;
  select.onchange=()=>{state.guild=guilds.find(g=>g.id===select.value);loadGuild();};
  await loadGuild();
}
async function loadGuild(){
  if(!state.guild)return;
  const data=await fetchJson(`/api/guilds/${state.guild.id}/config`);
  state.config=data.config;
  $('metricMembers').textContent=data.stats.members; $('metricChannels').textContent=data.stats.channels; $('metricPing').textContent=data.stats.ping+'ms'; $('metricCommands').textContent=state.me.bot.commands||COMMANDS.length;
  $('autoVoice').checked=!!state.config.auto_voice_enabled;
  await loadChannels(); await refreshActivity(); await loadAfk(); setVoiceMatrix();
}
async function loadChannels(){
  const data=await fetchJson(`/api/guilds/${state.guild.id}/channels`); state.channels=data.channels||[];
  const voices=state.channels.filter(c=>[2,13].includes(c.type)); const texts=state.channels.filter(c=>[0,5].includes(c.type));
  $('voiceChannel').innerHTML=voices.length?voices.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join(''):'<option value="">No voice channel</option>';
  if(state.config?.auto_voice_channel_id)$('voiceChannel').value=state.config.auto_voice_channel_id;
  $('textChannel').innerHTML=texts.length?texts.map(c=>`<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join(''):'<option value="">No text channel</option>';
}
async function refreshOverview(){
  try{
    const data=await fetchJson('/api/overview');
    $('heroCommands').textContent=data.bot.commands; $('heroPing').textContent=data.bot.ready?data.bot.ping+'ms':'—'; $('metricPing').textContent=data.bot.ready?data.bot.ping+'ms':'—'; $('metricCommands').textContent=data.bot.commands;
    $('matrixGateway').textContent=data.bot.ready?'connected':'waiting'; $('matrixDb').textContent=data.persistence; $('matrixVoice').textContent=data.bot.ready?'ready':'standby'; $('botDot').classList.toggle('on',data.bot.ready);
  }catch{}
}

async function loadAfk(){
  if(!state.guild || !$('afkStatus'))return;
  try{
    const data=await fetchJson(`/api/guilds/${state.guild.id}/afk`);
    if(data.active){
      $('afkReason').value=data.afk.reason||''; $('afkMedia').value=data.afk.media_url||''; updateAfkPreview();
      $('afkStatus').textContent=`ACTIVE · since ${new Date(Number(data.afk.since)).toLocaleString('vi-VN')}`;
    }else{
      $('afkReason').value=''; $('afkMedia').value=''; updateAfkPreview(); $('afkStatus').textContent='IDLE · ready to build your notice';
    }
  }catch(e){$('afkStatus').textContent=e.message==='DISCORD_LINK_REQUIRED'?'LINK DISCORD ĐỂ DÙNG AFK STUDIO':'AFK · unavailable'}
}

function setupControls(){
  $('authButton').onclick=()=>navigate('dashboard');
  $('saveVoice').onclick=async()=>{try{const enabled=$('autoVoice').checked;const channelId=$('voiceChannel').value;await fetchJson(`/api/guilds/${state.guild.id}/config`,{method:'PUT',body:JSON.stringify({auto_voice_enabled:enabled,auto_voice_channel_id:channelId})});flash('responseBox','AUTO VOICE '+(enabled?'ENABLED + JOINED':'DISABLED'));setVoiceMatrix();}catch(e){flash('responseBox','ERROR · '+e.message,true)}};
  $('leaveVoice').onclick=async()=>{try{await fetchJson(`/api/guilds/${state.guild.id}/voice/leave`,{method:'POST'});flash('responseBox','VOICE · LEFT');}catch(e){flash('responseBox','ERROR · '+e.message,true)}};
  $('saveAfk').onclick=saveAfk;
  $('clearAfk').onclick=clearAfk;
  $('afkMedia').addEventListener('input', updateAfkPreview);
  $('afkMedia').addEventListener('change', updateAfkPreview);
  $('sendCommand').onclick=executeWebCommand;
  document.querySelectorAll('[data-quick]').forEach(btn=>btn.onclick=()=>{$('commandName').value=btn.dataset.quick;$('commandArgs').value='{}';executeWebCommand();});
  $('refreshActivity').onclick=refreshActivity;
}
async function saveAfk(){
  if(!state.guild)return;
  try{
    const reason=$('afkReason').value.trim(); const media_url=$('afkMedia').value.trim();
    await fetchJson(`/api/guilds/${state.guild.id}/afk`,{method:'PUT',body:JSON.stringify({reason,media_url})});
    $('afkStatus').textContent='ACTIVE · AFK profile saved'; flash('afkStatus','ACTIVE · AFK profile saved');
  }catch(e){flash('afkStatus','ERROR · '+e.message,true)}
}
async function clearAfk(){
  if(!state.guild)return;
  try{await fetchJson(`/api/guilds/${state.guild.id}/afk`,{method:'DELETE'});$('afkReason').value='';$('afkMedia').value='';flash('afkStatus','IDLE · I\'M BACK');}
  catch(e){flash('afkStatus','ERROR · '+e.message,true)}
}
async function executeWebCommand(){
  if(!state.guild)return;
  const name=$('commandName').value.trim().replace(/^\//,''); if(!name)return flash('commandResponse','ENTER A COMMAND',true);
  let args={}; try{args=JSON.parse($('commandArgs').value||'{}')}catch{return flash('commandResponse','INVALID JSON ARGS',true)}
  try{
    const data=await fetchJson(`/api/guilds/${state.guild.id}/command`,{method:'POST',body:JSON.stringify({name,args,channelId:$('textChannel').value})});
    flash('commandResponse',`EXECUTED /${data.command} · ${data.messageId?'message '+data.messageId:'done'}`); await refreshActivity();
  }catch(e){flash('commandResponse','ERROR · '+e.message,true)}
}
function setVoiceMatrix(){if($('matrixVoice')) $('matrixVoice').textContent=$('autoVoice').checked?'auto':'manual';}
function updateAfkPreview(){const url=$('afkMedia')?.value.trim();const box=$('afkPreview'),img=$('afkPreviewImage');if(!box||!img)return;if(!url){box.hidden=true;img.removeAttribute('src');return}img.onload=()=>{box.hidden=false};img.onerror=()=>{box.hidden=true;img.removeAttribute('src')};img.src=url;}
async function refreshActivity(){
  if(!state.me?.authenticated)return;
  try{const data=await fetchJson('/api/activity');const list=$('activityList');if(!data.items?.length){list.innerHTML='<div class="activity-empty">No events yet.</div>';return;}list.innerHTML=data.items.slice(0,15).map(activityHtml).join('')}catch{}
}
function prependActivity(item){const list=$('activityList');if(!list)return;if(list.querySelector('.activity-empty'))list.innerHTML=activityHtml(item);else list.insertAdjacentHTML('afterbegin',activityHtml(item));while(list.children.length>15)list.lastElementChild.remove()}
function activityHtml(x){const date=new Date(x.created_at||Date.now());return `<div class="activity-item"><time>${date.toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'})}</time><div><b>${escapeHtml(x.action||'event')}</b><p>${escapeHtml(String(x.details||''))}</p></div></div>`}

function renderCommandLibrary(){$('commandLibrary').innerHTML=COMMANDS.map(([n,d,t])=>`<article class="cmd-card tilt reveal"><span class="badge">${t.toUpperCase()}</span><code>/${n}</code><p>${d}</p></article>`).join('');setupTilt()}
function renderCommandList(){$('commandList').innerHTML=COMMANDS.map(([n])=>`<option value="${n}"></option>`).join('')}
function flash(id,text,error=false){const el=$(id);if(!el)return;el.textContent=text;el.style.color=error?'#fff':'#aaa';clearTimeout(el._flash);el._flash=setTimeout(()=>{if(el)el.style.color='#696969'},2600)}
async function fetchJson(url,options={}){const init={...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}};const r=await fetch(url,init);let data=null;try{data=await r.json()}catch{}if(!r.ok)throw new Error(data?.error||`HTTP ${r.status}`);return data}
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
