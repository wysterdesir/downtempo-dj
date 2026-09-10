import { cleanTitle } from './analysis.js';
import { IMAGE_EXTENSION } from './artwork.js';
export const AUDIO_EXTENSION = /\.(mp3|wav|flac|m4a|ogg|oga|aac|aiff|aif|opus|webm)$/i;
export function folderId(value) {
  const trimmed=String(value).trim();
  const match=trimmed.match(/\/folders\/([\w-]+)/);
  const id=match?.[1] || (/^[\w-]{10,}$/.test(trimmed)?trimmed:null);
  if(!id)throw new Error('Enter a valid Google Drive folder link.');return id;
}
export class DriveLibrary {
  constructor(fetcher=(...args)=>fetch(...args)) {this.fetcher=fetcher;this.token=null;this.expires=0;this.script=null;}
  loadIdentity() {
    if(window.google?.accounts?.oauth2)return Promise.resolve();
    if(this.script)return this.script;
    this.script=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;
      script.onload=resolve;script.onerror=()=>{this.script=null;script.remove();reject(new Error('Google sign-in could not load. Check your connection or content blocker.'));};
      document.head.appendChild(script);
    });return this.script;
  }
  async connect(clientId) {
    if(!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId.trim()))throw new Error('Add your Google OAuth Web client ID first. The setup instructions are below.');
    await this.loadIdentity();
    return new Promise((resolve,reject)=>{
      const client=window.google.accounts.oauth2.initTokenClient({
        client_id:clientId.trim(),scope:'https://www.googleapis.com/auth/drive.readonly',
        callback:response=>{
          if(response.error)return reject(new Error(response.error_description || response.error));
          if(!response.access_token)return reject(new Error('Google did not return access to Drive.'));
          this.token=response.access_token;this.expires=Date.now()+(Number(response.expires_in)||3600)*1000;
          resolve();
        },
        error_callback:error=>reject(new Error(error.type==='popup_closed'?'Google sign-in was closed.':'The sign-in window was blocked. Allow pop-ups and try again.')),
      });client.requestAccessToken({prompt:''});
    });
  }
  async request(path,options={}) {
    if(!this.token || Date.now()>this.expires-15000)throw new Error('Your Drive session expired. Reconnect Drive to load more tracks. Already loaded tracks can keep playing.');
    let response;
    for(let attempt=0;attempt<3;attempt++) {
      response=await this.fetcher('https://www.googleapis.com/drive/v3/'+path,{...options,headers:{Authorization:'Bearer '+this.token},signal:AbortSignal.timeout(90000)});
      if(response.status!==429 && response.status<500)break;
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,750*2**attempt));
    }
    if(!response.ok) {
      if(response.status===401)throw new Error('Reconnect Google Drive to continue downloading music.');
      if(response.status===403)throw new Error('Google denied this file. Check Drive API setup, file access, and download limits.');
      if(response.status===404)throw new Error('This Drive item was moved, deleted, or is not shared with this Google account.');
      throw new Error(`Drive request failed (${response.status}). Please try again.`);
    }
    return response;
  }
  list(folder,onProgress=()=>{}) {return this.scan(folder,onProgress,false);}
  listArtwork(folder,onProgress=()=>{}) {return this.scan(folder,onProgress,true);}
  async scan(folder,onProgress,images) {
    const pending=[folderId(folder)],visited=new Set(),tracks=[];
    while(pending.length) {
      const id=pending.shift();if(visited.has(id))continue;visited.add(id);
      if(visited.size>500)throw new Error('This folder contains too many subfolders. Choose a smaller music folder.');
      let pageToken;
      do {
        const params=new URLSearchParams({q:`'${id}' in parents and trashed = false`,fields:'nextPageToken,files(id,name,mimeType,size,modifiedTime,capabilities/canDownload)',pageSize:'1000',supportsAllDrives:'true',includeItemsFromAllDrives:'true',orderBy:'name'});
        if(pageToken)params.set('pageToken',pageToken);
        const data=await (await this.request('files?'+params)).json();
        for(const file of data.files || []) {
          if(file.mimeType==='application/vnd.google-apps.folder')pending.push(file.id);
          else if((images?IMAGE_EXTENSION.test(file.name):(file.mimeType?.startsWith('audio/') || AUDIO_EXTENSION.test(file.name))) && file.capabilities?.canDownload!==false) {
            tracks.push({id:'drive:'+file.id,driveId:file.id,name:file.name,title:cleanTitle(file.name),source:'Google Drive',size:Number(file.size)||0,status:'Not loaded',read:async()=> {const response=await this.request('files/'+encodeURIComponent(file.id)+'?alt=media');return images?response.blob():response.arrayBuffer();}});
          }
        }
        pageToken=data.nextPageToken;onProgress(tracks.length);
      }while(pageToken);
    }
    return tracks;
  }
  disconnect() {if(this.token && window.google?.accounts?.oauth2)window.google.accounts.oauth2.revoke(this.token,()=>{});this.token=null;this.expires=0;}
}
