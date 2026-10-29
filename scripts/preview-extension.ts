/** Local-only interaction preview. Never uses browser credentials or remote APIs. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { themeStyleFiles, themeAssetFiles } from "./extension-assets";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const portFlag = args.findIndex(
  (argument) => argument === "--port" || argument.startsWith("--port="),
);
const portOption =
  portFlag < 0
    ? process.env.PREVIEW_PORT || "8794"
    : args[portFlag].startsWith("--port=")
      ? args[portFlag].slice("--port=".length)
      : args[portFlag + 1];
if (!portOption || !/^\d+$/.test(portOption))
  throw new Error(
    "Use --port <1–65535> or PREVIEW_PORT to select a preview port.",
  );
const port = Number(portOption);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("The preview port must be an integer from 1 to 65535.");
const mime: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  woff2: "font/woff2",
  zip: "application/zip",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};
function previewRuntime(worker: string) {
  return `(() => {
  'use strict';
  const params = new URL(location.href).searchParams;
  const mode = params.get('demo');
  const issueCodes = ['queue_account_changed','apple_reconnect_required','apple_unavailable','lastfm_reconnect_required','lastfm_unavailable','recording_unavailable'];
  let recordingIssue = issueCodes.includes(params.get('issue')) ? {code:params.get('issue'),...(params.get('issue')==='queue_account_changed'?{queue_owner:'OriginalListener'}:{})} : null;
  let username = 'DemoListener';
  let clipboardFailures = params.get('clipboard') === 'blocked' ? Infinity : params.get('clipboard') === 'once' ? 1 : 0;
  const sourceArtwork = mode === 'apple-artwork';
  const ledger = mode === 'ledger' || sourceArtwork || mode === 'upgrade';
  const sample = ['connected', 'ready', 'lastfm', 'ledger', 'apple-artwork', 'apple', 'application', 'upgrade'].includes(mode);
  let backendVersion=mode==='upgrade'?'0.3.106':'0.3.111';
  let backendHash=mode==='upgrade'?'92ce26f40fb253dbd98a4a9d9a1469847060b0d186d36beefaa99f170ec2ebe5':'531b2090c8a640c059cf0f713c53192099ee3a9da1f25243df39622ada3a2794';
  const store = {};
  if(['light','dark','system'].includes(params.get('theme'))) store['theme-preference:v1'] = params.get('theme');
  if(sample) store.installation = {
    account:'11111111111111111111111111111111', name:'ams-111111111111111111111111',
    marker:'22222222222222222222222222222222', key:'3'.repeat(64),
    namespace:'44444444444444444444444444444444', origin:'https://ams-111111111111111111111111.preview.workers.dev'
  };
  let apple = sample && mode !== 'apple', lastfm = sample && !['lastfm','apple','application'].includes(mode), configured = sample && !['apple','application'].includes(mode);
  let enabled = mode === 'connected' || ledger, clipboard = '', namespace = null, installed = ledger;
  if(recordingIssue?.code==='queue_account_changed')enabled=false;
  const clone = value => JSON.parse(JSON.stringify(value));
  const record = {track:'High High High',artist:'張惠妹',album:'牽手',catalog_id:'1854820331',status:'accepted',timestamp_iso:'2026-10-23T14:00:00.000Z'};
  // Fictional local-only listening history; never read from or written to an account.
  const ledgerRecords = [
    {track:'High High High',artist:'張惠妹',album:'牽手',catalog_id:'1854820331',status:'accepted',timestamp_iso:'2026-10-25T03:42:00.000Z'},
    {track:'聽海',catalog_id:'1854824118',artist:'張惠妹',album:'Bad Boy',status:'accepted',timestamp_iso:'2026-10-25T03:37:00.000Z'},
    {track:'晴天',catalog_id:'535824738',artist:'周杰倫',album:'葉惠美',status:'accepted',timestamp_iso:'2026-10-25T03:31:00.000Z'},
    {track:'七里香',catalog_id:'536115195',artist:'周杰倫',album:'七里香',status:'accepted',timestamp_iso:'2026-10-24T12:18:00.000Z'},
    {track:'稻香',catalog_id:'1624001324',artist:'周杰倫',album:'魔杰座',status:'accepted',timestamp_iso:'2026-10-24T12:13:00.000Z'},
    {track:'夜曲',catalog_id:'536009642',artist:'周杰倫',album:'十一月的蕭邦',status:'accepted',timestamp_iso:'2026-10-24T12:08:00.000Z'},
    {track:'晴天',catalog_id:'535824738',artist:'周杰倫',album:'葉惠美',status:'accepted',timestamp_iso:'2026-10-24T11:59:00.000Z'},
    {track:'聽海',catalog_id:'1854824118',artist:'張惠妹',album:'Bad Boy',status:'accepted',timestamp_iso:'2026-10-24T11:54:00.000Z'},
    {track:'稻香',catalog_id:'1624001324',artist:'周杰倫',album:'魔杰座',status:'accepted',timestamp_iso:'2026-10-24T11:49:00.000Z'},
    {track:'High High High',artist:'張惠妹',album:'牽手',catalog_id:'1854820331',status:'accepted',timestamp_iso:'2026-10-24T11:44:00.000Z'}
  ];
  const sourceRecords = ledgerRecords.map(entry=>({...entry,track_id:entry.catalog_id,catalog_id:null}));
  if(sourceArtwork)sourceRecords[1].track_id='i.previewBadBoy';
  const records = sourceArtwork ? sourceRecords : ledger ? ledgerRecords : mode === 'connected' ? [record] : [];
  const covers = {"1854820331": "assets/album-preview-holding-hands.jpg", "1854824118": "assets/album-preview-bad-boy.jpg", "535824738": "assets/album-preview-yeh-hui-mei.jpg", "536115195": "assets/album-preview-common-jasmin-orange.jpg", "1624001324": "assets/album-preview-capricorn.jpg", "536009642": "assets/album-preview-novembers-chopin.jpg"};
  const total = records.length;
  const json = (data,status=200) => Promise.resolve(new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}}));
  const note = text => { const target=document.getElementById('preview-note');if(target)target.textContent=text; };
  const tabUpdated = new Set(), tabRemoved = new Set();
  let nextTabId = 2, authorizationTab = null;
  window.chrome = {
    storage:{local:{get:async key=>({[key]:clone(store[key] ?? null)}),set:async value=>Object.assign(store,clone(value))}},
    permissions:{request:async()=>true,contains:async()=>true},
    runtime:{getURL:path=>new URL(path,location.origin+'/').href},
    tabs:{
      query:async()=>params.get('apple')==='missing'?[]:params.get('apple')==='multiple'?[{id:1,url:'https://music.apple.com/'},{id:2,url:'https://music.apple.com/tw/browse'}]:[{id:1,url:'https://music.apple.com/'}],
      getCurrent:async()=>({id:101,url:location.href}),
      create:async({url})=>{
        const destination=new URL(url), id=nextTabId++;
        if(destination.origin===store.installation?.origin && destination.pathname==='/api/v1/connections/lastfm/extension/authorize') {
          authorizationTab={id,url,callback:destination.origin+'/api/v1/connections/lastfm/extension/result'};
          note('模拟 Last.fm 授权已打开。点击「模拟授权返回」才会连接演示账户，不会访问真实网站。');
        } else note('模拟打开：'+destination.hostname+'。不会连接真实网站。');
        return {id,url};
      },
      update:async(id)=>({id,url:id===101?location.href:authorizationTab?.url}),
      remove:async(id)=>{if(authorizationTab?.id===id)authorizationTab=null;for(const listener of tabRemoved)listener(id,{windowId:1,isWindowClosing:false});},
      onUpdated:{addListener:listener=>tabUpdated.add(listener),removeListener:listener=>tabUpdated.delete(listener)},
      onRemoved:{addListener:listener=>tabRemoved.add(listener),removeListener:listener=>tabRemoved.delete(listener)}
    },
    scripting:{executeScript:async()=>[{result:params.get('apple')==='signed-out'?{error:'not_signed_in'}:{credentials:{apple_dev_token:'preview-developer-token',apple_user_token:'preview-user-token'}}}]}
  };
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(clipboardFailures>0){clipboardFailures--;throw new DOMException('Preview clipboard denied','NotAllowedError');}clipboard=text;note('已模拟复制（仅保存在预览内存）。');}}});
  if(!navigator.locks) Object.defineProperty(navigator,'locks',{value:{request:async(_name,_options,fn)=>fn({name:'preview-lock'})}});
  const workerAsset = ${JSON.stringify(worker)};
  window.fetch = async (input,options={}) => {
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    const method=(options.method||'GET').toUpperCase();
    if(url.origin===location.origin && url.pathname==='/worker.bundle.txt') return new Response(workerAsset,{status:200,headers:{'Content-Type':'text/plain'}});
    if(url.origin==='https://api.cloudflare.com') {
      const path=url.pathname.replace('/client/v4','');
      const ok=result=>json({success:true,result});
      if(path==='/user/tokens/verify')return ok({status:'active'});
      if(path==='/accounts') return mode==='error' ? json({success:false,errors:[{message:'Preview permission denied'}]},403) : ok([{id:'11111111111111111111111111111111',name:'演示账户 · 不会部署真实资源'}]);
      if(path.endsWith('/workers/subdomain'))return ok({subdomain:'preview'});
      if(path.endsWith('/settings'))return installed ? ok({compatibility_date:'2026-09-08',bindings:[{name:'INSTALLATION_ID',type:'plain_text',text:store.installation?.marker},{name:'INSTALLER_ALGORITHM',type:'plain_text',text:backendVersion},{name:'DEPLOYMENT_ACCOUNT_ID',type:'plain_text',text:store.installation?.account},{name:'DEPLOYMENT_WORKER_NAME',type:'plain_text',text:store.installation?.name},{name:'STATUS_AUTH_KEY',type:'secret_text'},{name:'ASCROBBLE_STATE',type:'kv_namespace',namespace_id:store.installation?.namespace},{name:'SCROBBLE_COORDINATOR',type:'durable_object_namespace',class_name:'ScrobbleCoordinator',namespace_id:'f'.repeat(32)}]}) : json({success:false},404);
      if(path.endsWith('/storage/kv/namespaces')) {
        if(method==='POST') {namespace={id:'44444444444444444444444444444444',title:JSON.parse(options.body).title};return ok(namespace);}
        return ok(namespace?[namespace]:[]);
      }
      if(/\\/workers\\/scripts\\/ams-[a-f0-9]{24}$/.test(path)&&method==='PUT'){installed=true;backendVersion='0.3.111';backendHash='531b2090c8a640c059cf0f713c53192099ee3a9da1f25243df39622ada3a2794';return ok({id:'preview-worker'});}
      if(path.endsWith('/subdomain')&&method==='POST')return ok({enabled:true});
      return json({success:false,error:'unknown_preview_route'},404);
    }
    if(url.hostname.endsWith('.preview.workers.dev')) {
      if(url.pathname==='/health')return json({version:backendVersion,algorithm_sha256:backendHash,capabilities:{lastfm_extension_auth:true,apple_source_artwork:true,apple_artwork_diagnostics:true,apple_artwork_runtime:'workerd-manual-v1',recording_diagnostics:true}});
      if(url.pathname==='/api/v1/connections/apple'&&method==='POST'){apple=true;if(recordingIssue?.code==='apple_reconnect_required')recordingIssue=null;return json({ok:true,connected:true,verified:true});}
      if(url.pathname==='/api/v1/connections/lastfm/application'&&method==='PUT'){configured=true;return json({ok:true});}
      if(url.pathname==='/api/v1/connections/lastfm/extension/start'&&method==='POST')return configured?json({browser_url:url.origin+'/api/v1/connections/lastfm/extension/authorize?flow='+'a'.repeat(64),callback_url:url.origin+'/api/v1/connections/lastfm/extension/result'}):json({error:'lastfm_application_required'},400);
      if(url.pathname==='/api/v1/connections')return json({apple:{connected:apple},lastfm:{connected:lastfm,application_configured:configured,...(lastfm?{username}:{})}});
      if(url.pathname==='/api/v1/recording/start'&&method==='POST'){enabled=true;return json({ok:true,enabled:true});}
      if(url.pathname==='/api/v1/recording/pause'&&method==='POST'){enabled=false;return json({ok:true,enabled:false});}
      if(url.pathname==='/api/v1/artwork') {
        const trackId=url.searchParams.get('track_id'), catalogId=url.searchParams.get('catalog_id');
        const visible=records.find(entry=>trackId?entry.track_id===trackId:String(entry.catalog_id)===catalogId);
        const coverId=trackId==='i.previewBadBoy'?'1854824118':trackId||catalogId;
        return json({artwork_url:visible?(covers[coverId]??null):null});
      }
      if(url.pathname==='/api/v1/recording')return json({enabled,recording_issue:recordingIssue,algorithm_version:backendVersion,algorithm_sha256:backendHash,last_run_iso:enabled?(ledger?'2026-10-25T03:45:00.000Z':'2026-10-23T14:03:00.000Z'):null,next_run_ms:enabled?(ledger?Date.parse('2026-10-25T03:48:00.000Z'):1792764360000):null,pending_identity:0,pending_submission:0,stats:{total_scrobbled:total,last_error_message:null},records});
    }
    throw new TypeError('本地预览已阻止网络请求');
  };
  document.addEventListener('DOMContentLoaded',()=>{
    const toolbar=document.createElement('aside');toolbar.id='preview-toolbar';toolbar.setAttribute('aria-label','本地预览工具');
    const title=document.createElement('strong');title.textContent='本地交互预览 · 模拟账户'+(ledger?' · '+records.length+'条演示记录':'');toolbar.appendChild(title);
    const message=document.createElement('span');message.id='preview-note';message.textContent=sourceArtwork?'模拟按 Apple 原始 track_id 获取封面，含资料库歌曲；图片为本地演示素材，无真实 API 请求。':'无网络、无持久保存；刷新即重置。';toolbar.appendChild(message);
    const grant=document.createElement('button');grant.textContent='模拟授权返回';grant.type='button';grant.onclick=()=>{
      if(!configured){note('先模拟保存 Last.fm 应用配置，再模拟授权。');return;}
      if(!authorizationTab){note('先在连接页点击「前往 Last.fm 授权」，再模拟授权返回。');return;}
      const returned={...authorizationTab,url:authorizationTab.callback+'?result=connected'};
      if(recordingIssue?.code==='queue_account_changed')username=recordingIssue.queue_owner;
      if(['queue_account_changed','lastfm_reconnect_required'].includes(recordingIssue?.code))recordingIssue=null;
      lastfm=true;note('模拟已授权 '+username+'；正在回到当前连接页。');
      for(const listener of tabUpdated)listener(returned.id,{url:returned.url},{id:returned.id,url:returned.url});
    };toolbar.appendChild(grant);
    if(recordingIssue){const recovered=document.createElement('button');recovered.type='button';recovered.textContent='模拟服务恢复';recovered.onclick=()=>{recordingIssue=null;window.dispatchEvent(new Event('focus'));note('模拟后台错误已清除。点击刷新查看最新状态，不会启动或提交真实记录。');};toolbar.appendChild(recovered);}
    document.body.appendChild(toolbar);
    document.addEventListener('click',event=>{const a=event.target.closest?.('a');if(!a)return;try{const u=new URL(a.href);if(a.id==='more-history'&&u.origin==='https://www.last.fm'&&u.pathname==='/user/DemoListener')return;if(u.origin!==location.origin){event.preventDefault();note('模拟外部链接：'+u.hostname+'。不会打开真实网站。');}}catch{}},true);
  });
})();`;
}
const previewCss = `#preview-toolbar{position:static;max-width:1200px;margin:0 auto 24px;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:12px 20px;color:#615955;border-top:1px solid #c7bfba;font:12px/1.5 system-ui}#preview-toolbar strong{font-weight:500}#preview-toolbar button{padding:7px 12px;background:transparent;color:inherit;border:1px solid currentColor;border-radius:6px;cursor:pointer;font:inherit}#preview-toolbar button:focus-visible{outline:2px solid #bd3a2b;outline-offset:3px}:root[data-theme="dark"] #preview-toolbar{color:#aba39f;border-color:#413c39}@media(max-width:600px){#preview-toolbar{margin-inline:20px;padding-inline:0}#preview-toolbar span{flex-basis:100%}}`;
const server = createServer(async (req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    const path = new URL(req.url || "/", "http://127.0.0.1:" + port).pathname;
    if (path === "/install") {
      res.writeHead(302, { Location: "/install/" });
      res.end();
      return;
    }
    let body: string | Buffer;
    let ext = path.split(".").pop() || "html";
    if (path === "/preview-runtime.js") {
      body = previewRuntime(
        await readFile(
          resolve(root, "dist/browser-extension/worker.bundle.txt"),
          "utf8",
        ),
      );
      ext = "js";
    } else if (path === "/preview.css") {
      body = previewCss;
      ext = "css";
    } else if (path === "/" || path === "/app.html") {
      body = (
        await readFile(resolve(root, "dist/browser-extension/app.html"), "utf8")
      ).replace(
        '<script src="app.js"',
        '<script src="preview-runtime.js"></script><link rel="stylesheet" href="preview.css" /><script src="app.js"',
      );
      ext = "html";
    } else if (
      themeStyleFiles.includes(path.slice(1)) ||
      themeAssetFiles.includes(path.slice(1)) ||
      /^\/(app\.(js|css)|worker\.bundle\.txt|assets\/brand-icon-(16|32|48|64|128)\.png|icons\/[a-z0-9-]+\.(svg|png))$/.test(
        path,
      )
    ) {
      body = await readFile(
        resolve(root, "dist/browser-extension", path.slice(1)),
      );
    } else if (/^\/install\/?$/.test(path)) {
      body = await readFile(resolve(root, "dist/site/index.html"));
      ext = "html";
    } else if (
      /^\/install\/(index\.html|style\.css|guide\.js|wizard\.js|release\.json|assets\/brand-icon-(16|32|48|64|128)\.png|browser-extension\.zip)$/.test(
        path,
      )
    ) {
      body = await readFile(
        resolve(root, "dist/site", path.slice("/install/".length)),
      );
    } else {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.setHeader("Content-Type", mime[ext] || "application/octet-stream");
    res.writeHead(200);
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404);
    res.end("Preview asset not found. Run npm run build first.");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Local interaction preview: http://127.0.0.1:${port}/ (simulation only)`,
  ),
);
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
