import {MixEngine} from './engine.js';
import {DriveLibrary,AUDIO_EXTENSION} from './drive.js';
import {cleanTitle,clamp} from './analysis.js';
import {demoTracks} from './soundcheck.js';

const $=id=>document.getElementById(id),engine=new MixEngine(),drive=new DriveLibrary();
const tracks=[],settings=$('settings');let tab='library',shuffle=false,toastTimer,dragDepth=0,wakeLock=null,renderQueued=false;
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock=s=>{s=Math.max(0,Math.floor(s||0));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
const store=(key,value)=>{try{localStorage.setItem('lowtide:'+key,String(value));}catch{}};
const restore=(key,fallback)=>{try{return localStorage.getItem('lowtide:'+key)??fallback;}catch{return fallback;}};
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),6000);}
async function safe(action){try{await action();}catch(error){toast(error.message||'Something went wrong. Try again.');}finally{requestRender();}}
function requestRender(){if(renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;renderLibrary();});}
function reshuffle(items){const result=[...items];for(let i=result.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[result[i],result[j]]=[result[j],result[i]];}return result;}
function currentOrder(){return shuffle?reshuffle(tracks):[...tracks];}
function upcoming(){return [...engine.voices.filter(v=>v.start>engine.now).map(v=>v.track),...engine.order.slice(engine.cursor)];}
function addTracks(incoming){let added=0;for(const track of incoming)if(!tracks.some(t=>t.id===track.id)){tracks.push(track);added++;}if(!engine.running)engine.order=currentOrder();else engine.order.push(...incoming.filter(t=>!engine.order.some(old=>old.id===t.id)));renderLibrary();return added;}
function addFiles(files){const audio=Array.from(files).filter(f=>f.type.startsWith('audio/')||AUDIO_EXTENSION.test(f.name));const mapped=audio.map(file=>({id:'file:'+file.name+':'+file.size+':'+file.lastModified,name:file.name,title:cleanTitle(file.name),source:'Local file',size:file.size,status:'Not loaded',read:()=>file.arrayBuffer()}));const count=addTracks(mapped);toast(count?count+' tracks added. Ready when you are.':'No new supported audio files were found.');}
async function scanDirectory(handle){const files=[];for await(const entry of handle.values()){if(entry.kind==='directory')files.push(...await scanDirectory(entry));else if(AUDIO_EXTENSION.test(entry.name))files.push(await entry.getFile());}return files;}
async function openFolder(){if('showDirectoryPicker' in window){try{const handle=await window.showDirectoryPicker({mode:'read'});$('footer-status').textContent='Reading your music folder…';addFiles(await scanDirectory(handle));return;}catch(error){if(error.name==='AbortError')return;if(error.name!=='SecurityError')throw error;}}$('folder').click();}
function renderLibrary(){
  $('track-count').textContent=tracks.length;const queue=engine.running?upcoming():engine.order;$('queue-count').textContent=queue.length;
  if(!tracks.length)return;
  const query=$('search').value.trim().toLowerCase(),list=(tab==='queue'?queue:tracks).filter(t=>(t.title+' '+t.name).toLowerCase().includes(query));
  const activeIds=new Set(engine.active().map(v=>v.track.id));
  let html='<div class="table-scroll"><table class="track-table"><thead><tr><th>#</th><th>TRACK / SOURCE</th><th>BPM EST.</th><th>TIME</th><th><span class="sr-only">Track actions</span></th></tr></thead><tbody>';
  list.forEach((t,i)=>{html+='<tr class="'+(activeIds.has(t.id)?'playing':'')+'"><td>'+(activeIds.has(t.id)?'<span class="playing-marker">♫</span>':String(i+1).padStart(2,'0'))+'</td><td><span class="track-name" title="'+escape(t.name)+'">'+escape(t.title)+'</span><span class="track-source '+(t.error?'error-text':'')+'">'+escape(t.error||t.source+' · '+t.status)+'</span></td><td>'+(t.analysis?.bpm||'—')+'</td><td>'+(t.analysis?clock(t.analysis.duration):'—')+'</td><td><div class="row-actions">'+['play','A','B'].map(action=>'<button data-action="'+action+'" data-id="'+escape(t.id)+'" aria-label="'+(action==='play'?'Play next: ':'Load manual deck '+action+': ')+escape(t.title)+'">'+(action==='play'?'▶':action)+'</button>').join('')+'</div></td></tr>';});
  $('library-content').innerHTML=list.length?html+'</tbody></table></div>':'<p class="no-results">'+(query?'No tracks match your search.':'The queue is clear. Choose another track from your collection.')+'</p>';
}
$('library-content').addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');if(!button)return;const track=tracks.find(t=>t.id===button.dataset.id);if(!track)return;
  safe(async()=>{if(button.dataset.action==='play'){if(engine.running)await engine.playNext(track);else await engine.play(engine.order,Math.max(0,engine.order.indexOf(track)));}
  else{await engine.loadManual(track,button.dataset.action);$('automix').checked=false;syncAutoLabel();engine.setCrossfader(Number($('crossfader').value));toast('Deck '+button.dataset.action+' is playing in manual mode. Use the crossfader to blend.');}await keepAwake();});
});
$('settings-open').onclick=()=>settings.showModal();$('drive-open').onclick=()=>settings.showModal();
settings.addEventListener('click',event=>{if(event.target===settings){const r=settings.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)settings.close();}});
$('folder-open').onclick=()=>safe(openFolder);$('files-open').onclick=()=>$('files').click();$('import-top').onclick=()=>$('files').click();
$('files').onchange=event=>{addFiles(event.target.files);event.target.value='';};$('folder').onchange=event=>{addFiles(event.target.files);event.target.value='';};
$('search').oninput=requestRender;
for(const name of ['library','queue'])$('tab-'+name).onclick=()=>{tab=name;$('tab-library').classList.toggle('active',name==='library');$('tab-queue').classList.toggle('active',name==='queue');renderLibrary();};
$('shuffle').onclick=()=>{shuffle=!shuffle;$('shuffle').setAttribute('aria-pressed',shuffle);$('shuffle').classList.toggle('selected',shuffle);if(!engine.running)engine.order=currentOrder();else{const future=engine.order.slice(engine.cursor);engine.order.splice(engine.cursor,future.length,...(shuffle?reshuffle(future):tracks.filter(t=>future.includes(t))));}requestRender();toast(shuffle?'Upcoming unscheduled tracks shuffled.':'Collection order restored for unscheduled tracks.');};
$('repeat').onclick=()=>{engine.repeat=!engine.repeat;store('repeat',engine.repeat);$('repeat').classList.toggle('selected',engine.repeat);$('repeat').setAttribute('aria-pressed',engine.repeat);toast(engine.repeat?'The collection will keep looping.':'Repeat is off. Already prepared tracks will finish.');};
function syncAutoLabel(){$('automix').parentElement.lastChild.textContent=engine.automix?'ON':'OFF';$('crossfader').disabled=engine.automix;$('cross-caption').textContent=engine.automix?'Automix handles the blend':'Manual deck blend';}
$('automix').onchange=event=>{engine.setAutomix(event.target.checked);syncAutoLabel();};
function replan(){if(engine.automix&&engine.running){engine.setAutomix(false);engine.setAutomix(true);}}
$('mix-style').onchange=event=>{engine.style=event.target.value;store('style',engine.style);replan();};
$('fade-length').oninput=event=>{$('fade-label').textContent=event.target.value+' s';};
$('fade-length').onchange=event=>{engine.fade=Number(event.target.value);store('fade',engine.fade);replan();};
$('volume').oninput=event=>{engine.setVolume(Number(event.target.value));$('volume-label').textContent=Math.round(engine.volume*100)+'%';store('volume',engine.volume);};
$('crossfader').oninput=event=>engine.setCrossfader(Number(event.target.value));
$('normalize').onchange=event=>{engine.normalize=event.target.checked;store('normalize',engine.normalize);toast('Level matching updated for newly loaded decks.');};
$('trim-silence').onchange=event=>{engine.trimSilence=event.target.checked;store('trim',engine.trimSilence);replan();};
$('transport').onclick=()=>safe(async()=>{await engine.toggle();await keepAwake();});
for(const deck of ['A','B']){
  $('trim-'+deck).oninput=event=>engine.setTrim(deck,Number(event.target.value));
  $('cue-'+deck).onclick=()=>safe(async()=>{const voice=deckVoice(deck);if(voice)await engine.seek(voice,voice.analysis.start);});
  $('play-'+deck).onclick=()=>safe(async()=>{const voice=deckVoice(deck);if(!voice)return;if(voice.start>engine.now)await engine.playNext(voice.track);else await engine.toggle();await keepAwake();});
  $('seek-'+deck).onchange=event=>safe(()=>{const voice=deckVoice(deck);if(voice)return engine.seek(voice,voice.analysis.duration*Number(event.target.value)/1000);});
}
$('soundcheck').onclick=()=>safe(async()=>{const demos=demoTracks();addTracks(demos);await engine.play(demos,0);await keepAwake();toast('Playing synthesized test audio. This soundcheck demonstrates the transitions.');});
$('connect-drive').onclick=()=>safe(async()=>{
  const button=$('connect-drive');button.disabled=true;
  try{
    const clientId=$('client-id').value.trim(),folder=$('drive-folder').value.trim();store('clientId',clientId);store('folder',folder);$('drive-status').textContent='Waiting for Google sign-in…';
    await drive.connect(clientId);$('drive-status').textContent='Reading the folder…';
    const found=await drive.list(folder,count=>{$('drive-status').textContent='Found '+count+' audio files…';});
    for(const t of found){const previous=tracks.find(p=>p.id===t.id);if(previous){previous.read=t.read;previous.error=null;previous.status=previous.analysis?'Ready':'Not loaded';}}
    const count=addTracks(found);$('connection').textContent='Google Drive connected';$('drive-status').textContent=found.length+' tracks found. '+count+' added to the collection.';
    if(found.length){settings.close();toast('Drive connected. Your music is ready to load.');engine.fill();}
  }catch(error){$('drive-status').textContent=error.message;throw error;}finally{button.disabled=false;}
});
$('disconnect-drive').onclick=()=>{drive.disconnect();$('connection').textContent='Drive disconnected';$('drive-status').textContent='Disconnected. Already decoded music can finish playing. New downloads need sign-in.';toast('Google Drive disconnected.');};
async function keepAwake(){
  if(engine.running&&!engine.paused&&'wakeLock' in navigator&&document.visibilityState==='visible'){
    try{if(!wakeLock){wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{wakeLock=null;});}}catch{}
  }else if(wakeLock){await wakeLock.release();wakeLock=null;}
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')keepAwake();});
document.addEventListener('keydown',event=>{if(event.code==='Space'&&!/INPUT|TEXTAREA|SELECT|BUTTON/.test(event.target.tagName)&&!settings.open){event.preventDefault();safe(()=>engine.toggle());}});
document.addEventListener('dragenter',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();dragDepth++;$('drop-overlay').hidden=false;}});
document.addEventListener('dragover',event=>event.preventDefault());document.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('drop-overlay').hidden=true;});
document.addEventListener('drop',event=>{event.preventDefault();dragDepth=0;$('drop-overlay').hidden=true;addFiles(event.dataTransfer.files);});
function deckVoice(deck){const candidates=engine.voices.filter(v=>v.deck===deck);return candidates.find(v=>v.start<=engine.now&&v.end>engine.now)||candidates.find(v=>v.start>engine.now)||null;}
function surface(canvas){const dpr=window.devicePixelRatio||1,w=Math.max(1,canvas.clientWidth),h=Math.max(1,canvas.clientHeight);if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);return {ctx,w,h};}
function drawWave(deck,voice){
  const {ctx,w,h}=surface($('wave-'+deck));ctx.strokeStyle='#28342b';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();if(!voice)return;
  const position=clamp(voice.offset+engine.now-voice.start,voice.offset,voice.analysis.duration),progress=position/voice.analysis.duration;
  const peaks=voice.analysis.peaks,step=Math.max(1,Math.floor(peaks.length/(w/3))),color=deck==='A'?'#bcf58b':'#8ccfdc';
  for(let i=0;i<peaks.length;i+=step){const x=i/peaks.length*w,amplitude=Math.max(1,Math.pow(peaks[i],.7)*(h*.45));ctx.fillStyle=x<=progress*w?color:(deck==='A'?'#415b3a':'#38505a');ctx.fillRect(x,h/2-amplitude,Math.max(1,w/peaks.length*step-1),amplitude*2);}
  if(voice.fadeOut){const fadePosition=(voice.offset+voice.fadeOut.start-voice.start)/voice.analysis.duration*w;ctx.fillStyle='#bcf58b10';ctx.fillRect(fadePosition,0,w-fadePosition,h);}
  ctx.fillStyle=color;ctx.fillRect(progress*w,0,1.5,h);
}
function drawMeter(){const {ctx,w,h}=surface($('meter'));let level=0;if(engine.analyser){const data=new Uint8Array(engine.analyser.fftSize);engine.analyser.getByteTimeDomainData(data);level=Math.sqrt(data.reduce((sum,x)=>sum+((x-128)/128)**2,0)/data.length);}const amount=clamp((20*Math.log10(Math.max(.00001,level))+50)/50,0,1);for(let i=0;i<14;i++){const y=h-(i+1)*h/14;ctx.fillStyle=i/14<amount?(i>11?'#e4af62':i>8?'#d2e284':'#a3dc78'):'#2b362c';ctx.fillRect(3,y,w-6,h/14-2);}}
let lastTrackIds='',lastFrame=0;
function frame(time){
  if(time-lastFrame>33){lastFrame=time;const now=engine.now,active=engine.active();
    for(const deck of ['A','B']){
      const voice=deckVoice(deck);drawWave(deck,voice);$('empty-'+deck).hidden=!!voice;
      $('play-'+deck).disabled=!voice;$('cue-'+deck).disabled=!voice;$('seek-'+deck).disabled=!voice;
      if(voice){const on=voice.start<=now,position=clamp(voice.offset+now-voice.start,voice.offset,voice.analysis.duration);
        $('title-'+deck).textContent=voice.track.title;$('artist-'+deck).textContent=voice.track.source;
        $('format-'+deck).textContent=voice.track.name.match(/\.([a-z0-9]+)$/i)?.[1].toUpperCase()||'AUDIO';
        $('bpm-'+deck).textContent=voice.analysis.bpm||'—';$('time-'+deck).textContent=clock(on?position:voice.offset);
        $('remaining-'+deck).textContent=on?'−'+clock(voice.end-now)+' REMAINING':'STARTS IN '+clock(voice.start-now);
        $('state-'+deck).textContent=engine.paused?'PAUSED':on?(active.length>1?'BLENDING':'ON AIR'):'UP NEXT';
        $('play-'+deck).textContent=on&&!engine.paused?'Ⅱ':'▶';$('play-'+deck).setAttribute('aria-label',on?'Pause or resume session':'Bring next track in now');
        if(document.activeElement!==$('seek-'+deck))$('seek-'+deck).value=String(position/voice.analysis.duration*1000);
      }else{$('state-'+deck).textContent='STANDBY';$('play-'+deck).textContent='▶';}
    }
    const playing=engine.running&&!engine.paused;$('transport').textContent=playing?'Ⅱ':'▶';$('transport-label').textContent=engine.paused?'RESUME SESSION':playing?'PAUSE SESSION':'START SESSION';
    const current=active.at(-1),next=engine.voices.find(v=>v.start>now);
    if(active.length>1){const incoming=active.at(-1),progress=clamp((now-incoming.start)/Math.max(.01,incoming.fadeIn),0,1);$('mix-status').textContent='Blending into '+incoming.track.title;$('transition-fill').style.width=progress*100+'%';if(engine.automix)$('crossfader').value=incoming.deck==='B'?progress:1-progress;}
    else{$('transition-fill').style.width='0%';if(engine.automix&&current)$('crossfader').value=current.deck==='A'?'0':'1';
      $('mix-status').textContent=engine.paused?'Session paused. Your mix position is held.':!engine.automix?'Manual mode. You control the blend.':next?'Next blend in '+clock(next.start-now)+' · '+next.track.title:engine.filling?'Preparing the next track…':current?'Playing the final prepared track.':tracks.length?'Your collection is ready. Press play.':'Load your music. Settle into the flow.';
    }
    $('footer-status').textContent=playing?engine.voices.length+' decks prepared · '+(engine.manual?'Manual blend':'Original tempo')+(wakeLock?' · Screen kept awake':''):engine.paused?'Paused · press Space to resume':'Audio starts only when you press play.';
    const ids=active.map(v=>v.id).join();if(ids!==lastTrackIds){lastTrackIds=ids;requestRender();updateMediaSession(current?.track);}
    drawMeter();
  }requestAnimationFrame(frame);
}
function updateMediaSession(track){if(!('mediaSession' in navigator)||!track)return;navigator.mediaSession.metadata=new MediaMetadata({title:track.title,artist:track.source,album:'Lowtide listening room'});}
if('mediaSession' in navigator){for(const [action,handler] of Object.entries({play:()=>safe(async()=>{if(engine.paused||!engine.running)await engine.toggle();}),pause:()=>safe(async()=>{if(engine.running&&!engine.paused)await engine.toggle();}),nexttrack:()=>safe(()=>engine.playNext())})){try{navigator.mediaSession.setActionHandler(action,handler);}catch{}}}
for(const event of ['change','loaded','scheduled'])engine.addEventListener(event,requestRender);
engine.addEventListener('trackerror',event=>toast(event.detail.track.title+': '+event.detail.error));engine.addEventListener('warning',event=>toast(event.detail.message));engine.addEventListener('ended',()=>{keepAwake();toast('The session has ended.');});
engine.volume=clamp(Number(restore('volume','.75')),0,1);$('volume').value=engine.volume;$('volume-label').textContent=Math.round(engine.volume*100)+'%';
engine.fade=clamp(Number(restore('fade','24')),4,48);$('fade-length').value=engine.fade;$('fade-label').textContent=engine.fade+' s';
engine.style=restore('style','warm')==='clean'?'clean':'warm';$('mix-style').value=engine.style;
engine.repeat=restore('repeat','true')==='true';$('repeat').classList.toggle('selected',engine.repeat);$('repeat').setAttribute('aria-pressed',engine.repeat);
engine.normalize=restore('normalize','true')==='true';$('normalize').checked=engine.normalize;engine.trimSilence=restore('trim','true')==='true';$('trim-silence').checked=engine.trimSilence;
$('client-id').value=restore('clientId','');$('drive-folder').value=restore('folder',$('drive-folder').value);
syncAutoLabel();requestAnimationFrame(frame);

