(function(root){
  'use strict';
  function scale(capacities,headshunt){
    const longest=Math.max(1,headshunt||0,...capacities);
    return Math.max(0.65,Math.min(3,720/longest));
  }
  function occupied(row,lengths){return row.reduce((sum,id)=>sum+(lengths[id]||0),0);}
  function geometry(capacities,headshunt,left=28){const pxPerMetre=scale(capacities,headshunt),maxCapacity=Math.max(1,...capacities),ladderRoot=left+headshunt*pxPerMetre,commonEnd=ladderRoot+maxCapacity*pxPerMetre;return {pxPerMetre,ladderRoot,commonEnd,starts:capacities.map(capacity=>commonEnd-capacity*pxPerMetre)};}
  function move(rows,carId,targetTrack,targetIndex,lengths,capacities){
    if(!Number.isInteger(targetTrack)||targetTrack<0||targetTrack>=rows.length)throw Error('没有找到目标股道。');
    const source=rows.findIndex(row=>row.includes(carId));if(source<0)throw Error(`初始状态中未找到车辆${carId}。`);
    const next=rows.map(row=>row.filter(id=>id!==carId));
    if(occupied(next[targetTrack],lengths)+(lengths[carId]||0)>capacities[targetTrack]+1e-8)throw Error(`${targetTrack+1}号股道容量不足，无法放入车辆${carId}。`);
    const at=Math.max(0,Math.min(Number.isInteger(targetIndex)?targetIndex:next[targetTrack].length,next[targetTrack].length));
    next[targetTrack].splice(at,0,carId);return next;
  }
  const api={scale,geometry,occupied,move};root.YardModel=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
