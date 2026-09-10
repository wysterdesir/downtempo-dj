import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {MixEngine} from '../dist/engine.js';
import {DriveLibrary,AUDIO_EXTENSION} from '../dist/drive.js';
import {cleanTitle,clamp,shuffleOrder} from '../dist/analysis.js';
import {demoTracks} from '../dist/soundcheck.js';
import {ArtworkLibrary,IMAGE_EXTENSION,COVER_PLACEHOLDER,showArtwork} from '../dist/artwork.js';

async function createUI(){
  const elements=new Map();
  const get=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',checked:false,disabled:false,style:{},listeners:{},parentElement:{lastChild:{}},classList:{add(){},remove(){},toggle(){}},setAttribute(name,value){this[name]=value;},addEventListener(name,fn){this.listeners[name]=fn;},querySelectorAll(){return [];}});return elements.get(id);};
  const document={getElementById:get,addEventListener(){}};
  const context=vm.createContext({document,window:{addEventListener(){}},navigator:{},localStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame(){},setTimeout(){return 0;},clearTimeout(){},MixEngine,DriveLibrary,AUDIO_EXTENSION,cleanTitle,clamp,shuffleOrder:items=>shuffleOrder(items,()=>.999),demoTracks,ArtworkLibrary,IMAGE_EXTENSION,COVER_PLACEHOLDER,showArtwork});
  const source=(await readFile(new URL('../dist/app.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  vm.runInContext(source,context);
  vm.runInContext("addTracks(['Alpha','Bravo','Charlie'].map(id=>({id,title:id,name:id,source:'test',status:'Ready'})));",context);
  return {get,context};
}

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
