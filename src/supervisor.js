import 'dotenv/config';import {fork} from 'node:child_process';
const children=new Map(),timers=new Set();let stopping=false;
function start(file){const child=fork(new URL(file,import.meta.url),[],{stdio:'inherit'});children.set(file,child);child.on('exit',(code,signal)=>{children.delete(file);if(!stopping){console.error(`${file} exited (${code||signal}); restarting in 5 seconds`);const t=setTimeout(()=>{timers.delete(t);start(file);},5000);timers.add(t);}});}
for(const file of ['server.js','run-sales.js','run-meta.js','run-delivery.js','run-ai.js'])start(file);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(stopping)return;stopping=true;for(const t of timers)clearTimeout(t);for(const c of children.values())c.kill(signal);setTimeout(()=>process.exit(0),8000).unref();});