const registry=document.modelContext;
if(registry?.registerTool){const lifecycle=new AbortController();window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
  for(const tool of [
    {name:'get_listening_session',description:'Read the visible music collection, prepared queue, and playback status.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:()=>({tracks:tracks.map(t=>({id:t.id,title:t.title,status:t.status})),playing:engine.running&&!engine.paused,automix:engine.automix,queue:upcoming().map(t=>({id:t.id,title:t.title}))})},
    {name:'configure_automix',description:'Change the same automix settings as the visible controls. Does not start audio.',inputSchema:{type:'object',properties:{enabled:{type:'boolean'},seconds:{type:'number',minimum:4,maximum:48},style:{type:'string',enum:['warm','clean']}},required:['enabled','seconds','style'],additionalProperties:false},annotations:{readOnlyHint:false},execute:input=>{if(typeof input.enabled!=='boolean'||!Number.isFinite(input.seconds)||input.seconds<4||input.seconds>48||!['warm','clean'].includes(input.style))throw new Error('Invalid automix settings.');engine.fade=input.seconds;engine.style=input.style;engine.setAutomix(input.enabled);$('automix').checked=input.enabled;$('fade-length').value=input.seconds;$('fade-label').textContent=input.seconds+' s';$('mix-style').value=input.style;replan();syncAutoLabel();return {enabled:engine.automix,seconds:engine.fade,style:engine.style};}},
  ]){try{Promise.resolve(registry.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}}
}
