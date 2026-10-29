// Fail closed even when an inherited test restores its initial global fetch.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
const denied=()=>{throw new Error('OFFLINE_ONLY: network access denied');};
globalThis.fetch=denied;
http.request=http.get=https.request=https.get=denied;
net.connect=net.createConnection=tls.connect=dgram.createSocket=denied;
syncBuiltinESMExports();
// All allowlisted timer uses are provider pacing or retry waits. Execute them
// virtually; native AbortSignal.timeout stays intact for timeout response mocks.
let now=Date.parse('2026-09-13T03:00:00Z');
const NativeDate=Date;
globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
globalThis.setTimeout=(callback,ms,...args)=>{now+=Number(ms)||0;queueMicrotask(()=>callback(...args));return 1;};
globalThis.clearTimeout=()=>{};
