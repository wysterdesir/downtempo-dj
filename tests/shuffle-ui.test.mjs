import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {MixEngine} from '../dist/engine.js';
import {DriveLibrary,AUDIO_EXTENSION} from '../dist/drive.js';
import {cleanTitle,clamp,shuffleOrder} from '../dist/analysis.js';
import {demoTracks} from '../dist/soundcheck.js';
import {ArtworkLibrary,IMAGE_EXTENSION,COVER_PLACEHOLDER,showArtwork} from '../dist/artwork.js';
import {ListeningMode} from '../dist/listening.js';
import {sourcePosition} from '../dist/beat-grid.js';
import {effectivePhrases} from '../dist/phrases.js';

async function createUI(storage=new Map()){
  const elements=new Map();
  const get=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',checked:false,disabled:false,style:{},listeners:{},parentElement:{lastChild:{}},classList:{add(){},remove(){},toggle(){}},setAttribute(name,value){this[name]=value;},addEventListener(name,fn){this.listeners[name]=fn;},querySelectorAll(){return [];},querySelector(selector){return get(selector.slice(1));}});return elements.get(id);};
  const document={getElementById:get,addEventListener(){},body:{classList:{toggle(){}}}};
  const context=vm.createContext({document,window:{addEventListener(){}},navigator:{},localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},requestAnimationFrame(){},setTimeout(){return 0;},clearTimeout(){},MixEngine,DriveLibrary,AUDIO_EXTENSION,cleanTitle,clamp,shuffleOrder:items=>shuffleOrder(items,()=>.999),demoTracks,ArtworkLibrary,IMAGE_EXTENSION,COVER_PLACEHOLDER,showArtwork,ListeningMode,sourcePosition,effectivePhrases});
  const source=(await readFile(new URL('../dist/app.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  vm.runInContext(source,context);
  vm.runInContext("addTracks(['Alpha','Bravo','Charlie'].map(id=>({id,title:id,name:id,source:'test',status:'Ready'})));",context);
  return {get,context,storage};
}

test('phrase controls save a snapped cue, restore it on reload, and clear the correction',async()=>{
  const {get,context,storage}=await createUI();assert.equal(get('phrase-sync').checked,true);
  vm.runInContext("engine.voices=[{track:tracks[0],start:0,end:120,offset:0,rate:1,analysis:{duration:120,start:0,end:120,grids:{intro:{offset:.137,period:.6,from:0,to:96}}}}];refreshPhraseCue();",context);
  assert.equal(get('phrase-cue-track').textContent,'Alpha');get('phrase-anchor').value='5';get('phrase-bars').value='16';await get('phrase-save').onclick();
  const cue=JSON.parse(storage.get('lowtide:phraseCue:Alpha'));assert.ok(Math.abs(cue.anchor-4.937)<1e-9);assert.equal(cue.bars,16);
  const reload=await createUI(storage);assert.equal(vm.runInContext('tracks[0].phraseCue.bars',reload.context),16);
  get('phrase-sync').onchange({target:{checked:false}});assert.equal(storage.get('lowtide:phraseSync'),'false');
  get('phrase-reset').onclick();assert.equal(storage.get('lowtide:phraseCue:Alpha'),'null');assert.equal(vm.runInContext('engine.voices[0].analysis.phraseCue',context),null);
  get('beat-sync').onchange({target:{checked:false}});assert.equal(get('phrase-sync').disabled,true);
});

test('the real Shuffle click handler changes Collection rows and the actual play order, then restores both',async()=>{
  const {get,context}=await createUI();
  assert.ok(get('library-content').innerHTML.indexOf('Alpha')<get('library-content').innerHTML.indexOf('Bravo'));
  get('shuffle').onclick();
  const order=JSON.parse(vm.runInContext('JSON.stringify(engine.order.map(t=>t.id))',context));
  assert.notDeepEqual(order,['Alpha','Bravo','Charlie']);
  assert.deepEqual([...order].sort(),['Alpha','Bravo','Charlie']);
  const html=get('library-content').innerHTML;
  for(const id of order)assert.ok(html.includes('data-cover-track="'+id+'"'));
  for(let i=1;i<order.length;i++)assert.ok(html.indexOf(order[i-1])<html.indexOf(order[i]));
  assert.equal(get('shuffle')['aria-pressed'],true);
  vm.runInContext("tab='queue';renderLibrary();",context);
  for(let i=1;i<order.length;i++)assert.ok(get('library-content').innerHTML.indexOf(order[i-1])<get('library-content').innerHTML.indexOf(order[i]));
  get('shuffle').onclick();
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(engine.order.map(t=>t.id))',context)),['Alpha','Bravo','Charlie']);
  assert.equal(get('shuffle')['aria-pressed'],false);
});

test('queue buttons edit actual order through filtered results without removing collection tracks',async()=>{
  const {get,context}=await createUI(),content=get('library-content');
  const order=()=>JSON.parse(vm.runInContext('JSON.stringify(engine.order.map(t=>t.id))',context));
  const click=(action,id)=>content.listeners.click({target:{closest:()=>({dataset:{action,id}})}});
  get('tab-queue').onclick();get('search').value='Charlie';vm.runInContext('renderLibrary()',context);
  click('up','Charlie');assert.deepEqual(order(),['Alpha','Charlie','Bravo']);
  click('next','Charlie');assert.deepEqual(order(),['Charlie','Alpha','Bravo']);
  click('remove','Charlie');assert.deepEqual(order(),['Alpha','Bravo']);
  assert.equal(vm.runInContext('tracks.length',context),3);
  vm.runInContext('addTracks(tracks)',context);assert.deepEqual(order(),['Alpha','Bravo']);
  get('tab-library').onclick();assert.ok(content.innerHTML.includes('Charlie'));
  click('next','Charlie');assert.deepEqual(order(),['Charlie','Alpha','Bravo']);
});

test('real drag handlers reorder before a row and at the end without treating the drag as a file import',async()=>{
  const {get,context}=await createUI(),content=get('library-content');get('tab-queue').onclick();
  const order=()=>JSON.parse(vm.runInContext('JSON.stringify(engine.order.map(t=>t.id))',context));
  const drag=id=>content.listeners.dragstart({target:{closest:()=>({dataset:{queueDrag:id}})},dataTransfer:{setData(){}}});
  let stopped=0;
  const drop=before=>content.listeners.drop({target:{closest:()=>({dataset:before?{queueId:before}:{}})},preventDefault(){},stopPropagation(){stopped++;}});
  drag('Charlie');drop('Alpha');assert.deepEqual(order(),['Charlie','Alpha','Bravo']);
  drag('Alpha');drop(null);assert.deepEqual(order(),['Charlie','Bravo','Alpha']);assert.equal(stopped,2);
  content.listeners.dragend();assert.equal(vm.runInContext('draggedQueueId',context),null);
});
