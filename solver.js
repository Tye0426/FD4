/* SAN arc-selection 0-1 model: structural branch-and-bound + weighted A*.
 * Engineering reformulation; see 算法说明.md for deviations from the paper.
 * No external solver/runtime required. Node tests and the browser use this same file.
 */
(function (root) {
  'use strict';
  const clone = x => JSON.parse(JSON.stringify(x));
  const key = s => JSON.stringify([s.tracks, s.position]);
  const now = () => performance.now();
  class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(x) { let i = this.a.length; this.a.push(x); while (i) { const p = (i - 1) >> 1; if (this.a[p][0] <= x[0]) break; this.a[i] = this.a[p]; i = p; } this.a[i] = x; }
    pop() { const top = this.a[0], x = this.a.pop(); if (this.a.length) { let i = 0; while (i * 2 + 1 < this.a.length) { let j = i * 2 + 1; if (j + 1 < this.a.length && this.a[j + 1][0] < this.a[j][0]) j++; if (x[0] <= this.a[j][0]) break; this.a[i] = this.a[j]; i = j; } this.a[i] = x; } return top; }
  }
  function validate(input) {
    const c = clone(input);
    const num = (v, name, min, max = Infinity) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw Error(`${name}须为 ${min}～${max === Infinity ? '有限正数' : max} 范围内的数字`); return v; };
    if (!Array.isArray(c.cars) || !c.cars.length || c.cars.length > 40) throw Error('请配置1～40辆车；浏览器版建议先用小算例。');
    if (!Array.isArray(c.tracks) || c.tracks.length < 2 || c.tracks.length > 12) throw Error('请配置2～12条股道。');
    const ids = new Set(), names = new Set();
    for (const car of c.cars) {
      if (typeof car.id !== 'string' || !car.id.trim() || /[,，\s]/.test(car.id) || ids.has(car.id)) throw Error('车辆ID须非空、唯一且不含空格或逗号。');
      if (typeof car.destination !== 'string' || !car.destination.trim()) throw Error(`车辆${car.id}缺少去向。`);
      ids.add(car.id); num(car.length, '车辆长度', 0.001);
    }
    c.headshunt = num(c.headshunt, '牵出线长度', 0.001);
    c.locomotive = num(c.locomotive, '机车长度', 0, c.headshunt);
    c.timeLimit = num(c.timeLimit ?? 10, '搜索时限（秒）', 0.1, 120);
    c.weight = num(c.weight ?? 350, 'w', 0, 1000000);
    c.shuntingSpeed = num(c.shuntingSpeed ?? 16, '调车速度', 0.1, 200);
    c.ladderSpeed = num(c.ladderSpeed ?? 10, '梯线速度', 0.1, 200);
    c.trackSpacing = num(c.trackSpacing ?? 3, '相邻股道间距', 0, 1000);
    c.timeConstant = num(c.timeConstant ?? 13500, '时间公式常数a', 0, 10000000);
    c.timePerCar = num(c.timePerCar ?? 517.5, '时间公式车辆系数b', 0, 10000000);
    c.rewards = c.rewards ?? {};
    for (const [key, fallback] of Object.entries({shunting1:1,shunting2:2,shunting3:0,skipping1:1,skipping2:2,holding1:0,holding2:0.1,virtual2:0})) c.rewards[key] = num(c.rewards[key] ?? fallback, `奖励${key}`, 0, 1000000);
    c.poolSize = num(c.poolSize ?? 100, 'SAN解池规模', 0, 1000);
    if (!Number.isInteger(c.poolSize)) throw Error('SAN解池规模须为整数（0表示不截断）。');
    c.objective = c.objective ?? 'time';
    if (!['time', 'rounds'].includes(c.objective)) throw Error('优化目标须为time或rounds。');
    c.initialTrack = num(c.initialTrack ?? 1, '初始机车对应股道', 1, c.tracks.length);
    if (!Number.isInteger(c.initialTrack)) throw Error('初始机车股道须为整数。');
    for (const t of c.tracks) {
      if (typeof t.name !== 'string' || !t.name.trim() || names.has(t.name)) throw Error('股道名须非空且唯一。');
      names.add(t.name); num(t.capacity, '股道容量', 0.001);
    }
    c.goalMode = c.goalMode ?? 'custom';
    if (!['paper','custom'].includes(c.goalMode)) throw Error('目标模式须为paper或custom。');
    const presentDestinations = [...new Set(c.cars.map(v => v.destination))];
    c.destinationOrder = Array.isArray(c.destinationOrder) ? c.destinationOrder.map(String) : presentDestinations;
    if (c.goalMode === 'paper') {
      if (c.destinationOrder.length !== presentDestinations.length || new Set(c.destinationOrder).size !== presentDestinations.length || presentDestinations.some(d=>!c.destinationOrder.includes(d))) throw Error('论文模式的去向顺序必须恰好包含全部去向且不能重复。');
      const totalLength = c.cars.reduce((sum, car) => sum + car.length, 0);
      if (!c.tracks.some(t => t.capacity + 1e-8 >= totalLength)) throw Error('论文模式要求至少一条股道能够容纳全部车辆。');
    }
    const carMap = new Map(c.cars.map(v => [v.id, v]));
    for (const field of c.goalMode === 'custom' ? ['initial', 'goal'] : ['initial']) {
      const all = [];
      for (const t of c.tracks) {
        if (!Array.isArray(t[field]) || t[field].some(v => !ids.has(v))) throw Error(`${t.name}道${field}包含未知车号。`);
        all.push(...t[field]);
        if (t[field].reduce((a, id) => a + carMap.get(id).length, 0) > t.capacity) throw Error(`${t.name}道${field}状态超出容量。`);
      }
      if (all.length !== ids.size || new Set(all).size !== ids.size) throw Error(`${field === 'initial' ? '初始' : '目标'}状态须让每辆车恰好出现一次。`);
    }
    return c;
  }
  function context(c) {
    const cars = new Map(c.cars.map(v => [v.id, v])), ordered = new Set();
    const order = c.goalMode === 'paper' ? c.destinationOrder : c.tracks.flatMap(t=>t.goal).map(id=>cars.get(id).destination).filter((d,i,a)=>i===0||d!==a[i-1]);
    for (let i = 0; i + 1 < order.length; i++) ordered.add(JSON.stringify([order[i], order[i + 1]]));
    return { c, cars, ordered, metres: row => row.reduce((v, id) => v + cars.get(id).length, 0) };
  }
  function paperGoal(ctx, s) {
    if (s.load.length) return false;
    const totalCars = ctx.c.cars.length;
    return s.tracks.some(row => {
      if (row.length !== totalCars) return false;
      const sequence = row.map(id=>ctx.cars.get(id).destination);
      const blocks = sequence.filter((d,i)=>i===0||d!==sequence[i-1]);
      return JSON.stringify(blocks) === JSON.stringify(ctx.c.destinationOrder);
    });
  }
  function links(ctx, s) {
    const count = new Map(); let adjacent = 0;
    for (const row of s.tracks) {
      row.forEach(id => { const d = ctx.cars.get(id).destination; count.set(d, (count.get(d) || 0) + 1); });
      for (let i = 0; i + 1 < row.length; i++) adjacent += Number(ctx.cars.get(row[i]).destination === ctx.cars.get(row[i + 1]).destination);
    }
    return [...count.values()].reduce((v, n) => v + n * (n - 1), 0) - 2 * adjacent;
  }
  function timing(c, kind, oldTrack, track, before, after) {
    // Literal sum of paper (4.19)-(4.23). Track numbers passed here are 1-based.
    const speed = c.shuntingSpeed / 3600, travel = c.tracks[track - 1].capacity / (1000 * speed);
    const leg = n => travel + 0.5 * speed * (c.timeConstant + c.timePerCar * n);
    const ladderSeconds = Math.abs(oldTrack - track) * c.trackSpacing / (1000 * (c.ladderSpeed / 3600));
    const entrySeconds = leg(kind === 'PULL' ? after : before);
    const exitSeconds = leg(kind === 'PULL' ? before : after);
    return { ladderSeconds, entrySeconds, exitSeconds, durationSeconds: ladderSeconds + entrySeconds + exitSeconds };
  }
  function modelForSource(ctx, s, k) {
    const source = s.tracks[k], arcs = [], outgoing = source.map(() => []), incoming = new Map();
    const add = (i, j, target, type, reward, to) => {
      const endpoint = j === null ? JSON.stringify(['root', target]) : JSON.stringify(['car', j]);
      const arc = { name: `x_${arcs.length + 1}`, from: source[i], to, sourcePosition: i + 1, successorPosition: j === null ? null : j + 1,
        targetTrack: target === null ? null : target + 1, type, reward, i, j, target, endpoint };
      outgoing[i].push(arcs.length); if (!incoming.has(endpoint)) incoming.set(endpoint, []); incoming.get(endpoint).push(arcs.length); arcs.push(arc);
    };
    const relation = (a, b) => ctx.cars.get(a).destination === ctx.cars.get(b).destination ? 2 : ctx.ordered.has(JSON.stringify([ctx.cars.get(a).destination, ctx.cars.get(b).destination])) ? 1 : 3;
    for (let i = 0; i < source.length; i++) {
      for (let j = i + 1; j < source.length; j++) {
        const r = relation(source[i], source[j]);
        if (j === i + 1) add(i, j, null, r === 2 ? 'holding-2' : 'holding-1', r === 2 ? ctx.c.rewards.holding2 : ctx.c.rewards.holding1, source[j]);
        else if (r !== 3) add(i, j, null, `skipping-${r}`, r === 2 ? ctx.c.rewards.skipping2 : ctx.c.rewards.skipping1, source[j]);
      }
      for (let target = 0; target < s.tracks.length; target++) {
        if (target === k) add(i, null, target, 'virtual-2', ctx.c.rewards.virtual2, `V${target + 1}`);
        else if (!s.tracks[target].length) add(i, null, target, 'virtual-1', 1 / (2 * ctx.c.tracks[target].capacity), `V${target + 1}`);
        else { const to = s.tracks[target][0], r = relation(source[i], to); add(i, null, target, `shunting-${r}`, r === 2 ? ctx.c.rewards.shunting2 : r === 1 ? ctx.c.rewards.shunting1 : ctx.c.rewards.shunting3, to); }
      }
    }
    // Explicit linear part of the binary arc model; capacity is propagated along paths.
    const constraints = outgoing.map((idxs, i) => ({ name: `out_${i + 1}`, variables: idxs.map(a => arcs[a].name), sense: '=', rhs: 1 }));
    for (const idxs of incoming.values()) constraints.push({ name: `in_${constraints.length + 1}`, variables: idxs.map(a => arcs[a].name), sense: '<=', rhs: 1 });
    constraints.push({ name: 'effective_cross_track', variables: arcs.filter(a => a.target !== null && a.target !== k).map(a => a.name), sense: '>=', rhs: 1 });
    return { arcs, outgoing, constraints, k, source };
  }
  function decode(ctx, s, m, selected, targets, reward) {
    const k = m.k, source = m.source, tracks = s.tracks.map(r => [...r]);
    // Deepest consecutive cars allocated to the source can remain in place.
    let count = source.length; while (count && targets[count - 1] === k) count--;
    if (!count) return null;
    const pulled = source.slice(0, count);
    if (ctx.metres(pulled) + ctx.c.locomotive > ctx.c.headshunt) return null;
    tracks[k] = source.slice(count);
    let load = [...pulled], position = s.position, total = 0;
    const operations = [];
    const record = (kind, track, cars, before, after) => {
      const times = timing(ctx.c, kind, position, track + 1, before, after);
      total += times.durationSeconds; position = track + 1;
      operations.push({ kind, track: track + 1, trackName: ctx.c.tracks[track].name, cars: [...cars], before, after, ...times,
        state: { tracks: tracks.map(r => [...r]), load: [...load], position } });
    };
    record('PULL', k, pulled, 0, load.length);
    let p = count - 1;
    while (p >= 0) {
      const target = targets[p]; let start = p; while (start > 0 && targets[start - 1] === target) start--;
      const moved = source.slice(start, p + 1), before = load.length;
      load = load.slice(0, load.length - moved.length); tracks[target] = [...moved, ...tracks[target]];
      if (ctx.metres(tracks[target]) > ctx.c.tracks[target].capacity) return null;
      record('PUSH', target, moved, before, load.length); p = start - 1;
    }
    const targetState = { tracks, load: [], position };
    const publicArc = a => ({ name: a.name, from: a.from, to: a.to, type: a.type, reward: a.reward, sourcePosition: a.sourcePosition, successorPosition: a.successorPosition, targetTrack: a.targetTrack });
    return { state: targetState, action: { sourceTrack: k + 1, sourceTrackName: ctx.c.tracks[k].name, pulledCars: pulled, reward,
      durationSeconds: total, cost: ctx.c.objective === 'time' ? total : 1, operations,
      model: { formulation: 'SAN-forward-path-binary-reformulation',
        t: Object.fromEntries(ctx.c.tracks.map((_, i) => [`t_${i + 1}`, i === k ? 1 : 0])),
        x: Object.fromEntries(m.arcs.map((a, i) => [a.name, Number(selected.includes(i))])),
        selectedArcs: selected.map(i => publicArc(m.arcs[i])), candidateArcs: m.arcs.map(publicArc),
        linearConstraints: m.constraints, capacityRule: 'sum(length_i for paths ending on k) + existing_non_source_length_k <= capacity_k' } } };
  }
  function newStats() { return { expanded: 0, generated: 0, dominancePruned: 0, boundPruned: 0, capacityPruned: 0, sanModels: 0, sanBbNodes: 0, sanRewardBoundPruned: 0, sanFeasibleSolutions: 0, sanPoolTruncated: 0 }; }
  function sanCandidates(ctx, s, stats, deadline = Infinity, bbLimit = 2000000) {
    const all = []; let truncated = false, reason = null;
    for (let k = 0; k < s.tracks.length; k++) {
      if (!s.tracks[k].length) continue;
      const m = modelForSource(ctx, s, k), n = m.source.length;
      const selected = Array(n), targets = Array(n), usedEnds = new Set(), lengths = s.tracks.map((row, i) => i === k ? 0 : ctx.metres(row));
      const upper = [], pool = new Map(), cap = ctx.c.poolSize;
      let bound = -Infinity;
      for (let i = 0; i < n; i++) { m.outgoing[i].sort((a, b) => m.arcs[b].reward - m.arcs[a].reward); upper[i] = Math.max(...m.outgoing[i].map(a => m.arcs[a].reward)) + (i ? upper[i - 1] : 0); }
      stats.sanModels++;
      function visit(i, score, cross) {
        if (reason) return;
        if (now() >= deadline) { reason = 'time_limit'; return; }
        if (stats.sanBbNodes >= bbLimit) { reason = 'san_node_limit'; return; }
        stats.sanBbNodes++;
        if (i >= 0 && cap && pool.size >= cap && score + upper[i] < bound - 1e-10) { stats.sanRewardBoundPruned++; truncated = true; return; }
        if (i < 0) {
          if (!cross) return;
          const child = decode(ctx, s, m, selected, targets, score);
          if (!child) { stats.capacityPruned++; return; }
          stats.sanFeasibleSolutions++;
          const identity = key(child.state), old = pool.get(identity);
          // Same end state may have different costs; keep the cheaper actual action.
          if (old && old.action.cost <= child.action.cost) return;
          pool.set(identity, child);
          if (cap && pool.size > cap) {
            const ranked = [...pool].sort((a, b) => b[1].action.reward - a[1].action.reward || a[1].action.cost - b[1].action.cost);
            pool.delete(ranked.at(-1)[0]); truncated = true;
          }
          if (cap && pool.size >= cap) bound = Math.min(...[...pool.values()].map(a => a.action.reward));
          return;
        }
        // Branch on exactly-one outgoing binary variable; siblings set the others to 0.
        // Processing deep-to-shallow makes successor-path destinations already known.
        for (const ai of m.outgoing[i]) {
          const a = m.arcs[ai]; if (usedEnds.has(a.endpoint)) continue;
          const target = a.j === null ? a.target : targets[a.j];
          const length = ctx.cars.get(m.source[i]).length;
          if (lengths[target] + length > ctx.c.tracks[target].capacity) { stats.capacityPruned++; continue; }
          selected[i] = ai; targets[i] = target; usedEnds.add(a.endpoint); lengths[target] += length;
          visit(i - 1, score + a.reward, cross || target !== k);
          usedEnds.delete(a.endpoint); lengths[target] -= length;
          if (reason) break;
        }
      }
      visit(n - 1, 0, false);
      all.push(...pool.values());
      if (reason) break;
    }
    if (truncated) stats.sanPoolTruncated++;
    return { candidates: all, truncated, reason };
  }
  function solve(input, progress = () => {}) {
    const c = validate(input), ctx = context(c), start = now(), deadline = start + c.timeLimit * 1000;
    const initial = { tracks: c.tracks.map(t => [...t.initial]), load: [], position: c.initialTrack };
    const isGoal = s => c.goalMode === 'paper' ? paperGoal(ctx, s) : s.tracks.every((r, k) => JSON.stringify(r) === JSON.stringify(c.tracks[k].goal));
    const nodes = [{ state: initial, g: 0, seconds: 0, parent: null, action: null }], best = new Map([[key(initial), 0]]), heap = new Heap(), stats = newStats();
    heap.push([c.weight * links(ctx, initial), 0]);
    let incumbent = isGoal(initial) ? 0 : null, ub = incumbent === 0 ? 0 : Infinity, reason = 'exhausted', restricted = false;
    if (incumbent === 0) { heap.a = []; reason = 'initial_is_goal'; }
    while (heap.size) {
      if (now() >= deadline) { reason = 'time_limit'; break; }
      const [, index] = heap.pop(), node = nodes[index];
      if (node.g !== best.get(key(node.state))) continue;
      if (node.g >= ub) { stats.boundPruned++; continue; }
      stats.expanded++;
      const sub = sanCandidates(ctx, node.state, stats, deadline); restricted ||= sub.truncated;
      for (const child of sub.candidates) {
        stats.generated++; const g = node.g + child.action.cost, identity = key(child.state);
        if (g >= ub) { stats.boundPruned++; continue; }
        if (g >= (best.get(identity) ?? Infinity)) { stats.dominancePruned++; continue; }
        if (nodes.length >= 60000) { reason = 'node_limit'; break; }
        const id = nodes.length; best.set(identity, g);
        nodes.push({ state: child.state, action: child.action, parent: index, g, seconds: node.seconds + child.action.durationSeconds });
        if (isGoal(child.state)) { ub = g; incumbent = id; }
        else heap.push([g + c.weight * links(ctx, child.state), id]);
      }
      if (reason === 'node_limit' || sub.reason) { reason = sub.reason || reason; break; }
      if (stats.expanded % 50 === 0) progress({ ...stats, bestCost: Number.isFinite(ub) ? ub : null });
    }
    const complete = ['exhausted', 'initial_is_goal'].includes(reason) && !restricted;
    const status = incumbent !== null ? complete ? 'optimal' : 'feasible' : complete ? 'infeasible' : 'no_solution_found';
    const path = []; if (incumbent !== null) for (let i = incumbent; nodes[i].parent !== null; i = nodes[i].parent) path.push(nodes[i]); path.reverse();
    let cumulativeSeconds = 0; const operations = [];
    const steps = path.map((node, i) => {
      const a = clone(node.action);
      a.operations = a.operations.map(op => { cumulativeSeconds += op.durationSeconds; const result = { ...op, step: operations.length + 1, round: i + 1, cumulativeSeconds }; operations.push(result); return result; });
      return { ...a, step: i + 1, cumulativeCost: node.g, cumulativeSeconds, lambda: links(ctx, node.state), priority: node.g + c.weight * links(ctx, node.state), state: node.state };
    });
    const totalTimeSeconds = incumbent === null ? null : nodes[incumbent].seconds;
    const summary = operations.reduce((sum, op) => { for (const field of ['ladderSeconds', 'entrySeconds', 'exitSeconds']) sum[field] += op[field]; return sum; }, { ladderSeconds: 0, entrySeconds: 0, exitSeconds: 0 });
    return { schemaVersion: 4, algorithm: 'SAN binary arc reformulation + paper-weighted A*', solverEngine: 'browser', status,
      optimalityProven: incumbent !== null && complete, optimalityScope: '仅限当前有向SAN弧模型、固定ID目标、未执行跨轮推牵合并的宏动作空间',
      termination: reason, candidatePoolRestricted: restricted, objective: c.objective, weight: c.weight, poolSize: c.poolSize,
      totalCost: incumbent === null ? null : ub, totalTimeSeconds, roundCount: incumbent === null ? null : steps.length,
      operationCount: incumbent === null ? null : operations.length, timeBreakdown: incumbent === null ? null : summary,
      parameters: c, initial, steps, operations, statistics: { ...stats, acceptedNodes: nodes.length, elapsedSeconds: (now() - start) / 1000 },
      trackNumbers: c.tracks.map((t, i) => ({ number: i + 1, name: t.name })), destinations: Object.fromEntries(c.cars.map(v => [v.id, v.destination])),
      timeModel: '论文式(4.19)-(4.23)，单位秒，未计防溜、制动试验、现场等待；是模型估计而非实测',
      goalMode: c.goalMode, destinationOrder: c.destinationOrder,
      deviations: ['正向无环SAN弧模型重构，非逐式Gurobi复现', '未实施4.5.5跨轮冗余推牵合并', '未启用未明确量化的首轮虚拟弧预热', '不采用未证明安全的局部聚类硬剪枝'] };
  }
  const api = { validate, context, paperGoal, timing, links, modelForSource, sanCandidates, newStats, solve };
  root.ShuntingSolver = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
