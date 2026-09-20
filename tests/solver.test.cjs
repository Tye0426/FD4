const assert = require('node:assert/strict');
const S = require(require('node:fs').existsSync(require('node:path').join(__dirname,'../dist/solver.js')) ? '../dist/solver.js' : '../solver.js');
const base = {
  cars: ['A','B','C','D'].map((id,i)=>({id,destination:['1','2','3','1'][i],length:15})),
  tracks: [{name:'I',capacity:120,initial:['D','C'],goal:['A','D','B','C']},{name:'II',capacity:120,initial:['B','A'],goal:[]},{name:'III',capacity:120,initial:[],goal:[]}],
  headshunt:100,locomotive:20,timeLimit:10,objective:'time',weight:350,poolSize:0,initialTrack:1
};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7, `${a} != ${b}`);
function replay(r) {
  const rows=structuredClone(r.initial.tracks); let load=[], seconds=0, position=r.initial.position;
  for(const op of r.operations) {
    assert.ok(op.track>=1 && op.track<=rows.length); assert.equal(op.before,load.length);
    if(op.kind==='PULL') { assert.equal(load.length,0); assert.deepEqual(rows[op.track-1].splice(0,op.cars.length),op.cars); load=[...op.cars]; }
    else { assert.deepEqual(load.splice(load.length-op.cars.length),op.cars); rows[op.track-1].unshift(...op.cars); }
    assert.equal(op.after,load.length);
    const expected=S.timing(r.parameters,op.kind,position,op.track,op.before,op.after);
    for(const f of Object.keys(expected))near(op[f],expected[f]);
    position=op.track;seconds+=op.durationSeconds;near(seconds,op.cumulativeSeconds);
    assert.deepEqual(op.state,{tracks:rows,load,position});
    assert.ok(load.length*15+base.locomotive<=base.headshunt);
    rows.forEach((row,k)=>assert.ok(row.length*15<=base.tracks[k].capacity));
  }
  assert.deepEqual(rows,r.parameters.tracks.map(t=>t.goal));assert.equal(load.length,0);near(seconds,r.totalTimeSeconds);
  near(Object.values(r.timeBreakdown).reduce((a,b)=>a+b,0),seconds);
  for(const step of r.steps) {
    assert.equal(Object.values(step.model.t).reduce((a,b)=>a+b,0),1); assert.ok(!('t_0' in step.model.t));
    near(step.reward,step.model.selectedArcs.reduce((a,b)=>a+b.reward,0));
    near(step.priority,step.cumulativeCost+r.weight*step.lambda);
    for(const c of step.model.linearConstraints) {const v=c.variables.reduce((a,x)=>a+step.model.x[x],0);assert.ok(c.sense==='='?v===c.rhs:c.sense==='<='?v<=c.rhs:v>=c.rhs);}
  }
}
for(const weight of [0,350,1000]) {const r=S.solve({...base,weight});assert.equal(r.status,'optimal');near(r.totalTimeSeconds,697.52);replay(r);}
const rounds=S.solve({...base,objective:'rounds'});assert.equal(rounds.totalCost,3);assert.ok(rounds.totalTimeSeconds>0);replay(rounds);
const done=S.solve({...base,tracks:base.tracks.map(t=>({...t,initial:t.goal}))});assert.equal(done.totalTimeSeconds,0);assert.equal(done.status,'optimal');
const blocked=S.solve({...base,headshunt:21});assert.equal(blocked.status,'infeasible');assert.equal(blocked.totalTimeSeconds,null);
const capped=S.solve({...base,poolSize:1});assert.ok(capped.candidatePoolRestricted);assert.equal(capped.optimalityProven,false);
assert.throws(()=>S.validate({...base,initialTrack:0}));assert.throws(()=>S.validate({...base,weight:-1}));
const c=S.context(S.validate(base));const m=S.modelForSource(c,{tracks:[['A','B','D'],['C'],[]],position:1},0);
assert.ok(m.arcs.some(a=>a.type==='skipping-2'&&a.reward===2));
assert.ok(m.arcs.some(a=>a.type==='virtual-1'&&a.reward===1/240));
assert.ok(m.arcs.some(a=>a.type==='shunting-1'&&a.reward===1));
const held=S.modelForSource(c,{tracks:[['A','D'],['B','C'],[]],position:1},0);assert.ok(held.arcs.some(a=>a.type==='holding-2'&&a.reward===0.1));
const paper=S.validate({...base,goalMode:'paper',destinationOrder:['1','2','3'],tracks:base.tracks.map(t=>({...t,goal:[]}))});
const paperCtx=S.context(paper);assert.equal(S.paperGoal(paperCtx,{tracks:[['D','A','B','C'],[],[]],load:[],position:2}),true);
assert.equal(S.paperGoal(paperCtx,{tracks:[['A','B','D','C'],[],[]],load:[],position:2}),false);
assert.equal(S.paperGoal(paperCtx,{tracks:[[],['A','D','B','C'],[]],load:[],position:2}),true);
assert.throws(()=>S.validate({...paper,destinationOrder:['1','2']}));
const paperSolved=S.solve({...paper,poolSize:100});assert.ok(['optimal','feasible'].includes(paperSolved.status));assert.equal(paperSolved.goalMode,'paper');assert.ok(paperSolved.totalTimeSeconds>0);
const finalPaperState=paperSolved.steps.at(-1).state;assert.equal(S.paperGoal(paperCtx,finalPaperState),true);
const tuned=S.validate({...base,shuntingSpeed:20,ladderSpeed:12,trackSpacing:4,timeConstant:10000,timePerCar:400,rewards:{...base.rewards,shunting2:9}});
assert.notEqual(S.timing(tuned,'PULL',1,2,0,2).durationSeconds,S.timing(base,'PULL',1,2,0,2).durationSeconds);
assert.ok(S.modelForSource(S.context(tuned),{tracks:[['A'],['D'],[]],position:1},0).arcs.some(a=>a.type==='shunting-2'&&a.reward===9));
console.log('PASS: independent operation replay, time sums, binary constraints, weights, limits, rewards, numbering; time fixture = 697.52 s');
