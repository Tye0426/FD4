"""HTTP backend for the website's Gurobi SAN + weighted A* mode."""
from __future__ import annotations

import heapq
import json
import math
import os
import time
from collections import Counter, defaultdict
from typing import Any

import gurobipy as gp
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


app = FastAPI(title="SAN-A* Gurobi API", version="1.0.0")
origins = [v.strip() for v in os.getenv("ALLOWED_ORIGINS", "*").split(",") if v.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["POST", "GET"], allow_headers=["*"])


class SolveBody(BaseModel):
    model_config = {"extra": "allow"}


def validate(raw: dict[str, Any]) -> dict[str, Any]:
    c = json.loads(json.dumps(raw))
    if not 1 <= len(c.get("cars", [])) <= 40:
        raise ValueError("请配置1～40辆车。")
    if not 2 <= len(c.get("tracks", [])) <= 12:
        raise ValueError("请配置2～12条股道。")
    ids = [x["id"] for x in c["cars"]]
    if len(ids) != len(set(ids)) or any(not x for x in ids):
        raise ValueError("车辆ID必须非空且唯一。")
    c.setdefault("goalMode", "custom")
    c.setdefault("destinationOrder", list(dict.fromkeys(str(x["destination"]) for x in c["cars"])))
    c.setdefault("objective", "time")
    c.setdefault("weight", 350.0)
    c.setdefault("poolSize", 100)
    c.setdefault("timeLimit", 10.0)
    c.setdefault("initialTrack", 1)
    c.setdefault("shuntingSpeed", 16.0)
    c.setdefault("ladderSpeed", 10.0)
    c.setdefault("trackSpacing", 3.0)
    c.setdefault("timeConstant", 13500.0)
    c.setdefault("timePerCar", 517.5)
    defaults = dict(shunting1=1, shunting2=2, shunting3=0, skipping1=1, skipping2=2, holding1=0, holding2=.1, virtual2=0)
    c["rewards"] = {**defaults, **c.get("rewards", {})}
    car_ids = set(ids)
    seen = []
    for track in c["tracks"]:
        seen += track.get("initial", [])
    if Counter(seen) != Counter(ids):
        raise ValueError("初始状态必须让每辆车恰好出现一次。")
    if c["goalMode"] == "custom":
        goal = [x for t in c["tracks"] for x in t.get("goal", [])]
        if Counter(goal) != Counter(ids):
            raise ValueError("自定义目标必须让每辆车恰好出现一次。")
    else:
        present = set(str(x["destination"]) for x in c["cars"])
        if set(c["destinationOrder"]) != present or len(c["destinationOrder"]) != len(present):
            raise ValueError("论文模式去向顺序必须恰好包含全部去向。")
        total = sum(float(x["length"]) for x in c["cars"])
        if not any(float(t["capacity"]) >= total for t in c["tracks"]):
            raise ValueError("论文模式要求至少一条股道能够容纳全部车辆。")
    if not 1 <= int(c["initialTrack"]) <= len(c["tracks"]):
        raise ValueError("初始机车股道编号超出范围。")
    if float(c["locomotive"]) > float(c["headshunt"]):
        raise ValueError("牵出线不能短于机车。")
    if any(x not in car_ids for t in c["tracks"] for x in t.get("initial", [])):
        raise ValueError("初始状态包含未知车辆。")
    return c


