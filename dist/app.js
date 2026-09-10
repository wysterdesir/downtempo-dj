import {MixEngine} from './engine.js?v=1.3.1';
import {DriveLibrary,AUDIO_EXTENSION} from './drive.js';
import {cleanTitle,clamp,shuffleOrder} from './analysis.js';
import {demoTracks} from './soundcheck.js';
import {sourcePosition} from './beat-grid.js';
import {ArtworkLibrary,IMAGE_EXTENSION,COVER_PLACEHOLDER,showArtwork} from './artwork.js';

const $=id=>document.getElementById(id),engine=new MixEngine(),drive=new DriveLibrary();
const tracks=[],settings=$('settings');let tab='library',shuffle=false,toastTimer,dragDepth=0,wakeLock=null,renderQueued=false;
let draggedQueueId=null;
const artwork=new ArtworkLibrary();
const coverObserver=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(entries=>{
  for(const item of entries)if(item.isIntersecting){coverObserver.unobserve(item.target);showArtwork(item.target,item.target._coverEntry,artwork);}
},{rootMargin:'160px'});
function bindCovers(){
  coverObserver?.disconnect();
  for(const image of $('library-content').querySelectorAll('[data-cover-track]')){
    const entry=artwork.find(tracks.find(t=>t.id===image.dataset.coverTrack));
    if(!entry)continue;image._coverEntry=entry;
    if(coverObserver)coverObserver.observe(image);else showArtwork(image,entry,artwork);
  }
}
function addCovers(files){artwork.add(Array.from(files).filter(f=>IMAGE_EXTENSION.test(f.name)).map(file=>({id:'local-cover:'+file.name+':'+file.lastModified,name:file.name,read:async()=>file})));}
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock=s=>{s=Math.max(0,Math.floor(s||0));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
const tempo=value=>value?Number(value).toFixed(2):'—';
const store=(key,value)=>{try{localStorage.setItem('lowtide:'+key,String(value));}catch{}};
const restore=(key,fallback)=>{try{return localStorage.getItem('lowtide:'+key)??fallback;}catch{return fallback;}};
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),6000);}
async function safe(action){try{await action();}catch(error){toast(error.message||'Something went wrong. Try again.');}finally{requestRender();}}
function requestRender(){if(renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;renderLibrary();});}
function currentOrder(){return shuffle?shuffleOrder(tracks):[...tracks];}
function visibleCollection(){const ordered=[...engine.order];const ids=new Set(ordered.map(t=>t.id));return [...ordered,...tracks.filter(t=>!ids.has(t.id))];}
function upcoming(){return engine.queueState().map(e=>e.track);}
function addTracks(incoming){const added=[];for(const track of incoming)if(!tracks.some(t=>t.id===track.id)){tracks.push(track);added.push(track);}engine.order.push(...(shuffle?shuffleOrder(added):added));renderLibrary();return added.length;}
function addFiles(files){addCovers(files);const audio=Array.from(files).filter(f=>f.type.startsWith('audio/')||AUDIO_EXTENSION.test(f.name));const mapped=audio.map(file=>({id:'file:'+file.name+':'+file.size+':'+file.lastModified,name:file.name,title:cleanTitle(file.name),source:'Local file',size:file.size,status:'Not loaded',read:()=>file.arrayBuffer()}));const count=addTracks(mapped);const matched=tracks.filter(t=>artwork.find(t)).length;toast(count?count+' tracks added'+(matched?' · '+matched+' with covers.':'. Ready when you are.'):Array.from(files).some(f=>IMAGE_EXTENSION.test(f.name))?matched+' tracks matched with cover art.':'No new supported audio files were found.');}
async function scanDirectory(handle){const files=[];for await(const entry of handle.values()){if(entry.kind==='directory')files.push(...await scanDirectory(entry));else if(AUDIO_EXTENSION.test(entry.name)||IMAGE_EXTENSION.test(entry.name))files.push(await entry.getFile());}return files;}
async function openFolder(){if('showDirectoryPicker' in window){try{const handle=await window.showDirectoryPicker({mode:'read'});$('footer-status').textContent='Reading your music folder…';addFiles(await scanDirectory(handle));return;}catch(error){if(error.name==='AbortError')return;if(error.name!=='SecurityError')throw error;}}$('folder').click();}
function renderLibrary(){
  if(draggedQueueId)return;
  const focus=document.activeElement?.dataset;
  $('track-count').textContent=tracks.length;const queueState=engine.queueState(),queue=queueState.map(e=>e.track);$('queue-count').textContent=queue.length;
  if(!tracks.length)return;
  const query=$('search').value.trim().toLowerCase(),list=(tab==='queue'?queue:visibleCollection()).filter(t=>(t.title+' '+t.name).toLowerCase().includes(query));
  const activeIds=new Set(engine.active().map(v=>v.track.id));
  const editing=tab==='queue',editable=queueState.filter(e=>!e.locked).map(e=>e.track.id);
  const hint=editing?'<p class="queue-hint">Drag the grip to reorder, or use ↑ / ↓. <strong>Next</strong> queues a song after the current mix; × removes it from this session. Repeat cycles the remaining session tracks.</p>':'';
  let html=hint+'<div class="table-scroll"><table class="track-table '+(editing?'queue-table':'collection-table')+'"><thead><tr><th>'+(editing?'<span class="sr-only">Reorder</span>':'#')+'</th><th>TRACK / SOURCE</th><th>BPM EST.</th><th>TIME</th><th><span class="sr-only">Track actions</span></th></tr></thead><tbody>';
  list.forEach((t,i)=>{
    const locked=queueState.find(e=>e.track.id===t.id)?.locked,position=editable.indexOf(t.id);
    const button=(action,label,description,disabled=false)=>'<button data-action="'+action+'" data-id="'+escape(t.id)+'" title="'+escape(description)+'" aria-label="'+escape(description+': '+t.title)+'"'+(disabled?' disabled':'')+'>'+label+'</button>';
    const actions=editing?button('up','↑','Move up',locked||position<=0)+button('down','↓','Move down',locked||position===editable.length-1)+button('next','Next','Play after the current mix',locked||position===0)+button('remove','×','Remove from this session',locked):button('play','▶','Play now')+button('next','Next','Play after the current mix',activeIds.has(t.id)||locked)+button('A','A','Load manual deck A')+button('B','B','Load manual deck B');
    const number=editing?(locked?'<span class="queue-locked" title="Transition starting">●</span>':'<button class="queue-grip" draggable="true" data-queue-drag="'+escape(t.id)+'" tabindex="-1" aria-hidden="true" title="Drag to reorder">⠿</button>'):(activeIds.has(t.id)?'<span class="playing-marker">♫</span>':String(i+1).padStart(2,'0'));
    html+='<tr '+(editing?'data-queue-id="'+escape(t.id)+'" ':'')+'class="'+(activeIds.has(t.id)?'playing':'')+'"><td>'+number+'</td><td><div class="track-identity"><img class="track-cover" data-cover-track="'+escape(t.id)+'" src="'+COVER_PLACEHOLDER+'" alt="" width="44" height="44" draggable="false" decoding="async"><div class="track-copy"><span class="track-name" title="'+escape(t.name)+'">'+escape(t.title)+'</span><span class="track-source '+(t.error?'error-text':'')+'">'+escape(locked?'Transition starting · order locked':t.error||t.source+' · '+t.status)+'</span></div></div></td><td>'+tempo(t.analysis?.bpm)+'</td><td>'+(t.analysis?clock(t.analysis.duration):'—')+'</td><td><div class="row-actions">'+actions+'</div></td></tr>';
  });
  $('library-content').innerHTML=list.length?html+'</tbody></table></div>'+(editing?'<div class="queue-drop-end" data-queue-end>Drop here to move to the end</div>':''):hint+'<p class="no-results">'+(query?'No tracks match your search.':'No other tracks queued. Choose Next in Collection to add one.')+'</p>';
  bindCovers();
  if(focus?.action&&focus.id){const controls=[...$('library-content').querySelectorAll('[data-action]')];const same=controls.find(b=>b.dataset.id===focus.id&&b.dataset.action===focus.action&&!b.disabled)||controls.find(b=>b.dataset.id===focus.id&&!b.disabled);same?.focus();}
}
$('library-content').addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');if(!button)return;const track=tracks.find(t=>t.id===button.dataset.id);if(!track)return;
  if(['next','up','down','remove'].includes(button.dataset.action)){safe(()=>editQueue(button.dataset.action,track));return;}
  safe(async()=>{if(button.dataset.action==='play'){if(!engine.order.some(t=>t.id===track.id))engine.editQueue('next',track);if(engine.running)await engine.playNext(track);else await engine.play(engine.order,Math.max(0,engine.order.indexOf(track)));}
  else{await engine.loadManual(track,button.dataset.action);$('automix').checked=false;syncAutoLabel();engine.setCrossfader(Number($('crossfader').value));toast('Deck '+button.dataset.action+' is playing in manual mode. Use the crossfader to blend.');}await keepAwake();});
});
function editQueue(action,track,beforeId=null){
  const changed=engine.editQueue(action,track,beforeId);if(!changed)return;
  shuffle=false;$('shuffle').classList.remove('selected');$('shuffle').setAttribute('aria-pressed',false);
  renderLibrary();
  toast(action==='remove'?track.title+' removed from this session. It stays in Collection.':action==='next'?track.title+' will play after the current mix.':track.title+' moved in Up next.');
  const button=[...$('library-content').querySelectorAll('[data-action]')].find(b=>b.dataset.id===track.id&&b.dataset.action===action&&!b.disabled);
  if(button)button.focus();else if(action==='remove')$('tab-queue').focus?.();
}
function clearQueueDrag(){draggedQueueId=null;for(const row of $('library-content').querySelectorAll('.drop-target'))row.classList.remove('drop-target');$('library-content').classList.remove('queue-dragging');}
$('library-content').addEventListener('dragstart',event=>{
  const grip=event.target.closest('[data-queue-drag]');if(!grip)return;
  draggedQueueId=grip.dataset.queueDrag;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-lowtide-track',draggedQueueId);$('library-content').classList.add('queue-dragging');
});
$('library-content').addEventListener('dragover',event=>{
  if(!draggedQueueId)return;event.preventDefault();event.dataTransfer.dropEffect='move';
  for(const row of $('library-content').querySelectorAll('.drop-target'))row.classList.remove('drop-target');
  event.target.closest('[data-queue-id], [data-queue-end]')?.classList.add('drop-target');
});
$('library-content').addEventListener('drop',event=>{
  if(!draggedQueueId)return;event.preventDefault();event.stopPropagation();
  const target=event.target.closest('[data-queue-id], [data-queue-end]'),track=tracks.find(t=>t.id===draggedQueueId);clearQueueDrag();
  if(target&&track)safe(()=>editQueue('move',track,target.dataset.queueId??null));else renderLibrary();
});
$('library-content').addEventListener('dragend',()=>{clearQueueDrag();renderLibrary();});
$('settings-open').onclick=()=>settings.showModal();$('drive-open').onclick=()=>settings.showModal();
settings.addEventListener('click',event=>{if(event.target===settings){const r=settings.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)settings.close();}});
$('folder-open').onclick=()=>safe(openFolder);$('files-open').onclick=()=>$('files').click();$('import-top').onclick=()=>$('files').click();
$('files').onchange=event=>{addFiles(event.target.files);event.target.value='';};$('folder').onchange=event=>{addFiles(event.target.files);event.target.value='';};
$('covers-open').onclick=()=>$('covers').click();
$('covers').onchange=event=>{addCovers(event.target.files);event.target.value='';renderLibrary();toast(tracks.filter(t=>artwork.find(t)).length+' tracks matched with cover art.');};
$('search').oninput=requestRender;
for(const name of ['library','queue'])$('tab-'+name).onclick=()=>{tab=name;$('tab-library').classList.toggle('active',name==='library');$('tab-queue').classList.toggle('active',name==='queue');renderLibrary();};
$('edit-queue').onclick=()=>{$('search').value='';$('tab-queue').onclick();$('tab-queue').focus?.();};
$('shuffle').onclick=()=>{
  if(tracks.length<2){toast('Add at least two tracks to shuffle.');return;}
  shuffle=!shuffle;$('shuffle').setAttribute('aria-pressed',shuffle);$('shuffle').classList.toggle('selected',shuffle);
  const result=engine.reorderCollection(tracks,shuffle);
  renderLibrary();
  toast(shuffle?(result.reorderable<2?'Shuffle is on. Add more upcoming tracks to change their order.':result.pinned?'Upcoming tracks shuffled. The current mix stays in place.':'Collection shuffled. This is your new play order.'):'Original track order restored after the current mix.');
};
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
$('beat-sync').onchange=event=>{engine.beatSync=event.target.checked;store('beatSync',engine.beatSync);replan();toast(engine.beatSync?'Beat sync enabled for reliable grids.':'Beat sync off for future transitions.');};
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
    await loadDriveCovers();
  }catch(error){$('drive-status').textContent=error.message;throw error;}finally{button.disabled=false;}
});
async function loadDriveCovers(){
  const folder=$('artwork-folder').value.trim();store('artworkFolder',folder);
  if(!folder)return;
  $('artwork-status').textContent='Finding cover art…';
  try{
    artwork.add(await drive.listArtwork(folder));renderLibrary();
    $('artwork-status').textContent=tracks.filter(t=>artwork.find(t)).length+' tracks matched with cover art.';
  }catch(error){$('artwork-status').textContent='Covers could not load: '+error.message;toast($('artwork-status').textContent);}
}
$('load-drive-covers').onclick=()=>safe(async()=>{
  const button=$('load-drive-covers');button.disabled=true;
  try{const clientId=$('client-id').value.trim();store('clientId',clientId);if(!drive.token||Date.now()>drive.expires-15000)await drive.connect(clientId);await loadDriveCovers();}finally{button.disabled=false;}
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
document.addEventListener('drop',event=>{event.preventDefault();clearQueueDrag();dragDepth=0;$('drop-overlay').hidden=true;if(event.dataTransfer?.files.length)addFiles(event.dataTransfer.files);});
function deckVoice(deck){const candidates=engine.voices.filter(v=>v.deck===deck);return candidates.find(v=>v.start<=engine.now&&v.end>engine.now)||candidates.find(v=>v.start>engine.now)||null;}
function surface(canvas){const dpr=window.devicePixelRatio||1,w=Math.max(1,canvas.clientWidth),h=Math.max(1,canvas.clientHeight);if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);return {ctx,w,h};}
function drawWave(deck,voice){
  const {ctx,w,h}=surface($('wave-'+deck));ctx.strokeStyle='#28342b';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();if(!voice)return;
  const position=clamp(sourcePosition(voice,engine.now),voice.offset,voice.analysis.duration),progress=position/voice.analysis.duration;
  for(const grid of Object.values(voice.analysis.grids||{}))if(grid){ctx.fillStyle='#edf2e924';for(let beat=grid.offset;beat<=grid.to;beat+=grid.period){const x=beat/voice.analysis.duration*w;ctx.fillRect(x,0,1,h);}}
  const peaks=voice.analysis.peaks,step=Math.max(1,Math.floor(peaks.length/(w/3))),color=deck==='A'?'#bcf58b':'#8ccfdc';
  for(let i=0;i<peaks.length;i+=step){const x=i/peaks.length*w,amplitude=Math.max(1,Math.pow(peaks[i],.7)*(h*.45));ctx.fillStyle=x<=progress*w?color:(deck==='A'?'#415b3a':'#38505a');ctx.fillRect(x,h/2-amplitude,Math.max(1,w/peaks.length*step-1),amplitude*2);}
  if(voice.fadeOut){const fadePosition=sourcePosition(voice,voice.fadeOut.start)/voice.analysis.duration*w;ctx.fillStyle='#bcf58b10';ctx.fillRect(fadePosition,0,w-fadePosition,h);}
  ctx.fillStyle=color;ctx.fillRect(progress*w,0,1.5,h);
}
function drawMeter(){const {ctx,w,h}=surface($('meter'));let level=0;if(engine.analyser){const data=new Uint8Array(engine.analyser.fftSize);engine.analyser.getByteTimeDomainData(data);level=Math.sqrt(data.reduce((sum,x)=>sum+((x-128)/128)**2,0)/data.length);}const amount=clamp((20*Math.log10(Math.max(.00001,level))+50)/50,0,1);for(let i=0;i<14;i++){const y=h-(i+1)*h/14;ctx.fillStyle=i/14<amount?(i>11?'#e4af62':i>8?'#d2e284':'#a3dc78'):'#2b362c';ctx.fillRect(3,y,w-6,h/14-2);}}
let lastTrackIds='',lastFrame=0;
function frame(time){
  if(time-lastFrame>33){lastFrame=time;const now=engine.now,active=engine.active();
    for(const deck of ['A','B']){
      const voice=deckVoice(deck);drawWave(deck,voice);$('empty-'+deck).hidden=!!voice;
      const cover=$('cover-'+deck),entry=artwork.find(voice?.track);if(cover._artwork!==entry)showArtwork(cover,entry,artwork);
      $('play-'+deck).disabled=!voice;$('cue-'+deck).disabled=!voice;$('seek-'+deck).disabled=!voice;
      if(voice){const on=voice.start<=now,position=clamp(sourcePosition(voice,now),voice.offset,voice.analysis.duration);
        $('title-'+deck).textContent=voice.track.title;$('artist-'+deck).textContent=voice.track.source;
        $('format-'+deck).textContent=voice.track.name.match(/\.([a-z0-9]+)$/i)?.[1].toUpperCase()||'AUDIO';
        $('bpm-'+deck).textContent=tempo(voice.sync?.synced?voice.sync.bpm:voice.analysis.bpm*(voice.rate??1));$('time-'+deck).textContent=clock(on?position:voice.offset);
        $('note-'+deck).textContent=Math.abs((voice.rate??1)-1)>.0001?((voice.rate-1)*100>=0?'+':'')+((voice.rate-1)*100).toFixed(2)+'% tempo':'Original tempo';
        $('remaining-'+deck).textContent=on?'−'+clock(voice.end-now)+' REMAINING':'STARTS IN '+clock(voice.start-now);
        $('state-'+deck).textContent=engine.paused?'PAUSED':on?(active.length>1?'BLENDING':'ON AIR'):'UP NEXT';
        $('play-'+deck).textContent=on&&!engine.paused?'Ⅱ':'▶';$('play-'+deck).setAttribute('aria-label',on?'Pause or resume session':'Bring next track in now');
        if(document.activeElement!==$('seek-'+deck))$('seek-'+deck).value=String(position/voice.analysis.duration*1000);
      }else{$('state-'+deck).textContent='STANDBY';$('play-'+deck).textContent='▶';$('title-'+deck).textContent=deck==='A'?'Room for something good.':'The next chapter.';$('artist-'+deck).textContent='Ready when you are';}
    }
    const playing=engine.running&&!engine.paused;$('transport').textContent=playing?'Ⅱ':'▶';$('transport-label').textContent=engine.paused?'RESUME SESSION':playing?'PAUSE SESSION':'START SESSION';
    const current=active.at(-1),next=engine.voices.find(v=>v.start>now);
    const transition=active.length>1?current:next;
    $('sync-state').textContent=transition?.sync?.synced?'BEAT MATCHED':engine.beatSync?'BEAT SYNC ON':'BEAT SYNC OFF';
    $('sync-state').classList.toggle('matched',!!transition?.sync?.synced);
    $('sync-detail').textContent=transition?.sync?(transition.sync.synced?'Matched at '+tempo(transition.sync.bpm)+' BPM · '+transition.sync.beats+' beats':transition.sync.reason+' · gentle crossfade'):'Matches reliable beats automatically · speed changes may shift pitch slightly';
    if(active.length>1){const incoming=active.at(-1),progress=clamp((now-incoming.start)/Math.max(.01,incoming.fadeIn),0,1);$('mix-status').textContent='Blending into '+incoming.track.title;$('transition-fill').style.width=progress*100+'%';if(engine.automix)$('crossfader').value=incoming.deck==='B'?progress:1-progress;}
    else{$('transition-fill').style.width='0%';if(engine.automix&&current)$('crossfader').value=current.deck==='A'?'0':'1';
      $('mix-status').textContent=engine.paused?'Session paused. Your mix position is held.':!engine.automix?'Manual mode. You control the blend.':next?'Next blend in '+clock(next.start-now)+' · '+next.track.title:engine.filling?'Preparing the next track…':current?'Playing the final prepared track.':tracks.length?'Your collection is ready. Press play.':'Load your music. Settle into the flow.';
    }
    $('footer-status').textContent=playing?engine.voices.length+' decks prepared · '+(engine.manual?'Manual blend':engine.beatSync?'Adaptive beat sync':'Original tempo')+(wakeLock?' · Screen kept awake':''):engine.paused?'Paused · press Space to resume':'Audio starts only when you press play.';
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
engine.beatSync=restore('beatSync','true')==='true';$('beat-sync').checked=engine.beatSync;
$('client-id').value=restore('clientId','');$('drive-folder').value=restore('folder',$('drive-folder').value);
$('artwork-folder').value=restore('artworkFolder',$('artwork-folder').value);
syncAutoLabel();requestAnimationFrame(frame);

const registry=document.modelContext;
if(registry?.registerTool){const lifecycle=new AbortController();window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
  for(const tool of [
    {name:'get_listening_session',description:'Read the visible music collection, prepared queue, and playback status.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:()=>({tracks:tracks.map(t=>({id:t.id,title:t.title,status:t.status})),playing:engine.running&&!engine.paused,automix:engine.automix,queue:upcoming().map(t=>({id:t.id,title:t.title}))})},
    {name:'configure_automix',description:'Change the same automix settings as the visible controls. Does not start audio.',inputSchema:{type:'object',properties:{enabled:{type:'boolean'},seconds:{type:'number',minimum:4,maximum:48},style:{type:'string',enum:['warm','clean']}},required:['enabled','seconds','style'],additionalProperties:false},annotations:{readOnlyHint:false},execute:input=>{if(typeof input.enabled!=='boolean'||!Number.isFinite(input.seconds)||input.seconds<4||input.seconds>48||!['warm','clean'].includes(input.style))throw new Error('Invalid automix settings.');engine.fade=input.seconds;engine.style=input.style;engine.setAutomix(input.enabled);$('automix').checked=input.enabled;$('fade-length').value=input.seconds;$('fade-label').textContent=input.seconds+' s';$('mix-style').value=input.style;replan();syncAutoLabel();return {enabled:engine.automix,seconds:engine.fade,style:engine.style};}},
  ]){try{Promise.resolve(registry.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}}
}
