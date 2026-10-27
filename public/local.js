'use strict';
const cloud=(()=>{
const encoder=new TextEncoder();
const text=(v,max)=>typeof v==='string'&&v.length<=max;
const id=v=>text(v,100)&&/^[a-zA-Z0-9_-]+$/.test(v);
const date=v=>text(v,10)&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!isNaN(Date.parse(v));
const time=v=>v===''||typeof v==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v);
function validate(d,enforceLimit=true){
  const bad=()=>{throw Error('데이터 형식이 맞지 않아요. 원래 앱에서 내보낸 백업을 사용해 주세요.')};
  if(!d||!text(d.nick,12)||!date(d.joined)||!Array.isArray(d.cats)||!d.cats.length||!Array.isArray(d.tasks)||!Array.isArray(d.routines??[]))bad();
  if(!text(d.photo||'',100000)||d.photo&&!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d.photo))bad();
  const seen=new Set();
  for(const c of d.cats){if(!id(c.id)||seen.has(c.id)||!text(c.name,12)||!c.name.trim())bad();seen.add(c.id)}
  const tids=new Set(),rids=new Set();
  for(const t of d.tasks){if(!id(t.id)||tids.has(t.id)||!text(t.title,60)||!date(t.date)||!seen.has(t.cat)||typeof t.done!=='boolean'||!time(t.time||'')||!text(t.note||'',200)||(t.rid&&!id(t.rid)))bad();tids.add(t.id)}
  for(const r of d.routines||[]){
    if(!id(r.id)||rids.has(r.id)||!text(r.title,40)||!seen.has(r.cat)||!date(r.start)||!['weekly','interval','monthly'].includes(r.type)||!time(r.time||'')||!text(r.note||'',200))bad();
    if(r.type==='weekly'&&(!Array.isArray(r.days)||!r.days.length||r.days.some(v=>!Number.isInteger(v)||v<0||v>6)))bad();
    if(r.type==='interval'&&(!Number.isInteger(r.n)||r.n<2||r.n>30))bad();
    if(r.type==='monthly'&&(!Number.isInteger(r.day)||r.day<1||r.day>31))bad();
    if(r.skips&&(!Array.isArray(r.skips)||r.skips.some(v=>!date(v))))bad();rids.add(r.id);
  }
  // Copy permitted fields only, including IDs used in HTML attributes.
  const result={nick:d.nick,photo:d.photo||'',joined:d.joined,settings:{hideDone:!!d.settings?.hideDone},
    cats:d.cats.map(c=>({id:c.id,name:c.name,collapsed:!!c.collapsed})),
    tasks:d.tasks.map(t=>({id:t.id,title:t.title,date:t.date,done:t.done,cat:t.cat,time:t.time||'',note:t.note||'',...(t.rid?{rid:t.rid}:{})})),
    routines:(d.routines||[]).map(r=>({id:r.id,title:r.title,cat:r.cat,type:r.type,start:r.start,days:[...(r.days||[])],n:r.n||2,day:r.day||1,time:r.time||'',note:r.note||'',skips:[...(r.skips||[])]}))};
  if(enforceLimit&&encoder.encode(JSON.stringify(result)).length>4000000)throw Error('저장 용량에 가까워졌어요. 백업을 내보내고 오래된 할 일을 정리해 주세요.');
  return result;
}

const STORAGE_LIMIT=4000000;
function storageInfo(data){
  const used=encoder.encode(JSON.stringify(validate(data,false))).length;
  return {used,limit:STORAGE_LIMIT,remaining:Math.max(0,STORAGE_LIMIT-used),percent:used/STORAGE_LIMIT*100};
}
function planCleanup(data,before=null){
  if(before!==null&&!date(before))throw Error('정리할 기간을 확인해 주세요.');
  // validate returns a separate copy: previewing or a failed save never mutates
  // the active data. Include routine exceptions in the exact space estimate.
  const next=validate(data,false),initial=storageInfo(next).used;
  const removed=next.tasks.filter(task=>task.done&&(before===null||task.date<before));
  const removeIds=new Set(removed.map(task=>task.id));
  const routines=new Map(next.routines.map(routine=>[routine.id,routine]));
  for(const task of removed){
    const routine=routines.get(task.rid);
    if(routine&&!routine.skips.includes(task.date))routine.skips.push(task.date);
  }
  // A removed completed routine occurrence must not reappear as unfinished.
  next.tasks=next.tasks.filter(task=>!removeIds.has(task.id));
  const after=storageInfo(next).used;
  return {data:next,count:removed.length,before:initial,after,freed:Math.max(0,initial-after)};
}

const KEY='todo.personal.local.v1';
let hooks,raw=null,lastSaveOk=true;
function status(text){hooks.onStatus(text)}
function start(options){
  hooks=options;
  try{
    raw=localStorage.getItem(KEY);
    const data=raw===null?options.defaults():validate(JSON.parse(raw));
    // Confirm writing works before presenting a persistent app.
    localStorage.setItem(KEY,JSON.stringify(data));
    hooks.onData('local',data);status('이 기기에 저장됨 · 백업은 사용자 탭에서');
    if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
    window.addEventListener('storage',event=>{
      if(event.key!==KEY)return;
      try{
        if(event.newValue===null){status('저장 데이터가 외부에서 지워졌어요 · 백업을 내보내 주세요');return}
        hooks.onData('local',validate(JSON.parse(event.newValue)));status('다른 창의 변경을 반영했어요');
      }catch(e){hooks.onError('다른 창의 저장 데이터를 읽지 못했어요. 백업을 내보내 주세요.')}
    });
  }catch(e){hooks.onError(raw!==null?'저장 데이터를 열지 못했어요. 원본 내려받기로 먼저 보관해 주세요.':'이 환경에서는 저장할 수 없어요. 일반 Safari 창에서 다시 열어 주세요.')}
}
function save(data){
  try{const clean=validate(data);localStorage.setItem(KEY,JSON.stringify(clean));lastSaveOk=true;status('이 기기에 저장됨 · 백업은 사용자 탭에서');return true}
  catch(e){lastSaveOk=false;status('저장 실패 · 백업을 꼭 내보내 주세요');hooks.onError('저장에 실패했어요. 사용자 탭에서 백업을 내보내고 저장 공간을 확인해 주세요.');return false}
}
return {start,save,validate,storageInfo,planCleanup,get lastSaveOk(){return lastSaveOk},get raw(){return raw}};
})();