class Solver:
    def __init__(self, config: dict[str, Any]):
        self.c = validate(config)
        self.cars = {x["id"]: x for x in self.c["cars"]}
        self.deadline = time.perf_counter() + float(self.c["timeLimit"])
        self.order = self.c["destinationOrder"] if self.c["goalMode"] == "paper" else self._custom_order()
        self.ordered = set(zip(self.order, self.order[1:]))
        self.stats = dict(expanded=0, generated=0, dominancePruned=0, boundPruned=0, capacityPruned=0,
                          sanModels=0, sanBbNodes=0, sanRewardBoundPruned=0, sanFeasibleSolutions=0,
                          sanPoolTruncated=0, acceptedNodes=0, elapsedSeconds=0.0)

    def _custom_order(self):
        seq = [str(self.cars[x]["destination"]) for t in self.c["tracks"] for x in t.get("goal", [])]
        return [x for i, x in enumerate(seq) if i == 0 or x != seq[i - 1]]

    def metres(self, row):
        return sum(float(self.cars[x]["length"]) for x in row)

    def relation(self, a, b):
        da, db = str(self.cars[a]["destination"]), str(self.cars[b]["destination"])
        return 2 if da == db else 1 if (da, db) in self.ordered else 3

    def links(self, state):
        counts, adjacent = Counter(), 0
        for row in state[0]:
            counts.update(str(self.cars[x]["destination"]) for x in row)
            adjacent += sum(str(self.cars[a]["destination"]) == str(self.cars[b]["destination"]) for a, b in zip(row, row[1:]))
        return sum(n * (n - 1) for n in counts.values()) - 2 * adjacent

    def is_goal(self, state):
        tracks, _ = state
        if self.c["goalMode"] == "custom":
            return tracks == tuple(tuple(t["goal"]) for t in self.c["tracks"])
        for row in tracks:
            if len(row) != len(self.c["cars"]):
                continue
            ds = [str(self.cars[x]["destination"]) for x in row]
            blocks = [x for i, x in enumerate(ds) if i == 0 or x != ds[i - 1]]
            if blocks == self.c["destinationOrder"]:
                return True
        return False

    def timing(self, kind, old_track, track, before, after):
        speed = float(self.c["shuntingSpeed"]) / 3600
        travel = float(self.c["tracks"][track - 1]["capacity"]) / (1000 * speed)
        leg = lambda n: travel + .5 * speed * (float(self.c["timeConstant"]) + float(self.c["timePerCar"]) * n)
        ladder = abs(old_track - track) * float(self.c["trackSpacing"]) / (1000 * (float(self.c["ladderSpeed"]) / 3600))
        entry = leg(after if kind == "PULL" else before)
        exit_ = leg(before if kind == "PULL" else after)
        return dict(ladderSeconds=ladder, entrySeconds=entry, exitSeconds=exit_, durationSeconds=ladder + entry + exit_)

    def arcs(self, state, k):
        source, rewards = state[0][k], self.c["rewards"]
        arcs, outgoing, incoming = [], [[] for _ in source], defaultdict(list)
        def add(i, j, target, kind, reward, to):
            endpoint = ("root", target) if j is None else ("car", j)
            a = dict(name=f"x_{len(arcs)+1}", **{"from": source[i]}, to=to, sourcePosition=i+1,
                     successorPosition=None if j is None else j+1, targetTrack=None if target is None else target+1,
                     type=kind, reward=float(reward), i=i, j=j, target=target, endpoint=endpoint)
            outgoing[i].append(len(arcs)); incoming[endpoint].append(len(arcs)); arcs.append(a)
        for i in range(len(source)):
            for j in range(i + 1, len(source)):
                r = self.relation(source[i], source[j])
                if j == i + 1:
                    add(i, j, None, "holding-2" if r == 2 else "holding-1", rewards["holding2"] if r == 2 else rewards["holding1"], source[j])
                elif r != 3:
                    add(i, j, None, f"skipping-{r}", rewards["skipping2"] if r == 2 else rewards["skipping1"], source[j])
            for target in range(len(state[0])):
                if target == k:
                    add(i, None, target, "virtual-2", rewards["virtual2"], f"V{target+1}")
                elif not state[0][target]:
                    add(i, None, target, "virtual-1", 1 / (2 * float(self.c["tracks"][target]["capacity"])), f"V{target+1}")
                else:
                    to, r = state[0][target][0], self.relation(source[i], state[0][target][0])
                    add(i, None, target, f"shunting-{r}", rewards[f"shunting{r}"], to)
        return source, arcs, outgoing, incoming

    @staticmethod
    def public_arc(a):
        return {k: a[k] for k in ("name", "from", "to", "type", "reward", "sourcePosition", "successorPosition", "targetTrack")}

    def decode(self, state, k, source, arcs, chosen):
        targets, selected = [None] * len(source), []
        for i in range(len(source) - 1, -1, -1):
            ai = chosen[i]; a = arcs[ai]; selected.append(ai)
            targets[i] = a["target"] if a["j"] is None else targets[a["j"]]
        count = len(source)
        while count and targets[count - 1] == k:
            count -= 1
        if not count:
            return None
        pulled = source[:count]
        if self.metres(pulled) + float(self.c["locomotive"]) > float(self.c["headshunt"]):
            return None
        tracks = [list(x) for x in state[0]]; tracks[k] = list(source[count:])
        load, position, total, operations = list(pulled), state[1], 0.0, []
        def record(kind, track, cars, before, after):
            nonlocal position, total
            ts = self.timing(kind, position, track + 1, before, after); total += ts["durationSeconds"]; position = track + 1
            operations.append(dict(kind=kind, track=track+1, trackName=self.c["tracks"][track]["name"], cars=list(cars), before=before, after=after,
                                   **ts, state=dict(tracks=[list(x) for x in tracks], load=list(load), position=position)))
        record("PULL", k, pulled, 0, len(load))
        p = count - 1
        while p >= 0:
            target, start = targets[p], p
            while start > 0 and targets[start - 1] == target:
                start -= 1
            moved, before = source[start:p+1], len(load); del load[-len(moved):]; tracks[target] = list(moved) + tracks[target]
            if self.metres(tracks[target]) > float(self.c["tracks"][target]["capacity"]) + 1e-8:
                return None
            record("PUSH", target, moved, before, len(load)); p = start - 1
        new_state = (tuple(tuple(x) for x in tracks), position)
        reward = sum(arcs[x]["reward"] for x in selected)
        constraints = ([dict(name=f"out_{i+1}", variables=[arcs[x]["name"] for x in row], sense="=", rhs=1) for i, row in enumerate(self._last_outgoing)] +
                       [dict(name=f"in_{i+1}", variables=[arcs[x]["name"] for x in row], sense="<=", rhs=1) for i, row in enumerate(self._last_incoming.values())])
        constraints.append(dict(name="effective_cross_track", variables=[a["name"] for a in arcs if a["target"] is not None and a["target"] != k], sense=">=", rhs=1))
        action = dict(sourceTrack=k+1, sourceTrackName=self.c["tracks"][k]["name"], pulledCars=list(pulled), reward=reward,
                      durationSeconds=total, cost=total if self.c["objective"] == "time" else 1, operations=operations,
                      model=dict(formulation="SAN-0-1-Gurobi", t={f"t_{i+1}": int(i == k) for i in range(len(tracks))},
                                 x={a["name"]: int(i in selected) for i, a in enumerate(arcs)},
                                 selectedArcs=[self.public_arc(arcs[i]) for i in selected], candidateArcs=[self.public_arc(a) for a in arcs],
                                 linearConstraints=constraints, capacityRule="solution decoded and checked against effective track length"))
        return new_state, action

    def candidates(self, state):
        candidates, restricted = {}, False
        for k, row in enumerate(state[0]):
            if not row or time.perf_counter() >= self.deadline:
                continue
            source, arcs, outgoing, incoming = self.arcs(state, k); self._last_outgoing, self._last_incoming = outgoing, incoming
            model = gp.Model(f"SAN_track_{k+1}"); model.Params.OutputFlag = 0
            model.Params.TimeLimit = max(.01, self.deadline - time.perf_counter()); model.Params.PoolSearchMode = 2
            requested = int(self.c["poolSize"]); model.Params.PoolSolutions = requested if requested else 10000
            x = model.addVars(len(arcs), vtype=gp.GRB.BINARY, name="x")
            for idxs in outgoing: model.addConstr(gp.quicksum(x[i] for i in idxs) == 1)
            for idxs in incoming.values(): model.addConstr(gp.quicksum(x[i] for i in idxs) <= 1)
            cross = [i for i, a in enumerate(arcs) if a["target"] is not None and a["target"] != k]
            model.addConstr(gp.quicksum(x[i] for i in cross) >= 1)
            model.setObjective(gp.quicksum(arcs[i]["reward"] * x[i] for i in range(len(arcs))), gp.GRB.MAXIMIZE)
            model.optimize(); self.stats["sanModels"] += 1; self.stats["sanBbNodes"] += int(model.NodeCount)
            if model.Status == gp.GRB.TIME_LIMIT: restricted = True
            for solution in range(model.SolCount):
                model.Params.SolutionNumber = solution
                chosen = {}
                for i, idxs in enumerate(outgoing):
                    selected = [a for a in idxs if x[a].Xn > .5]
                    if len(selected) != 1: break
                    chosen[i] = selected[0]
                if len(chosen) != len(source): continue
                decoded = self.decode(state, k, source, arcs, chosen)
                if not decoded: self.stats["capacityPruned"] += 1; continue
                child, action = decoded; self.stats["sanFeasibleSolutions"] += 1
                if child not in candidates or action["cost"] < candidates[child]["cost"]: candidates[child] = action
            if requested and model.SolCount >= requested: restricted = True
        if restricted: self.stats["sanPoolTruncated"] += 1
        return [(s, a) for s, a in candidates.items()], restricted

    def solve(self):
        started = time.perf_counter(); initial = (tuple(tuple(t["initial"]) for t in self.c["tracks"]), int(self.c["initialTrack"]))
        nodes = [dict(state=initial, g=0.0, seconds=0.0, parent=None, action=None)]
        best, heap, serial = {initial: 0.0}, [], 0
        heapq.heappush(heap, (float(self.c["weight"]) * self.links(initial), serial, 0))
        incumbent, upper, reason, restricted = (0, 0.0, "initial_is_goal", False) if self.is_goal(initial) else (None, math.inf, "exhausted", False)
        if incumbent is not None: heap.clear()
        while heap:
            if time.perf_counter() >= self.deadline: reason = "time_limit"; break
            _, _, idx = heapq.heappop(heap); node = nodes[idx]
            if node["g"] != best.get(node["state"]): continue
            if node["g"] >= upper: self.stats["boundPruned"] += 1; continue
            self.stats["expanded"] += 1
            children, cut = self.candidates(node["state"]); restricted |= cut
            for state, action in children:
                self.stats["generated"] += 1; g = node["g"] + action["cost"]
                if g >= upper: self.stats["boundPruned"] += 1; continue
                if g >= best.get(state, math.inf): self.stats["dominancePruned"] += 1; continue
                best[state] = g; child_id = len(nodes); nodes.append(dict(state=state, g=g, seconds=node["seconds"]+action["durationSeconds"], parent=idx, action=action))
                if self.is_goal(state): incumbent, upper = child_id, g
                else: serial += 1; heapq.heappush(heap, (g + float(self.c["weight"]) * self.links(state), serial, child_id))
            if restricted and time.perf_counter() >= self.deadline: reason = "time_limit"; break
        complete = reason in ("exhausted", "initial_is_goal") and not restricted
        status = ("optimal" if complete else "feasible") if incumbent is not None else ("infeasible" if complete else "no_solution_found")
        path = []
        if incumbent is not None:
            i = incumbent
            while nodes[i]["parent"] is not None: path.append(nodes[i]); i = nodes[i]["parent"]
            path.reverse()
        cumulative, operations, steps = 0.0, [], []
        for round_no, node in enumerate(path, 1):
            action = json.loads(json.dumps(node["action"]))
            for op in action["operations"]:
                cumulative += op["durationSeconds"]; op.update(step=len(operations)+1, round=round_no, cumulativeSeconds=cumulative); operations.append(op)
            state = node["state"]; lam = self.links(state)
            action.update(step=round_no, cumulativeCost=node["g"], cumulativeSeconds=cumulative, **{"lambda": lam}, priority=node["g"]+float(self.c["weight"])*lam,
                          state=dict(tracks=[list(x) for x in state[0]], load=[], position=state[1])); steps.append(action)
        total = None if incumbent is None else nodes[incumbent]["seconds"]
        breakdown = None if total is None else {f: sum(op[f] for op in operations) for f in ("ladderSeconds", "entrySeconds", "exitSeconds")}
        self.stats["acceptedNodes"], self.stats["elapsedSeconds"] = len(nodes), time.perf_counter() - started
        return dict(schemaVersion=4, algorithm="paper SAN 0-1 MIP (Gurobi) + weighted A*", solverEngine="gurobi", status=status,
                    optimalityProven=incumbent is not None and complete, optimalityScope="当前SAN动作空间与所选目标模式", termination=reason,
                    candidatePoolRestricted=restricted, objective=self.c["objective"], weight=self.c["weight"], poolSize=self.c["poolSize"],
                    totalCost=None if incumbent is None else upper, totalTimeSeconds=total, roundCount=None if incumbent is None else len(steps),
                    operationCount=None if incumbent is None else len(operations), timeBreakdown=breakdown, parameters=self.c,
                    initial=dict(tracks=[list(x) for x in initial[0]], load=[], position=initial[1]), steps=steps, operations=operations, statistics=self.stats,
                    trackNumbers=[dict(number=i+1, name=t["name"]) for i, t in enumerate(self.c["tracks"])],
                    destinations={x["id"]: str(x["destination"]) for x in self.c["cars"]}, goalMode=self.c["goalMode"], destinationOrder=self.c["destinationOrder"],
                    timeModel="论文式(4.19)-(4.23)，使用页面自定义参数", deviations=["未实施跨轮冗余推牵合并", "未启用未量化的首轮预热规则"])


@app.get("/health")
def health():
    try:
        env = gp.Env(empty=True); env.setParam("OutputFlag", 0); env.start(); env.dispose()
        return {"ok": True, "gurobi": gp.gurobi.version()}
    except gp.GurobiError as exc:
        raise HTTPException(status_code=503, detail=f"Gurobi许可证不可用：{exc}") from exc


@app.post("/solve")
def solve(body: SolveBody):
    try:
        return Solver(body.model_dump()).solve()
    except gp.GurobiError as exc:
        raise HTTPException(status_code=503, detail=f"Gurobi求解失败：{exc}") from exc
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
