import test from 'node:test';
import assert from 'node:assert/strict';
import {ArtworkLibrary,artworkKey,showArtwork,COVER_PLACEHOLDER} from '../dist/artwork.js';
import {DriveLibrary} from '../dist/drive.js';

test('artwork matches dated audio names, accents and separators, preserving distinct versions',()=>{
  const art=new ArtworkLibrary();art.add([{name:'bruma-dorada.jpg'},{name:'nwit-lakay.jpg'},{name:'Luz de Neón.webp'}]);
  assert.equal(art.find({name:'2026-09-03_Bruma-Dorada.mp3'}).name,'bruma-dorada.jpg');
  assert.equal(art.find({name:'2026-09-02_Nwit-Lakay-2.mp3'}).name,'nwit-lakay.jpg');
  assert.equal(art.find({name:'Luz-de-Neon.flac'}).name,'Luz de Neón.webp');
  assert.equal(art.find({name:'Bruma-Dorada-Remix.mp3'}),null);
  assert.equal(art.find({name:'Bruma-Dorada-2.mp3'}),null);
  assert.equal(artworkKey('Cover Art/2026-09-10_Kafe_Griye.PNG'),'kafe griye');
});

test('covers load once on demand, with at most three concurrent downloads',async()=>{
  let running=0,max=0,reads=0;
  const art=new ArtworkLibrary(()=> 'blob:cover');
  art.add(Array.from({length:8},(_,i)=>({name:`cover-${i}.jpg`,read:async()=>{
    reads++;running++;max=Math.max(max,running);await new Promise(r=>setImmediate(r));running--;return new Blob(['image'],{type:'image/jpeg'});
  }})));
  assert.equal(reads,0);
  const entries=[...art.entries.values()];
  await Promise.all([...entries,entries[0]].map(e=>art.load(e)));
  assert.equal(reads,8);assert.equal(max,3);
  assert.equal(await art.load(entries[0]),'blob:cover');assert.equal(reads,8);
});

test('a late cover cannot replace a newer deck cover, and failed images keep the placeholder',async()=>{
  let finish;
  const old={name:'old.jpg'},next={name:'next.jpg'},image={isConnected:true};
  const library={load:entry=>entry===old?new Promise(r=>finish=r):Promise.resolve('blob:next')};
  const pending=showArtwork(image,old,library);await showArtwork(image,next,library);
  finish('blob:old');await pending;assert.equal(image.src,'blob:next');
  image.onerror();assert.equal(image.src,COVER_PLACEHOLDER);assert.equal(image.onerror,null);
  await showArtwork(image,null,library);assert.equal(image.src,COVER_PLACEHOLDER);
});

test('failed or unsupported cover downloads do not break playback or retry on each render',async()=>{
  let reads=0;const art=new ArtworkLibrary();art.add([{name:'bad.jpg',read:async()=>{reads++;throw new Error('expired');}},{name:'fake.jpg',read:async()=>new Blob(['<html>'],{type:'text/html'})}]);
  const entry=art.find({name:'bad.mp3'});
  assert.equal(await art.load(entry),null);assert.equal(await art.load(entry),null);assert.equal(reads,1);
  assert.equal(await art.load(art.find({name:'fake.mp3'})),null);
});

test('Drive artwork scans pages and nested folders, excludes blocked files, and fetches authenticated blobs lazily',async()=>{
  const calls=[];
  const drive=new DriveLibrary(async(url,options)=>{
    calls.push({url,options});const u=new URL(url);
    if(u.searchParams.has('alt'))return {ok:true,status:200,blob:async()=>new Blob(['image'],{type:'image/jpeg'})};
    const files=u.searchParams.get('q').includes('nested_folder')?[{id:'two',name:'Luna.png'}]:u.searchParams.has('pageToken')?[{id:'one',name:'Bruma.jpg'}]:[{id:'nested_folder',mimeType:'application/vnd.google-apps.folder'},{id:'blocked',name:'private.jpg',capabilities:{canDownload:false}},{id:'audio',name:'Bruma.mp3'}];
    return {ok:true,status:200,json:async()=>({files,...(calls.length===1?{nextPageToken:'page2'}:{})})};
  });drive.token='test-token';drive.expires=Date.now()+3600000;
  const covers=await drive.listArtwork('artwork_folder');assert.equal(covers.length,2);assert.equal(calls.length,3);
  const blob=await covers[0].read();assert.equal(blob.type,'image/jpeg');
  assert.ok(calls.at(-1).url.endsWith('?alt=media'));assert.equal(calls.at(-1).options.headers.Authorization,'Bearer test-token');
});
