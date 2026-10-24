const ROUTES=['home','features','dashboard','commands','docs'];
const COMMANDS=[['ping','Check bot latency'],['help','Show command help'],['server','Server overview'],['userinfo','Inspect a member'],['avatar','Show a member avatar'],['botinfo','Bot runtime info'],['rank','Level and XP'],['balance','View coins'],['daily','Claim daily coins'],['work','Work for coins'],['leaderboard','Level and coin rankings'],['welcome-setup','Configure welcome channel'],['goodbye-setup','Configure goodbye channel'],['poll','Create a reaction poll'],['8ball','Ask the anime orb'],['roll','Roll a random number'],['coinflip','Flip a coin'],['remind','Create a reminder'],['afk','Set AFK with optional image/GIF'],['warn','Warn a member'],['warnings','List member warnings'],['clear','Delete recent messages'],['slowmode','Set channel slowmode'],['lock','Lock a channel'],['unlock','Unlock a channel'],['kick','Kick a member'],['ban','Ban a member'],['timeout','Timeout a member'],['role','Add or remove a role'],['legit','Staff-only ✅ legit verification'],['ticket-setup','Post private ticket panel'],['role-panel','Post self-service emoji roles'],['announce','Send a styled announcement'],['vc-join','Join a voice channel'],['vc-leave','Leave voice'],['auto-voice','Toggle automatic voice recovery']];
const state={route:'home',me:null,guild:null,config:null,roles:[],channels:[],commandDefinitions:[],commandMembers:[],commandMembersGuild:null,socket:null};
const $=id=>document.getElementById(id);
function escapeHtml(v=''){return String(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
async function fetchJson(url,options={}){const res=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(options.headers||{})},...options});const text=await res.text();let data={};try{data=JSON.parse(text)}catch{if(!res.ok)throw new Error(text||`HTTP ${res.status}`)}if(!res.ok){const code=data.error||`HTTP ${res.status}`;if(code==='NOT_AUTHENTICATED'){const wasAuthenticated=Boolean(state.me?.authenticated);state.me={authenticated:false};state.guild=null;state.config=null;state.socket?.disconnect();renderLoggedOut();if(wasAuthenticated)showToast('Phiên đăng nhập đã hết hạn. Hãy đăng nhập Discord lại.');throw new Error('Phiên đăng nhập đã hết hạn. Hãy đăng nhập Discord lại rồi thử lần nữa.')}throw new Error(data.message||code)}return data;}
function showRoute(route,push=true){if(!ROUTES.includes(route))route='home';state.route=route;document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.dataset.page===route));document.querySelectorAll('[data-route]').forEach(el=>el.classList.toggle('active',el.dataset.route===route));if(push&&location.hash.slice(1)!==route)history.pushState({},'',`#${route}`);const flash=$('transitionFlash');if(flash){flash.classList.remove('run');void flash.offsetWidth;flash.classList.add('run')}window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});if(route==='dashboard')refreshDashboard();}
function setupRoutes(){document.querySelectorAll('[data-route]').forEach(el=>el.addEventListener('click',e=>{const route=el.dataset.route;if(!route)return;if(el.tagName==='A')e.preventDefault();showRoute(route,true)}));addEventListener('hashchange',()=>showRoute(location.hash.slice(1)||'home',false));addEventListener('popstate',()=>showRoute(location.hash.slice(1)||'home',false));showRoute(location.hash.slice(1)||'home',false)}
function renderCommands(){$('commandCatalog').innerHTML=COMMANDS.map(([name,desc],i)=>`<article class="command-item"><code>/${escapeHtml(name)}</code><p>${escapeHtml(desc)}</p><small>#${String(i+1).padStart(2,'0')}</small></article>`).join('')}
function setupManualGallery(){const gallery=$('manualGallery');if(!gallery)return;const cards=[...gallery.querySelectorAll('.manual-card')],status=$('manualStatus'),labels={core:'01 / AKI CORE · GATEWAY + API',afk:'02 / AFK STUDIO · IMAGE + GIF',voice:'03 / VOICE CORE · RECONNECT'};cards.forEach((card,index)=>{card.addEventListener('pointermove',e=>{if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;const r=card.getBoundingClientRect(),x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;card.style.setProperty('--ry',`${x*9}deg`);card.style.setProperty('--rx',`${y*-7}deg`);card.style.setProperty('--rz',index===0?'-7deg':index===2?'7deg':'.5deg')});card.addEventListener('pointerleave',()=>{card.style.removeProperty('--ry');card.style.removeProperty('--rx')});card.addEventListener('focus',()=>card.classList.add('is-selected'));card.addEventListener('blur',()=>card.classList.remove('is-selected'));card.addEventListener('click',()=>{cards.forEach(c=>c.classList.remove('is-selected'));card.classList.add('is-selected');if(status)status.textContent=labels[card.dataset.manual]||'SELECTED';showToast(card.dataset.manual==='core'?'Aki Core selected — open Control to use it.':card.dataset.manual==='afk'?'AFK Studio selected — image/GIF ready.':'Voice Core selected — auto reconnect standby.')});card.addEventListener('keydown',e=>{if(e.key==='ArrowRight'){e.preventDefault();cards[(index+1)%cards.length].focus()}if(e.key==='ArrowLeft'){e.preventDefault();cards[(index-1+cards.length)%cards.length].focus()}})})}
function showToast(message){let t=document.querySelector('#toast');if(!t){t=document.createElement('div');t.id='toast';t.className='response-box';t.style.cssText='position:fixed;left:50%;bottom:24px;z-index:90;width:min(520px,calc(100vw - 32px));transform:translateX(-50%);background:rgba(8,8,8,.94);color:#fff;box-shadow:0 20px 60px rgba(0,0,0,.4);';document.body.appendChild(t)}clearTimeout(t._timer);t.textContent=message;t.hidden=false;t._timer=setTimeout(()=>{t.hidden=true},1800)}
function setupLivingWorld(){
 const canvas=$('space');
 if(!canvas)return;
 const coarsePointer=matchMedia('(max-width:760px), (pointer:coarse)');
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 // The page keeps its static CSS ambience on phones; avoid a continuously painted fullscreen canvas.
 if(coarsePointer.matches){canvas.style.display='none';return;}
 const ctx=canvas.getContext('2d');if(!ctx)return;
 let w=innerWidth,h=innerHeight,dpr=1,time=0,particles=[],roots=[],windX=0,windY=0,raf=0,lastFrame=0,visible=!document.hidden;
 const seed=()=>{const mobile=innerWidth<=760;particles=Array.from({length:Math.min(mobile?24:110,Math.round(w/(mobile?16:10)))},()=>({x:Math.random()*w,y:Math.random()*h,z:Math.random(),s:Math.random()*1.1+.25,a:Math.random()*.38+.08,p:Math.random()*Math.PI*2}));roots=Array.from({length:mobile?0:10},(_,i)=>({a:(Math.PI*2*i)/10+Math.random()*.2,len:80+Math.random()*230,phase:Math.random()*Math.PI*2}));};
 const resize=()=>{w=innerWidth;h=innerHeight;dpr=Math.min(devicePixelRatio||1,1.5);canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);canvas.style.width=w+'px';canvas.style.height=h+'px';ctx.setTransform(dpr,0,0,dpr,0,0);seed();};
 function drawRoots(cx,cy){ctx.save();ctx.translate(cx,cy);roots.forEach((r,i)=>{const a=r.a+Math.sin(time*.00055+r.phase)*.06;const len=r.len*(.84+.16*Math.sin(time*.001+r.phase));let x=0,y=0;ctx.beginPath();ctx.moveTo(x,y);for(let j=0;j<7;j++){const t=(j+1)/7;const bend=Math.sin(time*.0012+r.phase+j*.65+windX)*.18;const ang=a+bend*(1-t)*.9;x+=Math.cos(ang)*len/7;y+=Math.sin(ang)*len/7;ctx.lineTo(x,y)}ctx.strokeStyle='rgba(245,245,240,.045)';ctx.lineWidth=1;ctx.stroke();});ctx.restore();}
 function frame(t){if(!visible||document.hidden)return;if(!reduced.matches&&t-lastFrame<33){raf=requestAnimationFrame(frame);return;}lastFrame=t;time=t;ctx.clearRect(0,0,w,h);const cx=w*.72,cy=h*.52;const grad=ctx.createRadialGradient(cx,cy,10,cx,cy,Math.min(w,h)*.46);grad.addColorStop(0,'rgba(255,255,255,.03)');grad.addColorStop(.45,'rgba(255,255,255,.01)');grad.addColorStop(1,'rgba(255,255,255,0)');ctx.fillStyle=grad;ctx.fillRect(0,0,w,h);drawRoots(cx,cy);particles.forEach((p,i)=>{if(!reduced.matches){p.y-=p.s*(.55+p.z);p.x+=Math.sin(time*.00055+p.p)*.1+windX*.01;}if(p.y<-10){p.y=h+10;p.x=Math.random()*w;}if(p.x>w+10)p.x=-10;if(p.x<-10)p.x=w+10;const size=.4+p.z*1.2;ctx.globalAlpha=p.a*(.55+p.z*.45);ctx.fillStyle=i%21===0?'#fff':'#d7d7d3';ctx.beginPath();ctx.arc(p.x,p.y,size,0,Math.PI*2);ctx.fill();});ctx.globalAlpha=1;if(!reduced.matches)raf=requestAnimationFrame(frame);}
 const start=()=>{if(visible&&!document.hidden&&!reduced.matches){cancelAnimationFrame(raf);raf=requestAnimationFrame(frame);}else if(visible&&!document.hidden){cancelAnimationFrame(raf);frame(performance.now());}};
 const onVisibility=()=>{visible=!document.hidden;if(visible)start();else cancelAnimationFrame(raf);};
 resize();document.addEventListener('visibilitychange',onVisibility);
 if(!coarsePointer.matches&&window.matchMedia('(hover:hover)').matches){
  addEventListener('pointermove',e=>{windX=(e.clientX/w-.5)*1.8;windY=(e.clientY/h-.5)*1.8;document.documentElement.style.setProperty('--mx',`${windX*8}px`);document.documentElement.style.setProperty('--my',`${windY*6}px`);const glow=$('cursorGlow');if(glow){glow.style.left=e.clientX+'px';glow.style.top=e.clientY+'px';}},{passive:true});
  addEventListener('pointerleave',()=>{windX=windY=0},{passive:true});
 }
 addEventListener('resize',()=>{resize();if(visible)start();},{passive:true});
 start();
}
function renderLoggedOut(){$('dashboardPanel').hidden=true;$('loginGate').hidden=false;$('authButton').textContent='SIGN IN';$('authButton').onclick=()=>showRoute('dashboard');$('dashboardAuth').innerHTML=''}
function renderLoggedIn(){$('dashboardPanel').hidden=false;$('loginGate').hidden=true;$('authButton').textContent='LOGOUT';$('authButton').onclick=()=>location.href='/auth/logout';const u=state.me.user||{};$('dashboardAuth').innerHTML=`<div class="auth-kicker">${u.provider==='discord'||u.discordId?'DISCORD LINKED':'SIGNED IN'}</div><b>${escapeHtml(u.username||'Aki user')}</b>${u.provider==='discord'||u.discordId?'':'<a class="auth-link" href="/auth/discord">LINK DISCORD →</a>'}`}
function updateTop(){const ready=!!state.me?.bot?.ready;$('topStatus').textContent=ready?'BOT ONLINE':'WEB ONLINE';$('heroPing').textContent=ready?`${state.me.bot.ping}ms`:'—'}
async function refreshPublicStats(){try{const data=await fetchJson('/api/public/stats');if($('publicGuildCount'))$('publicGuildCount').textContent=String(data.guilds??'—');if($('publicCommandCount'))$('publicCommandCount').textContent=String(data.commands??'—');if($('publicBotStatus'))$('publicBotStatus').textContent=data.botReady?'BOT ONLINE':'BOT OFFLINE'}catch{if($('publicBotStatus'))$('publicBotStatus').textContent='WEB ONLINE'}}
async function boot(){renderCommands();setupRoutes();setupLivingWorld();setupManualGallery();setupControls();refreshPublicStats();try{const commandData=await fetchJson('/api/commands');state.commandDefinitions=commandData.commands||[];const list=$('commandNameOptions');if(list)list.innerHTML=state.commandDefinitions.map(command=>'<option value="'+escapeHtml(command.name)+'">'+escapeHtml(command.description||'')+'</option>').join('');renderDynamicCommandForm()}catch{}$('refreshGuilds')?.addEventListener('click',refreshGuildList);renderLoggedOut();try{state.me=await fetchJson('/api/me')}catch{state.me={authenticated:false}}if(state.me.authenticated){renderLoggedIn();renderGuildHint();await populateGuilds()}updateTop();refreshOverview();if(window.io&&state.me.authenticated){state.socket=io({transports:['websocket','polling']});state.socket.on('connect',watchCurrentGuild);state.socket.on('bot-status',refreshOverview);state.socket.on('activity',row=>{if(state.route==='dashboard'&&state.guild&&row?.guild_id===state.guild.id)refreshActivity()});state.socket.on('socket-error',data=>showToast('Realtime: '+(data?.error||'lỗi kết nối')))}}
function watchCurrentGuild(){if(!state.socket)return;if(state.guild?.id&&state.guild.botPresent!==false)state.socket.emit('watch-guild',state.guild.id);else state.socket.emit('unwatch-guild')}
async function refreshOverview(){try{const d=await fetchJson('/api/overview');$('heroCommands').textContent=d.bot.commands;$('heroPing').textContent=d.bot.ready?`${d.bot.ping}ms`:'—';$('metricCommands').textContent=d.bot.commands;$('metricPing').textContent=d.bot.ready?`${d.bot.ping}ms`:'—';$('matrixGateway').textContent=d.bot.ready?'connected':'waiting';$('matrixDb').textContent=d.persistence;$('matrixVoice').textContent=d.bot.ready?'ready':'standby';$('botDot').classList.toggle('on',!!d.bot.ready);if(state.me)state.me.bot=d.bot;updateTop()}catch{}}
async function refreshGuildList(){const button=$('refreshGuilds');if(button){button.disabled=true;button.textContent='ĐANG LÀM MỚI...'}try{const fresh=await fetchJson('/api/me');state.me=fresh;if(!fresh.authenticated){renderLoggedOut();throw new Error('Phiên đăng nhập hết hạn; hãy đăng nhập Discord lại.')}renderLoggedIn();renderGuildHint();await populateGuilds();showToast('Đã làm mới danh sách server.')}catch(e){showToast('Không thể làm mới server: '+e.message)}finally{if(button){button.disabled=false;button.textContent='↻ LÀM MỚI SERVER'}}}
async function refreshDashboard(){if(!state.me?.authenticated)return;try{const fresh=await fetchJson('/api/me');if(!fresh.authenticated){state.me=fresh;renderLoggedOut();return}state.me=fresh}catch{}renderGuildHint();await populateGuilds();await refreshOverview()}
function renderGuildHint(){const el=$('guildHint'),d=state.me?.guildDiagnostics;if(!el)return;if(!(state.me?.user?.discordId||state.me?.user?.provider==='discord')||!d){el.hidden=true;return}const discordCount=Number(d.discordGuildCount)||0,botCount=Number(d.botGuildCount)||0,sharedCount=Number(d.sharedGuildCount)||0,manageableCount=Number(d.manageableGuildCount)||0,missingCount=Number(d.manageableMissingBotCount)||0;el.hidden=false;let message='🔎 Tài khoản thấy '+discordCount+' server · bot kết nối '+botCount+' · chung '+sharedCount+' · bạn có quyền quản lý '+manageableCount+'.';if(missingCount)message+=' Có '+missingCount+' server bạn quản lý chưa có bot — chọn server có nhãn “CHƯA CÓ BOT” để mở link mời bot.';if(!d.botReady)message+=' Bot đang offline trên Render.';el.textContent=message}
async function populateGuilds(){const select=$('guildSelect'),guilds=state.me?.manageableGuilds??state.me?.guilds??[];renderGuildHint();if(!select)return;if(!guilds.length){select.innerHTML='<option value="">Không tìm thấy server bạn có quyền quản lý</option>';state.guild=null;$('metricMembers').textContent='—';$('metricChannels').textContent='—';$('botInvitePanel').hidden=true;watchCurrentGuild();return}if(!state.guild||!guilds.some(g=>g.id===state.guild.id))state.guild=guilds.find(g=>g.botPresent!==false)||guilds[0];select.innerHTML=guilds.map(g=>`<option value="${g.id}">${escapeHtml(g.name)}${g.botPresent===false?' · 🤖 CHƯA CÓ BOT':''}</option>`).join('');select.value=state.guild.id;select.onchange=()=>{state.guild=guilds.find(g=>g.id===select.value);watchCurrentGuild();loadGuild()};await loadGuild();watchCurrentGuild()}
async function loadGuild(){
 if(!state.guild)return;
 if(state.guild.botPresent===false){state.config=null;state.channels=[];$('metricMembers').textContent='—';$('metricChannels').textContent='—';$('metricPing').textContent=state.me?.bot?.ready?`${state.me.bot.ping}ms`:'—';$('metricCommands').textContent=state.me?.bot?.commands||'—';$('botInvitePanel').hidden=false;$('botInviteTitle').textContent='🤖 Bot chưa có trong server này';$('botInviteDescription').textContent='Bạn có quyền quản lý “'+state.guild.name+'”, nhưng bot chưa tham gia server này. Mời bot vào trước rồi mới có thể tạo danh mục, kênh và role.';const botId=state.me?.bot?.id;const link=$('botInviteLink');if(botId){const params=new URLSearchParams({client_id:botId,permissions:'1099783334998',scope:'bot applications.commands',guild_id:state.guild.id,disable_guild_select:'true'});link.href='https://discord.com/oauth2/authorize?'+params.toString();link.hidden=false}else{link.hidden=true;$('botInviteDescription').textContent+=' Bot đang offline hoặc chưa khởi tạo; hãy kiểm tra Render rồi thử lại.'}const run=$('runBuilder');if(run)run.disabled=true;$('builderResponse').textContent='🤖 BOT NOT IN SERVER · mời bot vào server trước khi build.';$('automationStatus').textContent='🤖 Bot cần có trong server để cấu hình role và ticket.';return}
 $('botInvitePanel').hidden=true;const run=$('runBuilder');if(run)run.disabled=false;
 try{
  const d=await fetchJson(`/api/guilds/${state.guild.id}/config`);state.config=d.config;state.roles=d.roles||[];state.commandMembers=[];state.commandMembersGuild=null;
  const autoSelect=$('autoRoleSelect');if(autoSelect){autoSelect.innerHTML='<option value="">Tắt auto-role</option>'+(d.roles||[]).map(r=>`<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');autoSelect.value=d.config.auto_role_id||''}
  $('metricMembers').textContent=d.stats.members;$('metricChannels').textContent=d.stats.channels;$('metricPing').textContent=`${d.stats.ping}ms`;$('metricCommands').textContent=state.me.bot?.commands??COMMANDS.length;$('autoVoice').checked=!!d.config.auto_voice_enabled;
  await loadChannels();renderDynamicCommandForm();await loadAfk();await refreshActivity();watchCurrentGuild();
 }catch(e){flash('responseBox',e.message,true)}
}
async function loadChannels(){
 const d=await fetchJson(`/api/guilds/${state.guild.id}/channels`);state.channels=d.channels||[];
 const voice=state.channels.filter(c=>[2,13].includes(c.type)),text=state.channels.filter(c=>[0,5].includes(c.type));
 $('voiceChannel').innerHTML=voice.length?voice.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join(''):'<option value="">No voice channel</option>';if(state.config?.auto_voice_channel_id)$('voiceChannel').value=state.config.auto_voice_channel_id;
 $('textChannel').innerHTML=text.length?text.map(c=>`<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join(''):'<option value="">Default text channel</option>';
 const log=$('logChannel');if(log){log.innerHTML='<option value="">Chỉ log trên web</option>'+text.map(c=>`<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join('');log.value=state.config?.log_channel_id||''}
 for(const id of ['rolePanelChannel','ticketPanelChannel','announcementChannel']){const el=$(id);if(el){const old=el.value;el.innerHTML='<option value="">Chọn kênh text</option>'+text.map(c=>`<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join('');if(text.some(c=>c.id===old))el.value=old;else{const preferred=id==='rolePanelChannel'?'🎭・nhận-role':id==='ticketPanelChannel'?'🎫・mở-ticket':'📣・thông-báo';el.value=text.find(c=>c.name===preferred)?.id||text[0]?.id||''}}}
}
async function loadAfk(){try{const d=await fetchJson(`/api/guilds/${state.guild.id}/afk`);if(d.active){$('afkReason').value=d.afk.reason||'';$('afkMedia').value=d.afk.media_url||'';$('afkStatus').textContent='ACTIVE'}else{$('afkReason').value='';$('afkMedia').value='';$('afkStatus').textContent='IDLE'}updateAfkPreview()}catch(e){$('afkStatus').textContent=e.message==='DISCORD_LINK_REQUIRED'?'LINK DISCORD':'UNAVAILABLE'}}
function updateAfkPreview(){const reason=$('afkReason')?.value.trim()||'Your reason will appear here.';const url=$('afkMedia')?.value.trim();$('afkPreviewText').textContent=reason;const box=$('afkMediaPreview');box.innerHTML='';if(url&&/^https?:\/\//i.test(url)){const img=new Image();img.alt='AFK preview';img.onload=()=>box.appendChild(img);img.onerror=()=>{box.innerHTML='<span>MEDIA URL ERROR</span>'};img.src=url}else box.innerHTML='<span>PREVIEW / AFK MEDIA</span>'}
function flash(id,msg,error=false){const el=$(id);if(!el)return;el.textContent=msg;el.dataset.error=error?'1':'0';clearTimeout(el._t);el._t=setTimeout(()=>el.dataset.error='',3500)}
async function refreshActivity(){if(!state.guild)return;try{const d=await fetchJson('/api/activity');const allowed=state.guild.id;const items=(d.items||[]).filter(x=>!x.guild_id||x.guild_id===allowed);$('activityList').innerHTML=items.length?items.slice(0,20).map(x=>`<div class="activity-item"><b>${escapeHtml(x.action||'event')}</b><small>${escapeHtml(x.details||'')} · ${escapeHtml(new Date(x.created_at).toLocaleString('vi-VN'))}</small></div>`).join(''):'<div class="empty-line">No events yet.</div>'}catch{}}
function commandArgKey(commandName, optionName){
 const aliases={user_id:'userId',case_id:'caseId',warning_id:'warningId'};
 return aliases[optionName]||optionName;
}
function renderDynamicCommandForm(){
 const host=$('commandDynamicFields');if(!host)return;
 const name=$('commandName')?.value.trim().replace(/^\//,'').toLowerCase()||'';
 const command=state.commandDefinitions.find(item=>item.name===name);
 host.replaceChildren();
 const membersNeeded=Boolean(command?.options?.some(option=>option.type===6));
 const hint=document.createElement('p');hint.className='tiny-note';
 if(!command){hint.textContent='Chọn lệnh trong danh sách để sinh trường phù hợp. Có thể dùng JSON nâng cao nếu cần.';host.append(hint);return}
 hint.textContent=command.description||'Điền các trường cho lệnh /'+name+'.';host.append(hint);
 if(membersNeeded&&state.guild?.botPresent!==false&&state.commandMembersGuild!==state.guild?.id){
   loadCommandMembers().catch(()=>{});
 }
 for(const option of (command.options||[])){
   if(option.type===1||option.type===2)continue;
   if(option.type===11){const note=document.createElement('p');note.className='tiny-note';note.textContent='Trường đính kèm file không hỗ trợ qua web; hãy dùng lệnh Discord trực tiếp.';host.append(note);continue}
   const label=document.createElement('label');label.className='command-dynamic-field';
   const caption=document.createElement('span');caption.textContent=(option.description||option.name)+(option.required?' · BẮT BUỘC':'');label.append(caption);
   let control;
   if(option.type===6 && state.commandMembers.length){
     control=document.createElement('select');const empty=document.createElement('option');empty.value='';empty.textContent='Chọn thành viên…';control.append(empty);
     for(const member of state.commandMembers){const item=document.createElement('option');item.value=member.id;item.textContent=member.label+' · '+member.id;control.append(item)}
   }else if(option.type===7){
     control=document.createElement('select');const empty=document.createElement('option');empty.value='';empty.textContent='Chọn kênh…';control.append(empty);
     const allowed=Array.isArray(option.channel_types)?option.channel_types:[0,2,5,13];
     for(const channel of state.channels.filter(item=>allowed.includes(item.type))){const item=document.createElement('option');item.value=channel.id;item.textContent='#'+channel.name;control.append(item)}
   }else if(option.type===8){
     control=document.createElement('select');const empty=document.createElement('option');empty.value='';empty.textContent='Chọn role…';control.append(empty);
     for(const role of state.roles){const item=document.createElement('option');item.value=role.id;item.textContent=role.name;control.append(item)}
   }else if(option.type===5){
     control=document.createElement('select');for(const [value,labelText] of [['','Chọn…'],['true','Bật'],['false','Tắt']]){const item=document.createElement('option');item.value=value;item.textContent=labelText;control.append(item)}
   }else if(Array.isArray(option.choices)&&option.choices.length){
     control=document.createElement('select');const empty=document.createElement('option');empty.value='';empty.textContent='Chọn…';control.append(empty);
     for(const choice of option.choices){const item=document.createElement('option');item.value=String(choice.value);item.textContent=choice.name;control.append(item)}
   }else{
     control=document.createElement('input');
     control.type=(option.type===4||option.type===10)?'number':'text';
     control.placeholder=option.name==='user_id'?'Discord user ID':option.name;
     if(option.min_value!==undefined)control.min=String(option.min_value);
     if(option.max_value!==undefined)control.max=String(option.max_value);
     if(option.max_length!==undefined)control.maxLength=option.max_length;
   }
   control.dataset.arg=commandArgKey(name,option.name);control.dataset.type=String(option.type);control.dataset.required=option.required?'true':'false';control.id='commandArg_'+option.name;control.name=option.name;
   if(option.required)control.required=true;
   label.append(control);host.append(label);
 }
}
async function loadCommandMembers(){
 if(!state.guild||state.guild.botPresent===false)return;
 const guildId=state.guild.id;
 const d=await fetchJson('/api/guilds/'+guildId+'/members');
 if(state.guild?.id!==guildId)return;
 state.commandMembers=d.members||[];state.commandMembersGuild=guildId;renderDynamicCommandForm();
}
function collectDynamicCommandArgs(){
 const args={};const host=$('commandDynamicFields');
 host?.querySelectorAll('[data-arg]').forEach(control=>{
  const raw=String(control.value??'').trim();if(!raw){if(control.dataset.required==='true')throw new Error('Cần điền trường '+control.name+'.');return}
  const type=Number(control.dataset.type);let value=raw;
  if(type===4||type===10){value=Number(raw);if(!Number.isFinite(value))throw new Error('Giá trị số không hợp lệ: '+control.name)}
  else if(type===5){if(!['true','false'].includes(raw))throw new Error('Hãy chọn Bật/Tắt cho '+control.name+'.');value=raw==='true'}
  args[control.dataset.arg]=value;
 });
 return args;
}
async function executeCommand(){if(!state.guild)return flash('responseBox','ERROR · SELECT A SERVER',true);try{const name=$('commandName').value.trim().replace(/^\//,'').toLowerCase();const dangerous=['ban','tempban','kick','timeout','untimeout','unban','delwarn','scam-add','role','clear','lock','unlock','vc-join','vc-leave'];if(dangerous.includes(name)&&!window.confirm('Xác nhận chạy lệnh nguy hiểm /'+name+' trên server đã chọn?'))return;let args={};const raw=$('commandArgs').value.trim();if(raw){try{args=JSON.parse(raw)}catch{throw new Error('JSON nâng cao không hợp lệ.')}}else args=collectDynamicCommandArgs();const d=await fetchJson(`/api/guilds/${state.guild.id}/command`,{method:'POST',body:JSON.stringify({name,args,channelId:$('textChannel').value||undefined})});flash('responseBox',`OK · /${d.command}\n${d.payload}`);await refreshActivity()}catch(e){flash('responseBox',`ERROR · ${e.message}`,true)}}

const BUILDER_TEMPLATES={community:{groups:[
 ['📌・BẮT ĐẦU','📜・nội-quy','👋・chào-mừng','✅・xác-minh','🎭・nhận-role','📣・thông-báo'],
 ['💬・TRÒ CHUYỆN & GIAO LƯU','💬・chat-chung','👋・giới-thiệu','🤝・làm-quen','🫶・tìm-bạn','❓・hỏi-đáp','🌏・tám-chuyện','📸・khoe-ảnh','😂・meme','🎨・sáng-tạo','🎧・chia-sẻ-nhạc','💡・ý-tưởng'],
 ['🎮・GAME & KẾT BẠN','🎮・game-chat','🧑‍🤝‍🧑・tìm-đồng-đội','🔎・tìm-party','🏆・khoe-rank','🎬・clip-game','🗓️・lịch-chơi','🕹️・game-khac','🎁・giveaway'],
 ['🛍️・BUÔN BÁN & TRADE','🛍️・chợ-giao-dịch','📦・đăng-bán','🛒・tìm-mua','🔁・trao-đổi','💬・hỏi-giá','⭐・đánh-giá-giao-dịch','✅・legit-vouches','🛡️・yêu-cầu-middleman','🚨・báo-cáo-scam'],
 ['🎉・BOT & GIẢI TRÍ','🎲・bot-commands','📊・bình-chọn','🎉・sự-kiện','🤖・bot-spam','📜・góp-ý'],
 ['🎫・HỖ TRỢ','🎫・mở-ticket','❔・faq-hỗ-trợ','🧾・hướng-dẫn-giao-dịch'],
 ['🔊・PHÒNG VOICE','🔊・voice-lounge','🎮・gaming-party-1','🎮・gaming-party-2','🎮・gaming-party-3','🤝・kết-bạn-voice','🛍️・trade-talk','🌙・chill-room','🎵・music-lounge'],
 ['🛡️・ĐỘI NGŨ','🛡️・staff-chat','🧾・staff-log','✅・legit-review','🛍️・trade-reports','🎫・ticket-staff','🔨・mod-actions']
]} };
function renderBuilderPreview(){
 const preset=$('builderPreset')?.value||'community',template=BUILDER_TEMPLATES[preset];
 if(!$('builderPreviewList'))return;
 $('builderPreviewList').innerHTML=template.groups.map(group=>'<div class="builder-preview-group"><b>'+escapeHtml(group[0])+'</b><div>'+group.slice(1).map(name=>'<span>'+escapeHtml(name)+'</span>').join('')+'</div></div>').join('');
 $('builderPreviewCount').textContent=template.groups.length+' danh mục · '+template.groups.reduce((n,g)=>n+g.length-1,0)+' kênh · 13 role';
}
async function runServerBuilder(){
 if(!state.guild)return flash('builderResponse','ERROR · HÃY CHỌN SERVER',true);
 const button=$('runBuilder');if(button)button.disabled=true;
 try{
  const preset=$('builderPreset').value,topic=$('builderTopic').value.trim();
  if(!confirm('Build template '+preset+' cho server "'+state.guild.name+'". Kênh/role đã có sẽ được giữ nguyên. Tiếp tục?'))return;
  const d=await fetchJson('/api/guilds/'+state.guild.id+'/server-builder',{method:'POST',body:JSON.stringify({preset,topic})});
  const r=d.result;
  flash('builderResponse','✅ HOÀN TẤT\nĐã tạo: '+r.categories.filter(x=>x.created).length+' danh mục · '+r.channels.length+' kênh mới · '+r.roles.filter(x=>x.created).length+' role mới ('+r.roles.length+' role tổng)\n🎭 Role panel: '+(r.automation?.rolePanel?.ok?'✅ sẵn sàng':'⚠️ chưa đăng')+' · 🎫 Ticket panel: '+(r.automation?.ticketPanel?.ok?'✅ sẵn sàng':'⚠️ chưa đăng')+'\nBỏ qua mục đã có: '+r.skipped.length+(r.warnings?.length?'\n⚠️ '+r.warnings.join('\n⚠️ '):'')+'\n'+(r.channels.map(c=>(c.type==='voice'?'🔊':'#')+' '+c.name).join('\n')||'Không có kênh mới cần tạo.'));
  await loadGuild();await refreshActivity();
 }catch(e){flash('builderResponse','ERROR · '+e.message,true)}
 finally{if(button)button.disabled=false}
}

async function saveAuditLogChannel(){if(!state.guild||state.guild.botPresent===false)return flash('auditStatus','🤖 Bot chưa có trong server này.',true);const button=$('saveAuditLog');if(button)button.disabled=true;try{const channelId=$('logChannel').value||null;const d=await fetchJson(`/api/guilds/${state.guild.id}/config`,{method:'PUT',body:JSON.stringify({log_channel_id:channelId})});state.config=d.config;flash('auditStatus',channelId?'✅ ĐÃ LƯU · log sẽ gửi tới '+($('logChannel').selectedOptions[0]?.textContent||'kênh Discord'):'✅ ĐÃ LƯU · chỉ hiển thị log trên web');}catch(e){flash('auditStatus','ERROR · '+e.message,true)}finally{if(button)button.disabled=false}}
async function saveAutoRole(){if(!state.guild||state.guild.botPresent===false)return flash('automationStatus','🤖 Bot chưa có trong server này.',true);try{const d=await fetchJson(`/api/guilds/${state.guild.id}/auto-role`,{method:'POST',body:JSON.stringify({roleId:$('autoRoleSelect').value||null})});state.config.auto_role_id=d.auto_role_id;flash('automationStatus',d.auto_role_id?'✅ ĐÃ LƯU · auto-role sẽ tự gán khi có thành viên mới.':'✅ ĐÃ TẮT AUTO-ROLE');await refreshActivity()}catch(e){flash('automationStatus','ERROR · '+e.message,true)}}
async function sendDashboardAnnouncement(){
 if(!state.guild||state.guild.botPresent===false)return flash('announcementStatus','🤖 Bot chưa có trong server này.',true);
 const channelId=$('announcementChannel').value;
 const message=$('announcementMessage').value.trim();
 if(!channelId)return flash('announcementStatus','Hãy chọn kênh thông báo.',true);
 if(!message)return flash('announcementStatus','Nội dung thông báo đang trống.',true);
 const button=$('sendAnnouncement');if(button){button.disabled=true;button.textContent='ĐANG GỬI...'}
 try{
  const data=await fetchJson('/api/guilds/'+state.guild.id+'/announce',{method:'POST',body:JSON.stringify({channelId,title:$('announcementTitle').value.trim(),message,pingEveryone:$('announcementPingEveryone').checked})});
  flash('announcementStatus','✅ ĐÃ GỬI · #'+data.channelName+' · message '+data.messageId);
  $('announcementMessage').value='';
  await refreshActivity();
 }catch(error){flash('announcementStatus','ERROR · '+error.message,true)}
 finally{if(button){button.disabled=false;button.textContent='📣 GỬI THÔNG BÁO ↗'}}
}
async function postRolePanel(){if(!state.guild||!$('rolePanelChannel').value)return flash('automationStatus','Chọn kênh text để đăng role panel.',true);try{const d=await fetchJson(`/api/guilds/${state.guild.id}/roles-panel`,{method:'POST',body:JSON.stringify({channelId:$('rolePanelChannel').value})});flash('automationStatus','✅ Role panel đã được đăng vào Discord. Message: '+d.messageId);await refreshActivity()}catch(e){flash('automationStatus','ERROR · '+e.message,true)}}
async function postTicketPanel(){if(!state.guild||!$('ticketPanelChannel').value)return flash('automationStatus','Chọn kênh text để đăng ticket panel.',true);try{const d=await fetchJson(`/api/guilds/${state.guild.id}/tickets/setup`,{method:'POST',body:JSON.stringify({channelId:$('ticketPanelChannel').value})});flash('automationStatus','✅ Ticket panel đã được đăng vào Discord. Message: '+d.messageId);await refreshActivity()}catch(e){flash('automationStatus','ERROR · '+e.message,true)}}
function setupControls(){$('sendAnnouncement')?.addEventListener('click',sendDashboardAnnouncement);$('saveAuditLog')?.addEventListener('click',saveAuditLogChannel);$('saveAutoRole')?.addEventListener('click',saveAutoRole);$('postRolePanel')?.addEventListener('click',postRolePanel);$('postTicketPanel')?.addEventListener('click',postTicketPanel);$('previewBuilder')?.addEventListener('click',renderBuilderPreview);$('builderPreset')?.addEventListener('change',renderBuilderPreview);$('runBuilder')?.addEventListener('click',runServerBuilder);renderBuilderPreview();const spark=$('sparkleControl');spark?.addEventListener('click',()=>showRoute('dashboard'));$('saveVoice')?.addEventListener('click',async()=>{try{const enabled=$('autoVoice').checked,channelId=$('voiceChannel').value;await fetchJson(`/api/guilds/${state.guild.id}/config`,{method:'PUT',body:JSON.stringify({auto_voice_enabled:enabled,auto_voice_channel_id:channelId})});flash('responseBox',enabled?'AUTO VOICE ENABLED + JOINED':'AUTO VOICE DISABLED');$('matrixVoice').textContent=enabled?'active':'standby'}catch(e){flash('responseBox',`ERROR · ${e.message}`,true)}});$('leaveVoice')?.addEventListener('click',async()=>{try{await fetchJson(`/api/guilds/${state.guild.id}/voice/leave`,{method:'POST'});flash('responseBox','VOICE · LEFT');$('matrixVoice').textContent='standby'}catch(e){flash('responseBox',`ERROR · ${e.message}`,true)}});$('saveAfk')?.addEventListener('click',async()=>{try{await fetchJson(`/api/guilds/${state.guild.id}/afk`,{method:'PUT',body:JSON.stringify({reason:$('afkReason').value.trim(),media_url:$('afkMedia').value.trim()})});$('afkStatus').textContent='ACTIVE';flash('afkStatus','ACTIVE · profile saved');updateAfkPreview()}catch(e){flash('afkStatus',`ERROR · ${e.message}`,true)}});$('clearAfk')?.addEventListener('click',async()=>{try{await fetchJson(`/api/guilds/${state.guild.id}/afk`,{method:'DELETE'});$('afkReason').value='';$('afkMedia').value='';updateAfkPreview();$('afkStatus').textContent='IDLE'}catch(e){flash('afkStatus',`ERROR · ${e.message}`,true)}});$('afkMedia')?.addEventListener('input',updateAfkPreview);$('afkReason')?.addEventListener('input',updateAfkPreview);$('sendCommand')?.addEventListener('click',executeCommand);$('commandName')?.addEventListener('input',renderDynamicCommandForm);$('refreshActivity')?.addEventListener('click',refreshActivity);document.querySelectorAll('[data-quick]').forEach(b=>b.addEventListener('click',()=>{$('commandName').value=b.dataset.quick;$('commandArgs').value='';renderDynamicCommandForm();executeCommand()}))}

function setupDevProfile(){
  const card=$('devCard');
  const avatar=$('akiAvatar');
  const fallback=card?.querySelector('.avatar-fallback');
  if(avatar && fallback){
    const fail=()=>{avatar.style.display='none';fallback.style.display='grid'};
    const ok=()=>{avatar.style.display='block';fallback.style.display='none'};
    avatar.addEventListener('error',fail,{once:true});
    avatar.addEventListener('load',ok,{once:true});
    if(avatar.complete){avatar.naturalWidth?ok():fail()}
  }
  if(!card) return;
  const reset=()=>{card.style.setProperty('--card-rx','0deg');card.style.setProperty('--card-ry','0deg');card.style.setProperty('--card-x','0px');card.style.setProperty('--card-y','0px')};
  card.addEventListener('pointermove',e=>{
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    const r=card.getBoundingClientRect();
    const x=(e.clientX-r.left)/r.width-.5;
    const y=(e.clientY-r.top)/r.height-.5;
    card.style.setProperty('--card-rx',`${y*-8}deg`);
    card.style.setProperty('--card-ry',`${x*12}deg`);
    card.style.setProperty('--card-x',`${x*10}px`);
    card.style.setProperty('--card-y',`${y*8}px`);
  });
  card.addEventListener('pointerleave',reset);
}

document.addEventListener('DOMContentLoaded',()=>{boot();setupDevProfile()});
