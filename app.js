'use strict';
const $ = s => document.querySelector(s);
const element = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const defaults = {
  destinationOptions:['1','2','3'],
  cars: [{id:'A',destination:'1',length:15},{id:'B',destination:'2',length:15},{id:'C',destination:'3',length:15},{id:'D',destination:'1',length:15}],
  tracks: [{name:'I',capacity:120,initial:['D','C'],goal:['A','D','B','C']},{name:'II',capacity:130,initial:['B','A'],goal:[]},{name:'III',capacity:140,initial:[],goal:[]}],
  headshunt:100, locomotive:20, timeLimit:10, objective:'time', weight:350, poolSize:100, initialTrack:1,
  goalMode:'paper', destinationOrder:['1','2','3'], shuntingSpeed:16, ladderSpeed:10, trackSpacing:3, timeConstant:13500, timePerCar:517.5,
  rewards:{shunting1:1,shunting2:2,shunting3:0,skipping1:1,skipping2:2,holding1:0,holding2:0.1,virtual2:0}
};
let cars = [], tracks = [], destinationOptions = [], destinationOrder = [], result = null, currentStep = 0, busy = false, destinationFeedbackTimer = null, inspectorLiveTimer = null, yardZoom = 1, yardInspectorContext = null;
const fields = ['headshunt','locomotive','timeLimit','objective','weight','poolSize','initialTrack','shuntingSpeed','ladderSpeed','trackSpacing','timeConstant','timePerCar'];
const rewardFields = {rewardShunting1:'shunting1',rewardShunting2:'shunting2',rewardShunting3:'shunting3',rewardSkipping1:'skipping1',rewardSkipping2:'skipping2',rewardHolding1:'holding1',rewardHolding2:'holding2',rewardVirtual2:'virtual2'};
const secs = v => `${v.toFixed(2)} 秒`;
function duration(v) { const cents = Math.round(v * 100), m = Math.floor(cents / 6000), s = (cents % 6000) / 100; return `${m}分${s.toFixed(2)}秒`; }
function status(text, kind = '') { $('#solveStatus').className = `status-pill ${kind}`; $('#solveStatus').textContent = text; }
function error(message) { $('#validation').textContent = message; $('#validation').classList.remove('hidden'); status('请检查输入', 'error'); }
function clearError() { $('#validation').classList.add('hidden'); }
function invalidate(clearCaseName=true) {
  if(clearCaseName&&$('#caseName')){$('#caseName').value='';$('#caseName').setCustomValidity('');}
  if (result) { result = null; $('#solutionResult').classList.add('hidden'); $('#emptyResult').classList.remove('hidden'); $('#downloadResult').disabled = true; }
  status('配置待求解');
}
function switchView(name) {
  document.querySelectorAll('.app-view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));
  document.querySelectorAll('.nav-tab').forEach(v=>{const on=v.dataset.view===name;v.classList.toggle('active',on);v.setAttribute('aria-current',on?'step':'false');});
  if(name==='records')loadRecords();
  if(name==='solution')populateHistoryCases();
  window.scrollTo({top:0,behavior:'smooth'});
}
const roman = value => {
  const pairs=[[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
  let n=value,out='';for(const [v,s] of pairs)while(n>=v){out+=s;n-=v;}return out;
};
const nextCarId = () => { for(let n=0;;n++){let x=n,s='';do{s=String.fromCharCode(65+x%26)+s;x=Math.floor(x/26)-1;}while(x>=0);if(!cars.some(c=>c.id===s))return s;} };
const splitIds = text => text.split(/[,，\s]+/).filter(Boolean);
const unique = values => [...new Set(values.map(v=>String(v).trim()).filter(Boolean))];
function syncDestinationOrder(preferred=destinationOrder){
  const used=unique(cars.map(c=>c.destination));
  destinationOrder=[...preferred.filter(v=>used.includes(v)),...used.filter(v=>!preferred.includes(v))];
}
function destinationColors(destination){
  const value=String(destination),known=destinationOptions.indexOf(value),index=known>=0?known:[...value].reduce((sum,char)=>sum+char.codePointAt(0),0),hue=Math.round((index*137.508+208)%360);
  return {background:`hsl(${hue} 72% 87%)`,border:`hsl(${hue} 52% 45%)`,text:`hsl(${hue} 58% 19%)`};
}
function renderDestinationLegend(){
  const root=$('#destinationLegend');if(!root)return;root.replaceChildren();
  unique(cars.map(c=>c.destination)).forEach(destination=>{const colors=destinationColors(destination),item=element('span','destination-legend-item'),swatch=element('i');swatch.style.background=colors.background;swatch.style.borderColor=colors.border;item.append(swatch,document.createTextNode(`去向 ${destination}`));root.append(item);});
}
function renderDestinationManager(){
  const root=$('#destinationList');root.replaceChildren();
  destinationOptions.forEach(destination=>{const colors=destinationColors(destination),chip=element('span','destination-chip'),swatch=element('i'),label=element('b','',destination),remove=removeButton(`删除去向${destination}`,()=>removeDestination(destination));swatch.style.background=colors.background;swatch.style.borderColor=colors.border;chip.append(swatch,label,remove);root.append(chip);});
  renderDestinationLegend();populateQuickDestinationSelect();
}
function populateQuickDestinationSelect(){const select=$('#inspectorVehicleDestination');if(!select)return;const current=select.value;select.replaceChildren();destinationOptions.forEach(destination=>{const option=element('option','',destination);option.value=destination;option.selected=destination===current;select.append(option);});}
function addDestination(){
  const input=$('#newDestination'),value=input.value.trim();
  if(!value){clearError();showDestinationFeedback('请输入要添加的去向名称。',true);input.focus();return;}
  if(destinationOptions.includes(value)){clearError();showDestinationFeedback(`去向“${value}”已经存在，请勿重复添加。`,true);input.focus();input.select();return;}
  destinationOptions.push(value);input.value='';showDestinationFeedback(`已添加去向“${value}”。`);clearError();renderDestinationManager();renderEditors();invalidate();renderInitialPreview();
}
function showDestinationFeedback(message,isError=false){const feedback=$('#destinationFeedback');clearTimeout(destinationFeedbackTimer);feedback.textContent=message;feedback.classList.remove('hidden','error');if(isError)feedback.classList.add('error');destinationFeedbackTimer=setTimeout(()=>{feedback.classList.add('hidden');feedback.classList.remove('error');feedback.textContent='';},3000);}
function removeDestination(destination){
  if(cars.some(c=>c.destination===destination))return error(`仍有车辆选择去向“${destination}”，请先修改这些车辆。`);
  if(destinationOptions.length<=1)return error('至少保留一个车辆去向。');
  destinationOptions=destinationOptions.filter(v=>v!==destination);syncDestinationOrder();clearError();renderDestinationManager();renderEditors();renderDestinationOrder();invalidate();renderInitialPreview();
}
function destinationSelect(car,index){
  const select=element('select');select.setAttribute('aria-label',`第${index+1}辆车去向`);
  destinationOptions.forEach(destination=>{const option=element('option','',destination);option.value=destination;option.selected=destination===car.destination;select.append(option);});
  select.addEventListener('change',()=>{car.destination=select.value;syncDestinationOrder();renderDestinationOrder();renderDestinationLegend();invalidate();renderInitialPreview();});return select;
}
function moveDestinationOrder(index,offset){
  const target=index+offset;if(target<0||target>=destinationOrder.length)return;
  [destinationOrder[index],destinationOrder[target]]=[destinationOrder[target],destinationOrder[index]];renderDestinationOrder();invalidate();
}
function renderDestinationOrder(){
  const root=$('#destinationOrderEditor');if(!root)return;syncDestinationOrder();root.replaceChildren();
  if(!destinationOrder.length){root.append(element('p','empty-inline','请先为车辆选择去向。'));return;}
  destinationOrder.forEach((destination,index)=>{const row=element('div','destination-order-row'),position=element('span','order-position',`第 ${index+1} 位`),select=element('select');select.setAttribute('aria-label',`第${index+1}位去向`);
    destinationOrder.forEach(value=>{const option=element('option','',value);option.value=value;option.selected=value===destination;select.append(option);});
    select.addEventListener('change',()=>{const other=destinationOrder.indexOf(select.value);[destinationOrder[index],destinationOrder[other]]=[destinationOrder[other],destinationOrder[index]];renderDestinationOrder();invalidate();});
    const controls=element('span','order-controls'),up=element('button','','↑'),down=element('button','','↓');up.type=down.type='button';up.disabled=index===0;down.disabled=index===destinationOrder.length-1;up.setAttribute('aria-label',`将去向${destination}上移`);down.setAttribute('aria-label',`将去向${destination}下移`);up.addEventListener('click',()=>moveDestinationOrder(index,-1));down.addEventListener('click',()=>moveDestinationOrder(index,1));controls.append(up,down);row.append(position,select,controls);root.append(row);
  });
}
function appendCarWithoutMovingOthers(field,id){
  const lengths=Object.fromEntries(cars.map(c=>[c.id,Number(c.length)||0]));
  for(const track of tracks){const row=splitIds(track[field]);if(YardModel.occupied(row,lengths)+lengths[id]<=Number(track.capacity)+1e-8){row.unshift(id);track[field]=row.join(',');return true;}}
  return false;
}
function addVehicle(car,report=error){
  const candidate={id:String(car.id||'').trim(),destination:String(car.destination||''),length:Number(car.length)};
  const fail=message=>{report(message);return false;};
  if(!candidate.id)return fail('请输入车辆ID。');
  if(cars.some(item=>item.id===candidate.id))return fail(`车辆ID“${candidate.id}”已经存在。`);
  if(!destinationOptions.includes(candidate.destination))return fail('请选择已有的车辆去向。');
  if(!Number.isFinite(candidate.length)||candidate.length<=0)return fail('车辆长度必须大于0。');
  const snapshot=tracks.map(track=>({initialText:track.initialText,goalText:track.goalText}));cars.push(candidate);
  if(!appendCarWithoutMovingOthers('initialText',candidate.id)||!appendCarWithoutMovingOthers('goalText',candidate.id)){cars.pop();tracks.forEach((track,index)=>Object.assign(track,snapshot[index]));return fail('现有股道容量不足，无法放入新车辆。请先增加股道或扩大股道长度。');}
  syncDestinationOrder();renderEditors();renderDestinationOrder();renderDestinationManager();invalidate();clearError();$('#dragHint').textContent=`车辆 ${candidate.id} 已加入首条容量允许股道的牵出线侧`;renderInitialPreview();return true;
}
function updateVehicle(originalId,car,report=error){
  const candidate={id:String(car.id||'').trim(),destination:String(car.destination||''),length:Number(car.length)},target=cars.find(item=>item.id===originalId),fail=message=>{report(message);return false;};
  if(!target)return fail(`未找到车辆“${originalId}”。`);if(!candidate.id)return fail('请输入车辆ID。');if(cars.some(item=>item.id===candidate.id&&item!==target))return fail(`车辆ID“${candidate.id}”已经存在。`);if(!destinationOptions.includes(candidate.destination))return fail('请选择已有的车辆去向。');if(!Number.isFinite(candidate.length)||candidate.length<=0)return fail('车辆长度必须大于0。');
  const nextRows=tracks.map(track=>({initialText:splitIds(track.initialText).map(id=>id===originalId?candidate.id:id),goalText:splitIds(track.goalText).map(id=>id===originalId?candidate.id:id)})),lengths=Object.fromEntries(cars.filter(item=>item!==target).map(item=>[item.id,Number(item.length)||0]));lengths[candidate.id]=candidate.length;
  for(let index=0;index<tracks.length;index++)for(const field of ['initialText','goalText'])if(YardModel.occupied(nextRows[index][field],lengths)>Number(tracks[index].capacity)+1e-8)return fail(`${tracks[index].name}道容量不足，无法把车辆长度修改为${candidate.length}米。`);
  target.id=candidate.id;target.destination=candidate.destination;target.length=candidate.length;tracks.forEach((track,index)=>{track.initialText=nextRows[index].initialText.join(',');track.goalText=nextRows[index].goalText.join(',');});syncDestinationOrder();renderEditors();renderDestinationOrder();renderDestinationManager();invalidate();clearError();$('#dragHint').textContent=`车辆 ${candidate.id} 参数已更新`;renderInitialPreview();return true;
}
function updateTrack(index,capacity,report=error){const value=Number(capacity),track=tracks[index],fail=message=>{report(message);return false;};if(!track)return fail('未找到需要编辑的股道。');if(!Number.isFinite(value)||value<=0)return fail('股道容量必须大于0。');const lengths=Object.fromEntries(cars.map(car=>[car.id,Number(car.length)||0]));for(const field of ['initialText','goalText'])if(YardModel.occupied(splitIds(track[field]),lengths)>value+1e-8)return fail(`${track.name}道现有车辆长度超过${value}米，无法保存。`);track.capacity=value;renderEditors();invalidate();clearError();$('#dragHint').textContent=`${track.name}道容量已更新为 ${value} 米`;renderInitialPreview();return true;}
function deleteVehicle(id){
  if(cars.length<=1)return error('至少保留一辆车。');cars=cars.filter(c=>c.id!==id);tracks.forEach(t=>{t.initialText=splitIds(t.initialText).filter(x=>x!==id).join(',');t.goalText=splitIds(t.goalText).filter(x=>x!==id).join(',');});syncDestinationOrder();renderEditors();renderDestinationOrder();renderDestinationManager();invalidate();clearError();$('#dragHint').textContent=`车辆 ${id} 已删除，同股道其余车辆已自动粘接`;renderInitialPreview();
}
function deleteTrack(index){
  if(tracks.length<=2)return error('算法至少需要两条股道，不能继续删除。');const target=index>0?index-1:1,lengths=Object.fromEntries(cars.map(c=>[c.id,Number(c.length)||0]));
  const merged={};for(const field of ['initialText','goalText']){merged[field]=[...splitIds(tracks[target][field]),...splitIds(tracks[index][field])];if(YardModel.occupied(merged[field],lengths)>Number(tracks[target].capacity)+1e-8)return error(`${tracks[target].name}道容量不足，无法接收被删除股道的${field==='initialText'?'初始':'目标'}车辆。`);}for(const field of Object.keys(merged))tracks[target][field]=merged[field].join(',');
  tracks.splice(index,1);tracks.forEach((t,i)=>t.name=roman(i+1));renderEditors();invalidate();clearError();$('#dragHint').textContent='股道已删除，原有车辆已转入相邻股道';renderInitialPreview();
}
function syncInitialTrackToLongest(){if(!tracks.length)return;let longest=0;for(let index=1;index<tracks.length;index++)if(Number(tracks[index].capacity)>Number(tracks[longest].capacity))longest=index;const input=$('#initialTrack');if(input){input.value=longest+1;input.max=tracks.length;input.title=`最长股道为 ${roman(longest+1)} 道，机车自动对应第 ${longest+1} 股道`;}}
function editInput(value, label, numeric, onChange, options={}) {
  const el = element('input'); el.value = value; el.type = numeric ? 'number' : 'text'; el.setAttribute('aria-label', label);
  const sizeSequence=()=>{if(options.sequence)el.style.width=`${Math.max(14,Math.min(72,el.value.length+3))}ch`;};if(options.sequence){el.classList.add('sequence-input');sizeSequence();}
  el.addEventListener('input', () => { sizeSequence();onChange(numeric ? Number(el.value) : el.value.trim()); invalidate(); renderInitialPreview(); }); return el;
}
function removeButton(label, onClick) { const b = element('button','icon-button','×'); b.type = 'button'; b.setAttribute('aria-label',label); b.addEventListener('click',onClick); return b; }
function header(container, cls, labels) { const h = element('div',`${cls} row-head`); labels.forEach(t => h.append(element('span','',t))); container.replaceChildren(h); }
function renderEditors() {
  header($('#carsEditor'),'data-row',['车辆ID','去向','长度(m)','']);
  cars.forEach((c,i) => { const row = element('div','data-row');
    row.append(editInput(c.id,`第${i+1}辆车ID`,false,v=>c.id=v), destinationSelect(c,i), editInput(c.length,`第${i+1}辆车长度`,true,v=>c.length=v), removeButton(`删除车辆${c.id}`,()=>deleteVehicle(c.id))); $('#carsEditor').append(row);
  });
  header($('#initialTracksEditor'),'initial-track-row',['股道','容量(m)','初始车辆顺序','']);
  header($('#goalTracksEditor'),'goal-track-row',['股道','最终车辆顺序']);
  tracks.forEach((t,i) => { const row=element('div','track-row');
    const nameCell=element('div','track-id-cell',roman(i+1));t.name=roman(i+1);
    row.className='initial-track-row';row.append(nameCell,editInput(t.capacity,`第${i+1}股道容量`,true,v=>{t.capacity=v;syncInitialTrackToLongest();}),editInput(t.initialText,`第${i+1}股道初始状态`,false,v=>t.initialText=v,{sequence:true}),removeButton(`删除股道${t.name}`,()=>deleteTrack(i)));$('#initialTracksEditor').append(row);
    const goalRow=element('div','goal-track-row');goalRow.append(element('div','track-id-cell',roman(i+1)),editInput(t.goalText,`第${i+1}股道目标状态`,false,v=>t.goalText=v,{sequence:true}));$('#goalTracksEditor').append(goalRow);
  });
  syncInitialTrackToLongest();
  renderDestinationOrder();
}
function applyConfig(raw) {
  // Validate before changing visible state: invalid agent input is transactional.
  const c=ShuntingSolver.validate(raw); cars=c.cars;
  destinationOptions=unique([...(Array.isArray(raw.destinationOptions)?raw.destinationOptions:[]),...c.destinationOrder,...cars.map(car=>car.destination)]);destinationOrder=[...c.destinationOrder];syncDestinationOrder();
  tracks=c.tracks.map((t,i)=>({...t,name:roman(i+1),initialText:t.initial.join(','),goalText:t.goal.join(',')}));
  fields.forEach(id=>$('#'+id).value=c[id]); Object.entries(rewardFields).forEach(([id,key])=>$('#'+id).value=c.rewards[key]);
  document.querySelector(`input[name="goalMode"][value="${c.goalMode}"]`).checked=true;
  renderDestinationManager();renderEditors(); updateGoalMode(); invalidate(); clearError(); updateFormula(); renderInitialPreview();
}
function collect() {
  syncDestinationOrder();const c={destinationOptions:[...destinationOptions],cars:structuredClone(cars),tracks:tracks.map(t=>({name:t.name,capacity:t.capacity,initial:splitIds(t.initialText),goal:splitIds(t.goalText)})),goalMode:document.querySelector('input[name="goalMode"]:checked').value,destinationOrder:[...destinationOrder],rewards:{}};
  fields.forEach(id=>c[id]=id==='objective'?$('#'+id).value:Number($('#'+id).value));Object.entries(rewardFields).forEach(([id,key])=>c.rewards[key]=Number($('#'+id).value));return ShuntingSolver.validate(c);
}
function updateFormula() {}
function lock(value) { busy=value; document.querySelectorAll('.config-panel input,.config-panel select,.config-panel button').forEach(e=>e.disabled=value); $('#solveButton span').textContent=value?'正在搜索…':'开始求解'; }
function solveOnMainThread(config) {
  status('兼容模式求解中 · 请勿关闭页面','working');
  return new Promise((resolve,reject)=>setTimeout(()=>{try{resolve(ShuntingSolver.solve(config,stats=>status(`兼容模式 · 已扩展 ${stats.expanded} 个节点`,'working')));}catch(e){reject(e);}},30));
}
function solveWithWorker(config) {
  return new Promise((resolve,reject)=>{
    let worker;try{worker=new Worker('./solver-worker.js');}catch(e){reject(e);return;}
    worker.onmessage=({data})=>{if(data.type==='progress')status(`搜索中 · ${data.stats.expanded} 个节点`,'working');else{worker.terminate();if(data.type==='result')resolve(data.result);else reject(Error(data.message));}};
    worker.onerror=e=>{worker.terminate();reject(Error(e.message||'无法加载算法Worker。'));};worker.postMessage(config);
  });
}
async function runSolver() {
  if(busy)throw Error('已有求解任务在运行。'); clearError(); let config;
  try { config=collect(); } catch(e) { error(e.message); return null; }
  const requestedTitle=$('#caseName').value.trim();
  if(requestedTitle){try{if(await isDuplicateCaseTitle(requestedTitle)){const message='案例名称已存在，请使用其他名称。';$('#caseName').setCustomValidity(message);showToast(message,'error');$('#caseName').focus();return null;}}catch(_){}}
  invalidate(false); lock(true); status('正在求解','working');
  try {
    const engine=$('#solverEngine').value;let answer;
    if(engine==='gurobi'){
      const endpoint=$('#gurobiEndpoint').value.trim();if(!endpoint)throw Error('请选择或填写Gurobi API地址。');status('Gurobi正在求解','working');
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});
      let payload;try{payload=await response.json();}catch(_){throw Error(`Gurobi服务返回了无法解析的数据（HTTP ${response.status}）。`);}
      if(!response.ok)throw Error(payload.detail||payload.message||`Gurobi服务请求失败（HTTP ${response.status}）。`);answer=payload.result||payload;
    }else{
      if(location.protocol==='file:'||typeof Worker==='undefined')answer=await solveOnMainThread(config);
      else try{answer=await solveWithWorker(config);}catch(workerError){console.warn('Web Worker不可用，切换主线程兼容模式。',workerError);answer=await solveOnMainThread(config);}
    }
    renderResult(answer);try{await saveSolvedCase(answer,requestedTitle);}catch(storageError){showToast(storageError.message||'案例保存失败。','error');}switchView('solution'); return answer;
  } catch(e) { error(e.message); return null; } finally { lock(false); }
}
function labelStatus(r) { return {optimal:'当前模型最优',feasible:'当前可行解',infeasible:'当前模型无解',no_solution_found:'预算内未找到'}[r.status]; }
function renderResult(answer) {
  result=answer; currentStep=0; $('#emptyResult').classList.add('hidden'); $('#solutionResult').classList.remove('hidden'); $('#downloadResult').disabled=false;
  $('#metricStatus').textContent=labelStatus(result);
  $('#metricDuration').textContent=result.totalTimeSeconds===null?'—':duration(result.totalTimeSeconds);
  $('#metricSeconds').textContent=result.totalTimeSeconds===null?'—':`合计 ${result.totalTimeSeconds.toFixed(2)} 秒`;
  $('#metricSteps').textContent=result.roundCount===null?'—':`${result.roundCount} 轮 / ${result.operationCount} 步`;
  $('#metricCompute').textContent=secs(result.statistics.elapsedSeconds);
  const term={exhausted:'搜索结束',initial_is_goal:'初始即为目标',time_limit:'达到时间上限',node_limit:'达到外层节点上限',san_node_limit:'达到SAN分支节点上限'}[result.termination]||result.termination;
  const engineLabel=result.solverEngine==='gurobi'?'Gurobi SAN整数规划':'浏览器内置SAN';const goalLabel=result.goalMode==='paper'?`论文模式（去向顺序 ${result.destinationOrder.join(' → ')}，终到股道可选）`:'自定义精确终态';
  $('#resultContext').textContent=`引擎：${engineLabel}；终态：${goalLabel}；目标：${result.objective==='time'?'最短总调车时间':'最少宏动作轮数（非论文时间目标）'}；本次 w = ${result.weight}；每个源股道解池 = ${result.poolSize||'不截断'}；扩展 ${result.statistics.expanded} 个状态 / ${result.statistics.sanModels} 个SAN子问题。${term}。${result.candidatePoolRestricted?'存在解池截断，不能证明全局最优。':result.optimalityProven?'最优性仅限当前动作空间。':'尚未获得最优性证明。'}`;
  $('#breakdownLadder').textContent=result.timeBreakdown?secs(result.timeBreakdown.ladderSeconds):'— 秒';
  $('#breakdownEntry').textContent=result.timeBreakdown?secs(result.timeBreakdown.entrySeconds):'— 秒';
  $('#breakdownExit').textContent=result.timeBreakdown?secs(result.timeBreakdown.exitSeconds):'— 秒';
  $('#timeline').replaceChildren();
  function item(i,title,detail) { const li=element('li'), b=element('button'); b.type='button'; b.append(element('strong','',title),element('br'),document.createTextNode(detail)); b.addEventListener('click',()=>displayStep(i));li.append(b);$('#timeline').append(li); }
  item(0,'初始状态','累计用时 0.00 秒');
  result.operations.forEach(op=>item(op.step,`${op.step}. ${op.kind==='PULL'?'牵出 / 连挂':'推送 / 摘挂'} · ${op.trackName}道（${op.track}号）`,`${op.cars.join('、')} · 第${op.round}轮 · 本步${secs(op.durationSeconds)} · 累计${secs(op.cumulativeSeconds)}`));
  $('#timeTable').replaceChildren();
  result.operations.forEach(op=>{const tr=element('tr');[`${op.step} / ${op.round}`,op.kind==='PULL'?'牵出':'推送',`${op.track} · ${op.trackName}`,op.cars.join('、'),op.ladderSeconds.toFixed(2),op.entrySeconds.toFixed(2),op.exitSeconds.toFixed(2),op.durationSeconds.toFixed(2),op.cumulativeSeconds.toFixed(2)].forEach(t=>tr.append(element('td','',t)));$('#timeTable').append(tr);});
  if(result.totalTimeSeconds!==null){const tr=element('tr');['合计','','','',result.timeBreakdown.ladderSeconds.toFixed(2),result.timeBreakdown.entrySeconds.toFixed(2),result.timeBreakdown.exitSeconds.toFixed(2),result.totalTimeSeconds.toFixed(2),result.totalTimeSeconds.toFixed(2)].forEach(t=>tr.append(element('th','',t)));$('#timeTable').append(tr);}
  displayStep(0); status(labelStatus(result),result.status==='optimal'?'success':result.status==='infeasible'?'error':'');
}
const recordApiEnabled=()=>location.protocol==='https:'&&location.hostname.endsWith('.chatgpt.site');
const localRecordKey='flatd-shunting-solved-cases-v1';
let selectedRecord=null,recordCache=[],pendingRecordsAction=null,renameOriginal='',lastDeletedRecord=null;
function readLocalRecords(){try{const records=JSON.parse(localStorage.getItem(localRecordKey)||'[]'),limited=records.slice(0,50);if(records.length!==limited.length)localStorage.setItem(localRecordKey,JSON.stringify(limited));return limited;}catch(_){return [];}}
function writeLocalRecords(records){localStorage.setItem(localRecordKey,JSON.stringify(records.slice(0,50)));}
const normalizeCaseTitle=value=>String(value||'').trim().toLocaleLowerCase('zh-CN');
async function isDuplicateCaseTitle(title,excludeId=null){const normalized=normalizeCaseTitle(title),records=await fetchRecordList();return records.some(record=>normalizeCaseTitle(record.title)===normalized&&String(record.id)!==String(excludeId??''));}
function defaultCaseTitle(createdAt){const date=new Date(createdAt);return `调车案例 ${date.toLocaleString('zh-CN',{hour12:false})}.${String(date.getMilliseconds()).padStart(3,'0')}`;}
async function saveSolvedCase(answer,customTitle=''){const createdAt=new Date().toISOString(),title=customTitle.trim()||defaultCaseTitle(createdAt),payload={title,createdAt,result:answer};if(recordApiEnabled()){const response=await fetch('/api/cases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(!response.ok)throw Error((await response.json().catch(()=>({}))).error||'案例保存服务暂不可用');return (await response.json()).case;}const records=readLocalRecords();if(records.some(record=>normalizeCaseTitle(record.title)===normalizeCaseTitle(title)))throw Error('案例名称已存在，请使用其他名称。');const record={id:`local-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,...payload};records.unshift(record);writeLocalRecords(records);return record;}
async function restoreSolvedCase(record){const payload={title:record.title,createdAt:record.createdAt,result:record.result};if(recordApiEnabled()){const response=await fetch('/api/cases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(!response.ok)throw Error((await response.json().catch(()=>({}))).error||'案例恢复失败');return (await response.json()).case;}const records=readLocalRecords();if(records.some(item=>normalizeCaseTitle(item.title)===normalizeCaseTitle(record.title)))throw Error('已有同名案例，无法撤销删除。');records.unshift(record);writeLocalRecords(records);return record;}
async function fetchRecordList(){if(recordApiEnabled()){const response=await fetch('/api/cases');if(!response.ok)throw Error('无法读取案例记录');return (await response.json()).cases||[];}return readLocalRecords().map(({id,title,createdAt,result})=>({id,title,createdAt,status:result.status,totalTimeSeconds:result.totalTimeSeconds,operationCount:result.operationCount||result.operations?.length||0}));}
async function fetchRecord(id){if(recordApiEnabled()){const response=await fetch(`/api/cases/${encodeURIComponent(id)}`);if(!response.ok)throw Error('无法读取案例详情');return (await response.json()).case;}return readLocalRecords().find(item=>String(item.id)===String(id))||null;}
async function updateRecordTitle(id,title){if(recordApiEnabled()){const response=await fetch(`/api/cases/${encodeURIComponent(id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title})});if(!response.ok)throw Error((await response.json().catch(()=>({}))).error||'案例重命名失败');return (await response.json()).case;}const records=readLocalRecords(),record=records.find(item=>String(item.id)===String(id));if(!record)throw Error('案例不存在或已被删除');if(records.some(item=>String(item.id)!==String(id)&&normalizeCaseTitle(item.title)===normalizeCaseTitle(title)))throw Error('案例名称已存在，请使用其他名称。');record.title=title;writeLocalRecords(records);return record;}
async function deleteStoredRecord(id){if(recordApiEnabled()){const response=await fetch(`/api/cases/${encodeURIComponent(id)}`,{method:'DELETE'});if(!response.ok)throw Error((await response.json().catch(()=>({}))).error||'案例删除失败');return;}const records=readLocalRecords(),next=records.filter(item=>String(item.id)!==String(id));if(next.length===records.length)throw Error('案例不存在或已被删除');writeLocalRecords(next);}
async function clearStoredRecords(){if(recordApiEnabled()){const response=await fetch('/api/cases',{method:'DELETE'});if(!response.ok)throw Error((await response.json().catch(()=>({}))).error||'案例清空失败');return;}writeLocalRecords([]);}
async function populateHistoryCases(){const select=$('#historyCaseSelect'),button=$('#loadHistoryCase');if(!select||!button)return;const previous=select.value;select.disabled=true;button.disabled=true;try{const records=await fetchRecordList();select.replaceChildren(new Option(records.length?'选择已保存案例':'暂无已保存案例',''));records.forEach(record=>{const option=new Option(`${record.title||'未命名案例'} · ${new Date(record.createdAt).toLocaleString('zh-CN',{hour12:false})}`,record.id);select.append(option);});if(records.some(record=>String(record.id)===previous))select.value=previous;select.disabled=!records.length;button.disabled=!select.value;}catch(_){select.replaceChildren(new Option('历史案例读取失败',''));select.disabled=true;}}
async function loadHistoricalCase(){const id=$('#historyCaseSelect').value;if(!id)return;const button=$('#loadHistoryCase');button.disabled=true;button.textContent='正在载入…';try{const record=await fetchRecord(id);if(!record?.result)throw Error('案例数据不完整');renderResult(record.result);status(`已载入历史案例 · ${record.title||'未命名案例'}`,'success');window.scrollTo({top:0,behavior:'smooth'});}catch(error){status(error.message,'error');}finally{button.textContent='载入案例';button.disabled=!$('#historyCaseSelect').value;}}
function showToast(message,kind='info'){if(!message)return;const root=$('#toastRegion'),toast=element('div',`toast ${kind}`),icon=element('span','toast-icon',kind==='error'?'!':'✓'),text=element('span','',message),close=element('button','toast-close','×');close.type='button';close.setAttribute('aria-label','关闭提示');const remove=()=>{toast.classList.add('leaving');setTimeout(()=>toast.remove(),180);};close.addEventListener('click',remove);toast.append(icon,text,close);root.append(toast);setTimeout(remove,3000);}
function showRecordsMessage(message='',kind='info'){if(message)showToast(message,kind);}
function renderRecordList(){const list=$('#recordsList'),query=$('#recordSearch').value.trim().toLocaleLowerCase('zh-CN'),records=recordCache.filter(record=>`${record.title||''} ${new Date(record.createdAt).toLocaleString('zh-CN',{hour12:false})}`.toLocaleLowerCase('zh-CN').includes(query));$('#recordsCount').textContent=query?`${records.length} / ${recordCache.length} · 上限50`:`${recordCache.length} / 50 条`;$('#clearRecords').disabled=!recordCache.length;$('#undoDelete').disabled=!lastDeletedRecord;list.replaceChildren();if(!records.length){list.append(element('p','empty-inline',recordCache.length?'没有找到匹配的案例。':'完成一次求解后，案例会自动保存在这里。'));return;}records.forEach(record=>{const row=element('div','record-item-row'),button=element('button','record-item'),remove=element('button','record-delete','×');button.type=remove.type='button';button.dataset.recordId=record.id;button.classList.toggle('active',String(record.id)===String(selectedRecord?.id));button.append(element('strong','',record.title||'未命名案例'),element('span','',`${new Date(record.createdAt).toLocaleString('zh-CN',{hour12:false})} · ${record.operationCount||0} 步`),element('small','',record.totalTimeSeconds==null?'暂无完整方案':duration(Number(record.totalTimeSeconds))));button.addEventListener('click',()=>openRecord(record.id,button));remove.setAttribute('aria-label',`删除案例${record.title||'未命名案例'}`);remove.title='删除案例';remove.addEventListener('click',()=>deleteRecordDirect(record.id));row.append(button,remove);list.append(row);});}
async function loadRecords(){const list=$('#recordsList');if(!list)return;list.replaceChildren(element('p','empty-inline','正在读取案例…'));try{recordCache=await fetchRecordList();renderRecordList();}catch(error){recordCache=[];list.replaceChildren();$('#clearRecords').disabled=true;showRecordsMessage(error.message,'error');}}
function appendInfoRow(body,label,value){const row=element('tr');row.append(element('th','',label),element('td','',value??'—'));body.append(row);}
function renderRecordParameters(answer){const c=answer.parameters||{},body=$('#recordParameters'),trackText=(key)=>(c.tracks||[]).map((track,index)=>`${track.name||roman(index+1)}道：${(track[key]||[]).join(' → ')||'空'}`).join('；');body.replaceChildren();[
  ['求解状态',labelStatus(answer)||answer.status],['求解引擎',answer.solverEngine==='gurobi'?'Gurobi SAN整数规划':'浏览器内置 SAN + A*'],['终态模式',answer.goalMode==='custom'?'自定义精确终态':'论文去向聚集模式'],['优化目标',answer.objective==='rounds'?'最少宏动作轮数':'最短总调车时间'],['全过程用时',answer.totalTimeSeconds==null?'—':`${duration(answer.totalTimeSeconds)}（${answer.totalTimeSeconds.toFixed(2)}秒）`],['电脑求解耗时',answer.statistics?.elapsedSeconds==null?'—':secs(answer.statistics.elapsedSeconds)],['搜索时限',c.timeLimit==null?'—':`${c.timeLimit} 秒`],['A* 权重',answer.weight??c.weight],['SAN 解池规模',answer.poolSize??c.poolSize??'不截断'],['牵出线 / 机车长度',`${c.headshunt??'—'} 米 / ${c.locomotive??'—'} 米`],['初始机车对应股道',c.initialTrack?`${roman(Number(c.initialTrack))}道（第 ${c.initialTrack} 股道）`:'—'],['去向顺序',(answer.destinationOrder||c.destinationOrder||[]).join(' → ')||'—'],['车辆参数',(c.cars||[]).map(car=>`${car.id}（去向${car.destination}，${car.length}米）`).join('；')||'—'],['股道容量',(c.tracks||[]).map((track,index)=>`${track.name||roman(index+1)}道 ${track.capacity}米`).join('；')||'—'],['初始状态',trackText('initial')||'—'],['指定终态',answer.goalMode==='custom'?(trackText('goal')||'—'):'由去向顺序自动判定'],['终止原因',answer.termination||'—']
].forEach(([label,value])=>appendInfoRow(body,label,value));}
function renderRecordStateViews(answer){const c=answer.parameters||{},meta=c.tracks||[],destinations=answer.destinations||Object.fromEntries((c.cars||[]).map(car=>[car.id,car.destination])),lengths=Object.fromEntries((c.cars||[]).map(car=>[car.id,Number(car.length)||0])),options={lengths,headshunt:c.headshunt,locomotive:c.locomotive},initial=answer.initial||{tracks:meta.map(track=>track.initial||[]),load:[],position:c.initialTrack||1},terminal=answer.operations?.length?answer.operations[answer.operations.length-1].state:{tracks:meta.map(track=>track.goal||track.initial||[]),load:[],position:c.initialTrack||1};renderYardInto($('#recordInitialYard'),initial,meta,destinations,options);renderYardInto($('#recordGoalYard'),terminal,meta,destinations,options);}
async function openRecord(id,button){try{const record=await fetchRecord(id);if(!record)throw Error('案例不存在或已被删除');selectedRecord=record;document.querySelectorAll('.record-item').forEach(item=>item.classList.toggle('active',item===button));$('#recordEmpty').classList.add('hidden');$('#recordDetail').classList.remove('hidden');const nameInput=$('#recordNameInput');nameInput.value=record.title||'未命名案例';nameInput.readOnly=true;$('#renameRecord').textContent='重命名';$('#recordDetailTime').textContent=new Date(record.createdAt).toLocaleString('zh-CN',{hour12:false});const answer=record.result;$('#recordSummary').replaceChildren(...[['求解状态',labelStatus(answer)||answer.status],['全过程用时',answer.totalTimeSeconds==null?'—':duration(answer.totalTimeSeconds)],['宏动作 / 基本作业',`${answer.roundCount??'—'} 轮 / ${answer.operationCount??answer.operations?.length??0} 步`]].map(([label,value])=>{const card=element('div');card.append(element('span','',label),element('strong','',value));return card;}));renderRecordParameters(answer);renderRecordStateViews(answer);const body=$('#recordOperations');body.replaceChildren();(answer.operations||[]).forEach(op=>{const row=element('tr');[`${op.step} / ${op.round}`,op.kind==='PULL'?'牵出':'推送',`${op.track} · ${op.trackName}`,op.cars.join('、'),secs(op.durationSeconds),secs(op.cumulativeSeconds)].forEach(value=>row.append(element('td','',value)));body.append(row);});}catch(error){showRecordsMessage(error.message);}}
function exportSelectedRecord(){if(!selectedRecord)return;const blob=new Blob([JSON.stringify(selectedRecord,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=element('a');link.href=url;link.download=`shunting-case-${selectedRecord.id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function resetRecordDetail(){selectedRecord=null;$('#recordDetail').classList.add('hidden');$('#recordEmpty').classList.remove('hidden');}
async function toggleRecordRename(){if(!selectedRecord)return;const input=$('#recordNameInput'),button=$('#renameRecord');if(input.readOnly){renameOriginal=input.value;input.readOnly=false;button.textContent='保存名称';input.focus();input.select();return;}const title=input.value.trim();if(!title){showRecordsMessage('案例名称不能为空。','error');input.focus();return;}button.disabled=true;try{if(await isDuplicateCaseTitle(title,selectedRecord.id))throw Error('案例名称已存在，请使用其他名称。');await updateRecordTitle(selectedRecord.id,title);selectedRecord.title=title;input.value=title;input.readOnly=true;button.textContent='重命名';await loadRecords();await populateHistoryCases();showRecordsMessage('案例名称已更新。','success');}catch(error){showRecordsMessage(error.message,'error');}finally{button.disabled=false;}}
function cancelRecordRename(){const input=$('#recordNameInput');if(input.readOnly)return;input.value=renameOriginal;input.readOnly=true;$('#renameRecord').textContent='重命名';}
async function deleteRecordDirect(id){try{const record=await fetchRecord(id);if(!record)throw Error('案例不存在或已被删除');await deleteStoredRecord(id);lastDeletedRecord=record;if(String(selectedRecord?.id)===String(id))resetRecordDetail();await loadRecords();await populateHistoryCases();showRecordsMessage(`已删除“${record.title||'未命名案例'}”，可点击右侧“撤销删除”恢复。`,'success');}catch(error){showRecordsMessage(error.message,'error');}}
async function undoLastDelete(){if(!lastDeletedRecord)return;const button=$('#undoDelete'),record=lastDeletedRecord;button.disabled=true;try{await restoreSolvedCase(record);lastDeletedRecord=null;await loadRecords();await populateHistoryCases();showRecordsMessage(`已恢复“${record.title||'未命名案例'}”。`,'success');}catch(error){showRecordsMessage(error.message,'error');button.disabled=false;}}
function askRecordsAction(){const count=recordCache.length;if(!count)return;pendingRecordsAction={type:'clear'};$('#confirmRecordsTitle').textContent='确认清空全部案例？';$('#confirmRecordsText').textContent=`将永久删除当前保存的 ${count} 个案例，此操作无法撤销。`;$('#confirmRecordsAction').textContent='确认全部清空';const dialog=$('#recordsConfirmDialog');if(typeof dialog.showModal==='function')dialog.showModal();else if(window.confirm($('#confirmRecordsText').textContent))executeRecordsAction();}
async function executeRecordsAction(){const dialog=$('#recordsConfirmDialog');if(!pendingRecordsAction)return;$('#confirmRecordsAction').disabled=true;try{await clearStoredRecords();lastDeletedRecord=null;resetRecordDetail();await loadRecords();await populateHistoryCases();dialog.open&&dialog.close();showRecordsMessage('全部案例已清空。','success');}catch(error){showRecordsMessage(error.message,'error');dialog.open&&dialog.close();}finally{$('#confirmRecordsAction').disabled=false;pendingRecordsAction=null;}}
let yardDrag=null;
function yardCar(id,destinations,lengths,pxPerMetre,editMode=null){
  const destination=destinations[id]||'?',colors=destinationColors(destination),e=element('span',`car${editMode?' draggable-car':''}`,id);e.dataset.dest=destination;e.dataset.carId=id;e.title=`车辆${id} · 去向${destination} · ${lengths[id]||0}米`;e.style.setProperty('--car-bg',colors.background);e.style.setProperty('--car-border',colors.border);e.style.setProperty('--car-text',colors.text);
  e.style.width=`${Math.max(5,(lengths[id]||0)*pxPerMetre)}px`;if(editMode){e.dataset.editMode=editMode;e.addEventListener('pointerdown',startYardDrag);if(editMode==='initial'){e.tabIndex=0;e.setAttribute('role','button');e.setAttribute('aria-label',`拖动车辆${id}改变位置，双击编辑参数`);e.addEventListener('dblclick',event=>{event.preventDefault();event.stopPropagation();openVehicleInspector(id);});e.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();openVehicleInspector(id);}});}else{e.setAttribute('aria-label',`拖动车辆${id}改变目标位置`);}}return e;
}
function renderYardInto(container,state,meta,destinations,options={}){
  container.replaceChildren();const n=state.tracks.length,capacities=meta.map(t=>Number(t.capacity)||0),lengths=options.lengths||Object.fromEntries((result?.parameters?.cars||[]).map(c=>[c.id,c.length]));
  const headshunt=Number(options.headshunt??result?.parameters?.headshunt??100),locoLength=Number(options.locomotive??result?.parameters?.locomotive??20),left=28,geometry=YardModel.geometry(capacities,headshunt,left),{pxPerMetre,commonEnd}=geometry;
  const height=Math.max(245,n*62+82),width=Math.max(680,commonEnd+78);
  const diagram=element('div',`yard-diagram${options.editMode?' editable':''}`);diagram.style.height=`${height}px`;diagram.style.width=`${width}px`;diagram.dataset.scale=pxPerMetre;if(options.editMode)diagram.dataset.editMode=options.editMode;
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('aria-hidden','true');
  const path=(d,cls='yard-rail')=>{const p=document.createElementNS(ns,'path');p.setAttribute('d',d);p.setAttribute('class',cls);svg.append(p);};
  state.tracks.forEach((_,i)=>{const y=34+i*62,start=geometry.starts[i];path(`M ${start} ${y} L ${commonEnd} ${y}`);if(i+1<n)path(`M ${start} ${y} L ${geometry.starts[i+1]} ${34+(i+1)*62}`,'yard-rail ladder-link');path(`M ${commonEnd} ${y-12} L ${commonEnd} ${y+12}`,'yard-rail track-stop');});const longestIndex=capacities.indexOf(Math.max(...capacities)),headY=34+longestIndex*62;path(`M ${left} ${headY} L ${geometry.starts[longestIndex]} ${headY}`,'yard-rail headshunt-line');diagram.append(svg);
  const hsLabel=element('span','headshunt-label',`牵出线 ${headshunt}m`);hsLabel.style.left=`${left}px`;hsLabel.style.top=`${headY+10}px`;diagram.append(hsLabel);
  const consist=element('div','headshunt-consist');consist.style.left=`${left}px`;consist.style.top=`${headY-34}px`;const loco=element('span','loco','调机');loco.style.width=`${Math.max(28,locoLength*pxPerMetre)}px`;consist.append(loco);state.load.forEach(id=>consist.append(yardCar(id,destinations,lengths,pxPerMetre)));diagram.append(consist);
  state.tracks.forEach((ids,i)=>{const y=34+i*62,start=geometry.starts[i],zone=element('div','track-drop-zone');zone.dataset.trackIndex=i;zone.style.left=`${start}px`;zone.style.top=`${y-24}px`;zone.style.width=`${capacities[i]*pxPerMetre}px`;zone.style.height='48px';if(options.editMode==='initial'){zone.title=`双击编辑${roman(i+1)}道参数`;zone.addEventListener('dblclick',event=>{if(event.target.closest('.car,.track-delete'))return;event.preventDefault();event.stopPropagation();openTrackInspector(i);});}
    const label=element('span','track-name',roman(i+1));label.style.left=`${start-42}px`;label.style.top=`${y-25}px`;diagram.append(label);
    const row=element('div','track-consist');if(YardModel.occupied(ids,lengths)>capacities[i]+1e-8)row.classList.add('over-capacity');ids.forEach(id=>row.append(yardCar(id,destinations,lengths,pxPerMetre,options.editMode)));zone.append(row);
    if(options.allowTrackDelete){const remove=element('button','track-delete','×');remove.type='button';remove.title=`删除${roman(i+1)}道`;remove.setAttribute('aria-label',remove.title);remove.addEventListener('pointerdown',e=>e.stopPropagation());remove.addEventListener('click',e=>{e.stopPropagation();deleteTrack(i);});zone.append(remove);}diagram.append(zone);
  });
  const stage=element('div','yard-stage'),available=Math.max(280,(container.clientWidth||width)-20),displayScale=Math.min(1,available/width)*(options.editMode?yardZoom:1);stage.style.width=`${width*displayScale}px`;stage.style.height=`${height*displayScale}px`;diagram.style.transform=`scale(${displayScale})`;diagram.style.transformOrigin='left top';stage.append(diagram);container.append(stage);
  if(options.scaleId&&$('#'+options.scaleId))$('#'+options.scaleId).textContent=`显示比例 ${(displayScale*100).toFixed(0)}% · 1m = ${pxPerMetre.toFixed(2)}px`;
}
function renderInitialPreview(){
  if(!$('#initialPreview'))return;const shared={lengths:Object.fromEntries(cars.map(c=>[c.id,Number(c.length)||0])),headshunt:Number($('#headshunt')?.value)||0,locomotive:Number($('#locomotive')?.value)||0},destinations=Object.fromEntries(cars.map(c=>[c.id,c.destination])),position=Number($('#initialTrack')?.value)||1;
  renderDestinationLegend();
  renderYardInto($('#initialPreview'),{tracks:tracks.map(t=>splitIds(t.initialText)),load:[],position},tracks,destinations,{...shared,editMode:'initial',allowTrackDelete:true,scaleId:'yardScale'});
  if(document.querySelector('input[name="goalMode"]:checked')?.value==='custom')renderYardInto($('#goalPreview'),{tracks:tracks.map(t=>splitIds(t.goalText)),load:[],position},tracks,destinations,{...shared,editMode:'goal',allowTrackDelete:false,scaleId:'goalYardScale'});
  if($('#yardInspector')?.classList.contains('open'))requestAnimationFrame(positionYardInspector);
}
function renderYard(state){renderYardInto($('#yardView'),state,result.parameters.tracks,result.destinations);}
function startYardDrag(event){
  if(busy||event.button>0)return;const source=event.currentTarget,rect=source.getBoundingClientRect(),ghost=source.cloneNode(true);ghost.className='car drag-ghost';ghost.style.width=`${rect.width}px`;ghost.style.left=`${event.clientX-rect.width/2}px`;ghost.style.top=`${event.clientY-rect.height/2}px`;ghost.hidden=true;document.body.append(ghost);
  yardDrag={id:source.dataset.carId,mode:source.dataset.editMode,source,ghost,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,moved:false};source.setPointerCapture(event.pointerId);source.addEventListener('pointermove',moveYardDrag);source.addEventListener('pointerup',endYardDrag,{once:true});source.addEventListener('pointercancel',cancelYardDrag,{once:true});
}
function moveYardDrag(event){if(!yardDrag)return;if(!yardDrag.moved){if(Math.hypot(event.clientX-yardDrag.startX,event.clientY-yardDrag.startY)<6)return;yardDrag.moved=true;yardDrag.ghost.hidden=false;yardDrag.source.classList.add('dragging-source');document.body.classList.add('yard-dragging',`dragging-${yardDrag.mode}`);$(yardDrag.mode==='initial'?'#dragHint':'#goalDragHint').textContent=`正在移动车辆 ${yardDrag.id}`;}yardDrag.ghost.style.left=`${event.clientX-yardDrag.ghost.offsetWidth/2}px`;yardDrag.ghost.style.top=`${event.clientY-yardDrag.ghost.offsetHeight/2}px`;document.querySelectorAll('.track-drop-zone').forEach(z=>z.classList.remove('drop-target'));$('#vehicleTrash').classList.remove('drop-target');const at=document.elementFromPoint(event.clientX,event.clientY),zone=at?.closest?.('.track-drop-zone');if(zone?.closest('.yard-card')===yardDrag.source.closest('.yard-card'))zone.classList.add('drop-target');if(yardDrag.mode==='initial')at?.closest?.('.vehicle-trash')?.classList.add('drop-target');}
function dropIndex(zone,x,id){const items=[...zone.querySelectorAll('.draggable-car')].filter(e=>e.dataset.carId!==id);for(let i=0;i<items.length;i++){const r=items[i].getBoundingClientRect();if(x<r.left+r.width/2)return i;}return items.length;}
function finishYardDrag(){if(!yardDrag)return;yardDrag.source.removeEventListener('pointermove',moveYardDrag);yardDrag.ghost.remove();yardDrag.source.classList.remove('dragging-source');document.body.classList.remove('yard-dragging','dragging-initial','dragging-goal');document.querySelectorAll('.track-drop-zone').forEach(z=>z.classList.remove('drop-target'));$('#vehicleTrash').classList.remove('drop-target');yardDrag=null;}
function endYardDrag(event){
  if(!yardDrag)return;if(!yardDrag.moved){finishYardDrag();return;}const id=yardDrag.id,mode=yardDrag.mode,hint=$(mode==='initial'?'#dragHint':'#goalDragHint'),at=document.elementFromPoint(event.clientX,event.clientY),trash=mode==='initial'?at?.closest?.('.vehicle-trash'):null,zone=at?.closest?.('.track-drop-zone'),sameDiagram=zone?.closest('.yard-card')===yardDrag.source.closest('.yard-card');
  if(trash){finishYardDrag();deleteVehicle(id);return;}
  if(zone&&sameDiagram){try{const field=mode==='initial'?'initialText':'goalText',rows=tracks.map(t=>splitIds(t[field])),lengths=Object.fromEntries(cars.map(c=>[c.id,Number(c.length)||0])),capacities=tracks.map(t=>Number(t.capacity)||0),next=YardModel.move(rows,id,Number(zone.dataset.trackIndex),dropIndex(zone,event.clientX,id),lengths,capacities);tracks.forEach((t,i)=>t[field]=next[i].join(','));renderEditors();invalidate();clearError();hint.textContent=`车辆 ${id} 已重新连挂`;renderInitialPreview();}catch(e){error(e.message);hint.textContent=e.message;}}
  else hint.textContent='未放入对应状态图的股道，位置保持不变';finishYardDrag();
}
function cancelYardDrag(){if(yardDrag)$(yardDrag.mode==='initial'?'#dragHint':'#goalDragHint').textContent='拖动已取消';finishYardDrag();}
function displayStep(value){
  if(!result)return;currentStep=Math.max(0,Math.min(value,result.operations.length));const op=result.operations[currentStep-1];
  $('#stepCounter').textContent=`${currentStep} / ${result.operations.length}`;$('#stepKicker').textContent=op?`第${op.step}步 · 第${op.round}轮`:'初始状态';
  $('#stepTitle').textContent=op?`${op.kind==='PULL'?'牵出 / 连挂':'推送 / 摘挂'} · ${op.trackName}道`:'作业开始';
  $('#actionDetail').textContent=op?`车辆 ${op.cars.join('、')}；机后 ${op.before} → ${op.after} 辆。本步 ${secs(op.durationSeconds)}，累计 ${secs(op.cumulativeSeconds)}。`:'左侧牵出线经咽喉连接各股道，右侧为股道尽端；股道编号和t变量从1开始。';
  $('#prevStep').disabled=currentStep===0;$('#nextStep').disabled=currentStep===result.operations.length;
  renderYard(op?op.state:result.initial);$('#sanDetail').classList.toggle('hidden',!op);
  if(op)renderModel(result.steps[op.round-1]);
  [...$('#timeline').children].forEach((li,i)=>{li.classList.toggle('active',i===currentStep);li.querySelector('button').setAttribute('aria-current',i===currentStep?'step':'false');});
}
function renderModel(round){
  const grid=element('div','san-model-grid'), summary=element('div'), arcs=element('div');
  summary.append(element('strong','',`第${round.step}轮 · t_${round.sourceTrack} = 1（${round.sourceTrackName}道）`));
  const g=result.objective==='time'?round.cumulativeSeconds:round.step;
  [`R = Σ rᵢⱼxᵢⱼ = ${round.reward.toFixed(4)}`,`T = ${secs(round.cumulativeSeconds)}；Λ = ${round.lambda}`,`w = ${result.weight}；wΛ = ${(result.weight*round.lambda).toFixed(2)}`,`η = ${g.toFixed(2)} + ${(result.weight*round.lambda).toFixed(2)} = ${round.priority.toFixed(2)}`,`选中弧 ${round.model.selectedArcs.length} / 候选弧 ${round.model.candidateArcs.length}`,Object.entries(round.model.t).map(([k,v])=>`${k}=${v}`).join('，')].forEach(t=>summary.append(element('p','',t)));
  arcs.append(element('strong','','选中弧与对应奖励'));
  round.model.selectedArcs.forEach(a=>arcs.append(element('span','arc-chip',`${a.name}: ${a.from} → ${a.to} · ${a.type} · r=${Number(a.reward.toFixed(4))}`)));
  grid.append(summary,arcs);$('#sanModel').replaceChildren(grid);
}
function download(){if(!result)return;const blob=new Blob([JSON.stringify(result,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=element('a');a.href=url;a.download='shunting-solution-v4.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function updateGoalMode(){const custom=document.querySelector('input[name="goalMode"]:checked').value==='custom';$('#customGoalSettings').classList.toggle('hidden',!custom);$('#goalYardCard').classList.toggle('hidden',!custom);$('#paperGoalSettings').classList.toggle('hidden',custom);$('#yardPair').classList.toggle('paper-goal',!custom);renderInitialPreview();}
function updateEngine(){const gurobi=$('#solverEngine').value==='gurobi';$('#gurobiEndpointWrap').classList.toggle('hidden',!gurobi);$('#engineHelp').textContent=gurobi?'Gurobi模式将完整配置发送到你部署的后端；GitHub Pages本身不能运行Gurobi。':'内置模式可直接在GitHub Pages运行，无需服务器。';invalidate();}
$('#loadExample').addEventListener('click',()=>{closeYardInspector();applyConfig(defaults);});
$('#addDestination').addEventListener('click',addDestination);$('#newDestination').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();addDestination();}});
$('#addCar').addEventListener('click',()=>addVehicle({id:nextCarId(),destination:destinationOptions[0],length:15}));
function addTrack(capacity=120,report=error){const value=Number(capacity);if(!Number.isFinite(value)||value<=0){report('股道容量必须大于0。');return false;}tracks.push({name:roman(tracks.length+1),capacity:value,initialText:'',goalText:''});renderEditors();invalidate();clearError();renderInitialPreview();return true;}
function setInspectorError(selector,message=''){const node=$(selector);node.textContent=message;node.classList.toggle('hidden',!message);}
function positionYardInspector(){const panel=$('#yardInspector'),host=$('.preview-panel'),view=$('#initialPreview');if(!panel||!host||!view)return;const hostRect=host.getBoundingClientRect(),viewRect=view.getBoundingClientRect();panel.style.top=`${viewRect.top-hostRect.top}px`;panel.style.height=`${viewRect.height}px`;}
function showYardInspector(form,title,kicker){$('#vehicleInspectorForm').classList.toggle('hidden',form!=='vehicle');$('#trackInspectorForm').classList.toggle('hidden',form!=='track');$('#inspectorTitle').textContent=title;$('#inspectorKicker').textContent=kicker;const panel=$('#yardInspector');panel.inert=false;panel.classList.add('open');panel.setAttribute('aria-hidden','false');requestAnimationFrame(positionYardInspector);}
function closeYardInspector(){const panel=$('#yardInspector');if(!panel)return;panel.classList.remove('open');panel.setAttribute('aria-hidden','true');panel.inert=true;yardInspectorContext=null;}
function openVehicleInspector(id=null,source='edit'){populateQuickDestinationSelect();const car=id?cars.find(item=>item.id===id):null;if(id&&!car)return error(`未找到车辆“${id}”。`);yardInspectorContext={kind:'vehicle',mode:car?'edit':'add',id:car?.id||null};$('#inspectorVehicleId').value=car?.id||nextCarId();$('#inspectorVehicleDestination').value=car?.destination||destinationOptions[0]||'';$('#inspectorVehicleLength').value=car?.length||15;setInspectorError('#vehicleInspectorError');const isNew=source==='new';showYardInspector('vehicle',car?`编辑车辆 ${car.id}`:'添加车辆',isNew?'NEW VEHICLE':car?'DOUBLE CLICK EDIT':'QUICK ADD');setTimeout(()=>$('#inspectorVehicleId').focus(),180);}
function openTrackInspector(index=null,source='edit'){const track=Number.isInteger(index)?tracks[index]:null;if(Number.isInteger(index)&&!track)return error('未找到需要编辑的股道。');yardInspectorContext={kind:'track',mode:track?'edit':'add',index:track?index:null};$('#inspectorTrackName').value=track?.name||roman(tracks.length+1);$('#inspectorTrackCapacity').value=track?.capacity||120;setInspectorError('#trackInspectorError');const isNew=source==='new';showYardInspector('track',track?`编辑 ${track.name} 道`:'添加股道',isNew?'NEW TRACK':track?'DOUBLE CLICK EDIT':'QUICK ADD');setTimeout(()=>$('#inspectorTrackCapacity').focus(),180);}
function quickCreateVehicle(){const id=nextCarId();if(addVehicle({id,destination:destinationOptions[0],length:15}))openVehicleInspector(id,'new');}
function quickCreateTrack(){const index=tracks.length;if(addTrack(120))openTrackInspector(index,'new');}
$('#addTrack').addEventListener('click',()=>addTrack(120));$('#quickAddTrack').addEventListener('click',quickCreateTrack);$('#quickAddVehicle').addEventListener('click',quickCreateVehicle);
function applyVehicleInspector(){if(yardInspectorContext?.kind!=='vehicle')return;setInspectorError('#vehicleInspectorError');const value={id:$('#inspectorVehicleId').value,destination:$('#inspectorVehicleDestination').value,length:$('#inspectorVehicleLength').value},report=message=>setInspectorError('#vehicleInspectorError',message),ok=yardInspectorContext.mode==='edit'?updateVehicle(yardInspectorContext.id,value,report):addVehicle(value,report);if(ok){yardInspectorContext.mode='edit';yardInspectorContext.id=String(value.id).trim();$('#inspectorTitle').textContent=`编辑车辆 ${yardInspectorContext.id}`;}}
function applyTrackInspector(){if(yardInspectorContext?.kind!=='track')return;setInspectorError('#trackInspectorError');const report=message=>setInspectorError('#trackInspectorError',message),ok=yardInspectorContext.mode==='edit'?updateTrack(yardInspectorContext.index,$('#inspectorTrackCapacity').value,report):addTrack($('#inspectorTrackCapacity').value,report);if(ok&&yardInspectorContext.mode!=='edit'){yardInspectorContext.mode='edit';yardInspectorContext.index=tracks.length-1;}}
$('#vehicleInspectorForm').addEventListener('submit',event=>event.preventDefault());$('#trackInspectorForm').addEventListener('submit',event=>event.preventDefault());
function scheduleInspectorApply(callback){clearTimeout(inspectorLiveTimer);inspectorLiveTimer=setTimeout(callback,260);}
['inspectorVehicleId','inspectorVehicleLength'].forEach(id=>{const input=$('#'+id);input.addEventListener('input',()=>scheduleInspectorApply(applyVehicleInspector));input.addEventListener('change',()=>{clearTimeout(inspectorLiveTimer);applyVehicleInspector();});});
$('#inspectorVehicleDestination').addEventListener('change',applyVehicleInspector);
$('#inspectorTrackCapacity').addEventListener('input',()=>scheduleInspectorApply(applyTrackInspector));$('#inspectorTrackCapacity').addEventListener('change',()=>{clearTimeout(inspectorLiveTimer);applyTrackInspector();});
$('#collapseYardInspector').addEventListener('click',closeYardInspector);
document.addEventListener('pointerdown',event=>{const panel=$('#yardInspector');if(panel?.classList.contains('open')&&!panel.contains(event.target))closeYardInspector();});
$('#yardInspector').inert=true;
$('#yardZoom').addEventListener('input',event=>{yardZoom=Number(event.target.value)/100;$('#yardZoomValue').value=`${event.target.value}%`;renderInitialPreview();});
fields.forEach(id=>$('#'+id).addEventListener('input',()=>{invalidate();updateFormula();renderInitialPreview();}));
Object.keys(rewardFields).forEach(id=>$('#'+id).addEventListener('input',invalidate));
document.querySelectorAll('input[name="goalMode"]').forEach(e=>e.addEventListener('change',()=>{updateGoalMode();invalidate();}));
let yardResizeTimer;window.addEventListener('resize',()=>{clearTimeout(yardResizeTimer);yardResizeTimer=setTimeout(renderInitialPreview,120);});
$('#solverEngine').addEventListener('change',updateEngine);$('#gurobiEndpoint').addEventListener('input',invalidate);
$('#resetPaperParameters').addEventListener('click',()=>{for(const id of ['shuntingSpeed','ladderSpeed','trackSpacing','timeConstant','timePerCar','weight'])$('#'+id).value=defaults[id];Object.entries(rewardFields).forEach(([id,key])=>$('#'+id).value=defaults.rewards[key]);updateFormula();invalidate();});
document.querySelectorAll('.nav-tab').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
document.querySelectorAll('.next-view').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.target)));
document.querySelectorAll('[data-cover-target]').forEach(button=>button.addEventListener('click',()=>{document.body.classList.remove('cover-active');$('#coverPage').hidden=true;switchView(button.dataset.coverTarget||'parameters');requestAnimationFrame(renderInitialPreview);}));
$('#returnCover').addEventListener('click',()=>{closeYardInspector();$('#coverPage').hidden=false;document.body.classList.add('cover-active');window.scrollTo({top:0,behavior:'smooth'});});
$('#solveButton').addEventListener('click',runSolver);$('#downloadResult').addEventListener('click',download);
$('#prevStep').addEventListener('click',()=>displayStep(currentStep-1));$('#nextStep').addEventListener('click',()=>displayStep(currentStep+1));
$('#refreshRecords').addEventListener('click',loadRecords);$('#exportRecord').addEventListener('click',exportSelectedRecord);
$('#recordSearch').addEventListener('input',renderRecordList);$('#clearRecords').addEventListener('click',askRecordsAction);$('#undoDelete').addEventListener('click',undoLastDelete);$('#renameRecord').addEventListener('click',toggleRecordRename);$('#recordNameInput').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.currentTarget.readOnly){event.preventDefault();toggleRecordRename();}else if(event.key==='Escape'){cancelRecordRename();}});$('#cancelRecordsAction').addEventListener('click',()=>{$('#recordsConfirmDialog').close();pendingRecordsAction=null;});$('#confirmRecordsAction').addEventListener('click',executeRecordsAction);$('#recordsConfirmDialog').addEventListener('cancel',()=>{pendingRecordsAction=null;});
$('#caseName').addEventListener('input',event=>event.currentTarget.setCustomValidity(''));$('#caseName').addEventListener('blur',async event=>{const title=event.currentTarget.value.trim();if(!title)return;try{const duplicate=await isDuplicateCaseTitle(title);event.currentTarget.setCustomValidity(duplicate?'案例名称已存在，请使用其他名称。':'');if(duplicate)showToast('案例名称已存在，请使用其他名称。','error');}catch(_){}});
$('#historyCaseSelect').addEventListener('change',event=>{$('#loadHistoryCase').disabled=!event.target.value;});$('#loadHistoryCase').addEventListener('click',loadHistoricalCase);
applyConfig(defaults);
if(document.modelContext?.registerTool){
  const controller=new AbortController();window.addEventListener('pagehide',()=>controller.abort(),{once:true});
  const schema={type:'object',additionalProperties:false,properties:{
    cars:{type:'array',items:{type:'object',properties:{id:{type:'string'},destination:{type:'string'},length:{type:'number'}},required:['id','destination','length']}},
    tracks:{type:'array',items:{type:'object',properties:{name:{type:'string'},capacity:{type:'number'},initial:{type:'array',items:{type:'string'}},goal:{type:'array',items:{type:'string'}}},required:['name','capacity','initial','goal']}},
    headshunt:{type:'number'},locomotive:{type:'number'},timeLimit:{type:'number'},weight:{type:'number'},poolSize:{type:'integer'},initialTrack:{type:'integer'},objective:{enum:['time','rounds'],type:'string'}},required:['cars','tracks','headshunt','locomotive']};
  for(const tool of [
    {name:'configure_shunting_problem',description:'校验后替换页面调车配置。w显式可调；初始股道编号从1开始。',inputSchema:schema,annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if(busy)throw Error('求解中不能修改配置');applyConfig(input);return {configured:true,weight:Number($('#weight').value)};}},
    {name:'solve_shunting_problem',description:'求解当前配置并显示全程调车时间、SAN模型与逐步过程。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},async execute(){const r=await runSolver();if(!r)throw Error($('#validation').textContent);return {status:r.status,totalTimeSeconds:r.totalTimeSeconds,weight:r.weight,roundCount:r.roundCount,operationCount:r.operationCount};}}
  ])try{Promise.resolve(document.modelContext.registerTool(tool,{signal:controller.signal})).catch(()=>{});}catch(_){}
}
