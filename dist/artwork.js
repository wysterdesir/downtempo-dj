export const IMAGE_EXTENSION=/\.(jpe?g|png|webp|avif|gif)$/i;
export const COVER_PLACEHOLDER='./cover-placeholder.svg';

export function artworkKey(name) {
  return String(name??'').split(/[\\/]/).at(-1)
    .replace(/\.[^.]+$/,'').replace(/^\d{4}-\d{2}-\d{2}[_\s-]+/,'')
    .normalize('NFD').replace(/\p{M}/gu,'').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}
// This versioned recording shares the supplied Nwit Lakay cover.
const aliases=new Map([['nwit lakay 2','nwit lakay']]);

export class ArtworkLibrary {
  constructor(createURL=blob=>URL.createObjectURL(blob)) {
    this.entries=new Map();this.createURL=createURL;this.queue=[];this.loading=0;
  }
  add(files) {
    for(const file of files) {
      const key=artworkKey(file.name);if(!key)continue;
      const previous=this.entries.get(key);
      if(previous?.url)URL.revokeObjectURL(previous.url);
      this.entries.set(key,{...file,key});
    }
  }
  find(track) {
    if(!track)return null;
    const key=artworkKey(track.name||track.title);
    return this.entries.get(key)||this.entries.get(aliases.get(key))||null;
  }
  load(entry) {
    if(entry.url)return Promise.resolve(entry.url);
    if(entry.pending)return entry.pending;
    entry.pending=new Promise(resolve=>{this.queue.push({entry,resolve});this.pump();});
    return entry.pending;
  }
  pump() {
    while(this.loading<3&&this.queue.length) {
      const {entry,resolve}=this.queue.shift();this.loading++;
      Promise.resolve().then(()=>entry.read()).then(blob=>{
        if(!/^image\/(jpeg|png|webp|avif|gif)$/.test(blob.type))throw new Error('Unsupported cover format');
        if(this.entries.get(entry.key)!==entry)return null;
        entry.url=this.createURL(blob);return entry.url;
      }).catch(()=>null).then(resolve).finally(()=>{this.loading--;this.pump();});
    }
  }
}

// A late image response must never put the previous song's cover on a reused deck.
export async function showArtwork(image,entry,library) {
  image._artwork=entry;
  image.src=COVER_PLACEHOLDER;
  image.onerror=()=>{image.onerror=null;image.src=COVER_PLACEHOLDER;};
  if(!entry)return;
  const url=await library.load(entry);
  if(url&&image._artwork===entry&&image.isConnected)image.src=url;
}
