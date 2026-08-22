const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 20000, pingInterval: 25000 });

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const STARTING_CHIPS = 10000;
const SMALL_BLIND = 50;
const BIG_BLIND = 100;
const TURN_MS = 25000;
const rooms = new Map();

function cleanText(v, max = 20) {
  return String(v || "").trim().replace(/[<>]/g, "").slice(0, max);
}
function randomRoom() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function makeDeck() {
  const suits = ["S", "H", "D", "C"];
  const ranks = [2,3,4,5,6,7,8,9,10,11,12,13,14];
  const d = [];
  for (const s of suits) for (const r of ranks) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
function cardText(c) {
  if (!c) return "";
  const ranks = {11:"J",12:"Q",13:"K",14:"A"};
  const suits = {S:"♠",H:"♥",D:"♦",C:"♣"};
  return `${ranks[c.r] || c.r}${suits[c.s]}`;
}
function nextSeat(room) {
  let seat = 1;
  while (room.players.some(p => p.seat === seat)) seat++;
  return seat;
}
function roomOf(socket) {
  return rooms.get(socket.data.room);
}
function getPlayer(room, id) {
  return room.players.find(p => p.id === id);
}
function playablePlayers(room) {
  return room.players.filter(p => p.connected && !p.sittingOut && p.chips > 0);
}
function handPlayers(room) {
  return room.players.filter(p => p.inHand);
}
function contenders(room) {
  return room.players.filter(p => p.inHand && !p.folded);
}
function actionable(room) {
  return room.players.filter(p => p.inHand && !p.folded && !p.allIn);
}
function ordered(players) {
  return [...players].sort((a,b) => a.seat - b.seat);
}
function nextFromSeat(list, seat, predicate = () => true) {
  const a = ordered(list).filter(predicate);
  if (!a.length) return null;
  const after = a.find(p => p.seat > seat);
  return after || a[0];
}
function post(room, p, amount) {
  const paid = Math.min(p.chips, amount);
  p.chips -= paid;
  p.streetBet += paid;
  p.totalBet += paid;
  room.pot += paid;
  if (p.chips === 0) p.allIn = true;
  return paid;
}
function log(room, msg) {
  room.log.unshift(msg);
  room.log = room.log.slice(0, 12);
}
function publicState(room, viewerId) {
  const viewer = getPlayer(room, viewerId);
  const showAll = room.stage === "showdown";
  return {
    room: room.code,
    stage: room.stage,
    pot: room.pot,
    board: room.board.map(cardText),
    currentBet: room.currentBet,
    dealerSeat: room.dealerSeat,
    turnId: room.turnId,
    actionDeadline: room.actionDeadline,
    handNumber: room.handNumber,
    message: room.message,
    log: room.log,
    canStart: !room.handActive && playablePlayers(room).length >= 2,
    me: viewer ? viewer.id : null,
    players: ordered(room.players).map(p => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      chips: p.chips,
      connected: p.connected,
      sittingOut: p.sittingOut,
      inHand: p.inHand,
      folded: p.folded,
      allIn: p.allIn,
      streetBet: p.streetBet,
      status: !p.connected ? "离线" :
              p.sittingOut ? "暂停" :
              p.folded ? "已弃牌" :
              p.allIn ? "All-in" :
              p.inHand ? (room.turnId === p.id ? "行动中" : "游戏中") : "等待下一局",
      cards: (p.id === viewerId || (showAll && p.inHand && !p.folded))
        ? p.hole.map(cardText)
        : (p.inHand ? ["BACK","BACK"] : []),
      isDealer: p.seat === room.dealerSeat,
      isSB: p.id === room.sbId,
      isBB: p.id === room.bbId
    })),
    legal: viewer ? legalActions(room, viewer) : {}
  };
}
function emitState(room) {
  for (const p of room.players) {
    if (p.connected) io.to(p.id).emit("state", publicState(room, p.id));
  }
}
function legalActions(room, p) {
  if (!room.handActive || room.turnId !== p.id || p.folded || p.allIn || !p.inHand) {
    return {};
  }
  const toCall = Math.max(0, room.currentBet - p.streetBet);
  const minRaiseTo = room.currentBet + room.minRaise;
  const maxRaiseTo = p.streetBet + p.chips;
  const canMakeFullRaise = room.raiseRights.has(p.id) && maxRaiseTo >= minRaiseTo;
  return {
    fold: true,
    check: toCall === 0,
    call: toCall > 0,
    callAmount: Math.min(toCall, p.chips),
    raise: canMakeFullRaise,
    minRaiseTo,
    maxRaiseTo,
    betLabel: room.currentBet === 0 ? "下注 Bet" : "加注 Raise",
    allIn: p.chips > 0
  };
}
function clearTurnTimer(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = null;
  room.actionDeadline = null;
}
function armTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.turnId || !room.handActive) return;
  const token = `${room.handNumber}:${room.stage}:${room.turnId}:${Date.now()}`;
  room.turnToken = token;
  room.actionDeadline = Date.now() + TURN_MS;
  room.turnTimer = setTimeout(() => {
    if (room.turnToken !== token || !room.handActive) return;
    const p = getPlayer(room, room.turnId);
    if (!p) return;
    const toCall = Math.max(0, room.currentBet - p.streetBet);
    if (toCall === 0) {
      log(room, `${p.name} 超时，自动过牌`);
      handleAction(room, p, "check", 0, true);
    } else {
      log(room, `${p.name} 超时，自动弃牌`);
      handleAction(room, p, "fold", 0, true);
    }
  }, TURN_MS);
}
function setTurn(room, p) {
  room.turnId = p ? p.id : null;
  armTurnTimer(room);
  emitState(room);
}
function chooseNextPending(room, afterSeat) {
  return nextFromSeat(room.players, afterSeat, p => room.pending.has(p.id));
}

function clearNextHandTimer(room) {
  if (room.nextHandTimer) clearTimeout(room.nextHandTimer);
  room.nextHandTimer = null;
}

function cleanBettingSets(room) {
  room.pending = new Set([...room.pending].filter(id => {
    const p = getPlayer(room, id);
    return p && p.inHand && !p.folded && !p.allIn;
  }));
  room.raiseRights = new Set([...room.raiseRights].filter(id => {
    const p = getPlayer(room, id);
    return p && p.inHand && !p.folded && !p.allIn;
  }));
}

function requireResponsesToBet(room, actorId) {
  for (const p of actionable(room)) {
    if (p.id !== actorId && p.streetBet < room.currentBet) room.pending.add(p.id);
  }
}

function startHand(room) {
  if (room.handActive) return false;
  clearTurnTimer(room);
  clearNextHandTimer(room);
  room.players = room.players.filter(p => p.connected || p.inHand);
  const active = playablePlayers(room);
  if (active.length < 2) {
    room.handActive = false;
    room.stage = "waiting";
    room.message = "等待至少 2 名玩家加入";
    room.turnId = null;
    emitState(room);
    return false;
  }

  room.handActive = true;
  room.handNumber++;
  room.stage = "preflop";
  room.deck = makeDeck();
  room.board = [];
  room.pot = 0;
  room.currentBet = 0;
  room.minRaise = BIG_BLIND;
  room.pending = new Set();
  room.raiseRights = new Set();
  room.message = `第 ${room.handNumber} 局`;
  room.sbId = null;
  room.bbId = null;

  for (const p of room.players) {
    p.inHand = active.includes(p);
    p.folded = false;
    p.allIn = false;
    p.streetBet = 0;
    p.totalBet = 0;
    p.hole = [];
  }

  const seats = ordered(active);
  const oldDealer = room.dealerSeat || 0;
  const dealer = nextFromSeat(seats, oldDealer) || seats[0];
  room.dealerSeat = dealer.seat;

  let sb, bb;
  if (seats.length === 2) {
    sb = dealer;
    bb = nextFromSeat(seats, dealer.seat);
  } else {
    sb = nextFromSeat(seats, dealer.seat);
    bb = nextFromSeat(seats, sb.seat);
  }
  room.sbId = sb.id;
  room.bbId = bb.id;

  // Deal one card at a time beginning left of dealer.
  let dealSeat = dealer.seat;
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < seats.length; i++) {
      const p = nextFromSeat(seats, dealSeat);
      p.hole.push(room.deck.pop());
      dealSeat = p.seat;
    }
    dealSeat = dealer.seat;
  }

  post(room, sb, SMALL_BLIND);
  post(room, bb, BIG_BLIND);
  room.currentBet = Math.max(sb.streetBet, bb.streetBet);
  room.pending = new Set(actionable(room).map(p => p.id));
  room.raiseRights = new Set(actionable(room).map(p => p.id));

  log(room, `${dealer.name} 是庄家`);
  log(room, `${sb.name} 小盲 ${sb.streetBet}，${bb.name} 大盲 ${bb.streetBet}`);

  if (contenders(room).length <= 1) return finishByFold(room);
  if (actionable(room).length === 0) return runoutAndShowdown(room);

  // If everyone except one player is already all-in from the blinds, the
  // remaining player only needs a turn when chips are still owed to the pot.
  if (actionable(room).length === 1) {
    const lone = actionable(room)[0];
    if (lone.streetBet >= room.currentBet) return runoutAndShowdown(room);
    room.pending = new Set([lone.id]);
    room.raiseRights = new Set();
  }

  const first = nextFromSeat(seats, bb.seat, p => room.pending.has(p.id));
  setTurn(room, first);
  return true;
}
function scheduleNextHand(room, delay = 4500) {
  clearTurnTimer(room);
  room.turnId = null;
  clearNextHandTimer(room);
  room.nextHandTimer = setTimeout(() => {
    room.nextHandTimer = null;
    room.players = room.players.filter(p => p.connected);
    startHand(room);
  }, delay);
  emitState(room);
}
function resetStreet(room) {
  for (const p of room.players) p.streetBet = 0;
  room.currentBet = 0;
  room.minRaise = BIG_BLIND;
  room.pending = new Set(actionable(room).map(p => p.id));
  room.raiseRights = new Set(actionable(room).map(p => p.id));
}
function burn(room) { room.deck.pop(); }
function advanceStreet(room) {
  clearTurnTimer(room);
  if (contenders(room).length <= 1) return finishByFold(room);
  if (actionable(room).length <= 1) return runoutAndShowdown(room);

  resetStreet(room);
  if (room.stage === "preflop") {
    burn(room);
    room.board.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    room.stage = "flop";
    log(room, `翻牌：${room.board.map(cardText).join(" ")}`);
  } else if (room.stage === "flop") {
    burn(room);
    room.board.push(room.deck.pop());
    room.stage = "turn";
    log(room, `转牌：${cardText(room.board[3])}`);
  } else if (room.stage === "turn") {
    burn(room);
    room.board.push(room.deck.pop());
    room.stage = "river";
    log(room, `河牌：${cardText(room.board[4])}`);
  } else if (room.stage === "river") {
    return showdown(room);
  }

  if (actionable(room).length <= 1) return runoutAndShowdown(room);

  const first = nextFromSeat(room.players, room.dealerSeat, p => room.pending.has(p.id));
  setTurn(room, first);
}
function runoutAndShowdown(room) {
  clearTurnTimer(room);
  room.pending.clear();
  room.raiseRights.clear();
  room.turnId = null;
  while (room.board.length < 5) {
    if (room.board.length === 0) {
      burn(room);
      room.board.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
      room.stage = "flop";
    } else if (room.board.length === 3) {
      burn(room); room.board.push(room.deck.pop()); room.stage = "turn";
    } else if (room.board.length === 4) {
      burn(room); room.board.push(room.deck.pop()); room.stage = "river";
    }
  }
  setTimeout(() => showdown(room), 700);
  emitState(room);
}

function handValue5(cards) {
  const rs = cards.map(c=>c.r).sort((a,b)=>b-a);
  const counts = new Map();
  for (const r of rs) counts.set(r, (counts.get(r)||0)+1);
  const groups = [...counts.entries()].sort((a,b)=> b[1]-a[1] || b[0]-a[0]);
  const flush = cards.every(c => c.s === cards[0].s);
  const unique = [...new Set(rs)];
  if (unique[0] === 14) unique.push(1);
  let straightHigh = 0;
  for (let i=0;i<=unique.length-5;i++) {
    if (unique[i]-unique[i+4]===4) { straightHigh=unique[i]; break; }
  }
  if (straightHigh && flush) return [8, straightHigh];
  if (groups[0][1]===4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1]===3 && groups[1] && groups[1][1]===2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...rs];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][1]===3) {
    const kick = groups.filter(g=>g[1]===1).map(g=>g[0]).sort((a,b)=>b-a);
    return [3, groups[0][0], ...kick];
  }
  const pairs = groups.filter(g=>g[1]===2).map(g=>g[0]).sort((a,b)=>b-a);
  if (pairs.length >= 2) {
    const hi = pairs[0], lo = pairs[1];
    const k = groups.filter(g=>g[1]===1).map(g=>g[0]).sort((a,b)=>b-a)[0] || 0;
    return [2, hi, lo, k];
  }
  if (pairs.length===1) {
    const kick = groups.filter(g=>g[1]===1).map(g=>g[0]).sort((a,b)=>b-a);
    return [1, pairs[0], ...kick];
  }
  return [0, ...rs];
}
function compareValue(a,b) {
  const n = Math.max(a.length,b.length);
  for (let i=0;i<n;i++) {
    const d = (a[i]||0) - (b[i]||0);
    if (d) return d;
  }
  return 0;
}
function combinations5(cards) {
  const out=[];
  for(let a=0;a<cards.length-4;a++)
  for(let b=a+1;b<cards.length-3;b++)
  for(let c=b+1;c<cards.length-2;c++)
  for(let d=c+1;d<cards.length-1;d++)
  for(let e=d+1;e<cards.length;e++) out.push([cards[a],cards[b],cards[c],cards[d],cards[e]]);
  return out;
}
function best7(cards) {
  let best = null;
  for (const five of combinations5(cards)) {
    const v = handValue5(five);
    if (!best || compareValue(v,best)>0) best=v;
  }
  return best;
}
function handName(v) {
  return ["高牌","一对","两对","三条","顺子","同花","葫芦","四条","同花顺"][v[0]] || "牌型";
}
function awardSidePots(room) {
  const contrib = room.players.filter(p=>p.totalBet>0);
  const levels = [...new Set(contrib.map(p=>p.totalBet))].sort((a,b)=>a-b);
  let prev=0;
  const awards = new Map();
  for (const level of levels) {
    const members = contrib.filter(p=>p.totalBet>=level);
    const potSize = (level-prev) * members.length;
    prev = level;
    if (potSize<=0) continue;
    const eligible = members.filter(p=>p.inHand && !p.folded);
    if (!eligible.length) continue;
    let winners = eligible;
    if (eligible.length > 1) {
      let best = null;
      winners = [];
      for (const p of eligible) {
        const v = best7([...p.hole, ...room.board]);
        p.handValue = v;
        if (!best || compareValue(v,best)>0) { best=v; winners=[p]; }
        else if (compareValue(v,best)===0) winners.push(p);
      }
    }
    const share = Math.floor(potSize / winners.length);
    let rem = potSize - share*winners.length;
    const worder = ordered(winners);
    for (const w of worder) {
      const add = share + (rem>0 ? 1 : 0);
      if (rem>0) rem--;
      w.chips += add;
      awards.set(w.id, (awards.get(w.id)||0)+add);
    }
  }
  return awards;
}
function showdown(room) {
  clearTurnTimer(room);
  room.stage = "showdown";
  room.handActive = false;
  room.turnId = null;
  room.pending.clear();
  room.raiseRights.clear();
  const live = contenders(room);
  for (const p of live) p.handValue = best7([...p.hole, ...room.board]);
  const awards = awardSidePots(room);
  const parts = [];
  for (const [id, amount] of awards.entries()) {
    const p = getPlayer(room,id);
    parts.push(`${p.name} 赢得 ${amount}（${p.handValue ? handName(p.handValue) : "底池"}）`);
  }
  room.message = parts.join("；") || "本局结束";
  log(room, room.message);
  room.pot = 0;
  emitState(room);
  scheduleNextHand(room);
}
function finishByFold(room) {
  clearTurnTimer(room);
  const winner = contenders(room)[0];
  room.handActive = false;
  room.stage = "showdown";
  room.turnId = null;
  room.pending.clear();
  room.raiseRights.clear();
  if (winner) {
    winner.chips += room.pot;
    room.message = `${winner.name} 赢得底池 ${room.pot}`;
    log(room, room.message);
  }
  room.pot = 0;
  emitState(room);
  scheduleNextHand(room, 3000);
}
function afterAction(room, actorSeat) {
  if (contenders(room).length <= 1) return finishByFold(room);
  cleanBettingSets(room);
  if (room.pending.size === 0) return advanceStreet(room);
  const next = chooseNextPending(room, actorSeat);
  setTurn(room, next);
}
function handleAction(room, p, type, amount = 0, automatic = false) {
  if (!room.handActive || room.turnId !== p.id || !p.inHand || p.folded || p.allIn) return;
  const toCall = Math.max(0, room.currentBet - p.streetBet);
  const oldSeat = p.seat;

  if (type === "fold") {
    p.folded = true;
    room.pending.delete(p.id);
    room.raiseRights.delete(p.id);
    if (!automatic) log(room, `${p.name} 弃牌`);
  } else if (type === "check") {
    if (toCall !== 0) return;
    room.pending.delete(p.id);
    room.raiseRights.delete(p.id);
    if (!automatic) log(room, `${p.name} 过牌`);
  } else if (type === "call") {
    if (toCall <= 0) return;
    const paid = post(room, p, toCall);
    room.pending.delete(p.id);
    room.raiseRights.delete(p.id);
    log(room, `${p.name} 跟注 ${paid}${p.allIn ? "（All-in）" : ""}`);
  } else if (type === "raise") {
    const target = Math.floor(Number(amount) || 0);
    const minTarget = room.currentBet + room.minRaise;
    const maxTarget = p.streetBet + p.chips;
    if (!room.raiseRights.has(p.id) || maxTarget < minTarget) return;
    const finalTarget = Math.min(target, maxTarget);
    if (finalTarget < minTarget) return;
    const oldBet = room.currentBet;
    post(room, p, finalTarget - p.streetBet);
    const newBet = p.streetBet;
    const raiseSize = newBet - oldBet;
    room.minRaise = raiseSize;
    room.currentBet = newBet;
    room.pending = new Set(actionable(room).filter(x=>x.id!==p.id).map(x=>x.id));
    room.raiseRights = new Set(actionable(room).filter(x=>x.id!==p.id).map(x=>x.id));
    log(room, `${p.name} 加注到 ${newBet}${p.allIn ? "（All-in）" : ""}`);
  } else if (type === "allin") {
    const oldBet = room.currentBet;
    const paid = post(room, p, p.chips);
    room.pending.delete(p.id);
    room.raiseRights.delete(p.id);
    if (p.streetBet > oldBet) {
      const raiseSize = p.streetBet - oldBet;
      room.currentBet = p.streetBet;
      if (raiseSize >= room.minRaise) {
        room.minRaise = raiseSize;
        room.pending = new Set(actionable(room).filter(x=>x.id!==p.id).map(x=>x.id));
        room.raiseRights = new Set(actionable(room).filter(x=>x.id!==p.id).map(x=>x.id));
      } else {
        // A short all-in does not reopen raising for players who already
        // acted, but every player below the new price must still call or fold.
        requireResponsesToBet(room, p.id);
      }
    }
    log(room, `${p.name} All-in ${paid}`);
  } else {
    return;
  }
  afterAction(room, oldSeat);
}

function createRoom(code) {
  return {
    code,
    players: [],
    handActive: false,
    stage: "waiting",
    handNumber: 0,
    dealerSeat: 0,
    sbId: null,
    bbId: null,
    deck: [],
    board: [],
    pot: 0,
    currentBet: 0,
    minRaise: BIG_BLIND,
    pending: new Set(),
    raiseRights: new Set(),
    turnId: null,
    turnTimer: null,
    actionDeadline: null,
    nextHandTimer: null,
    cleanupTimer: null,
    log: [],
    message: "等待至少 2 名玩家加入"
  };
}

io.on("connection", socket => {
  socket.on("join", ({room, name}) => {
    const code = cleanText(room, 12) || randomRoom();
    const nick = cleanText(name, 16) || "Player";
    socket.data.room = code;

    if (!rooms.has(code)) rooms.set(code, createRoom(code));
    const r = rooms.get(code);
    if (r.cleanupTimer) {
      clearTimeout(r.cleanupTimer);
      r.cleanupTimer = null;
    }

    // A queued join followed by Socket.IO's connect callback can deliver the
    // same join twice. Keep the event idempotent so one browser gets one seat.
    const existing = getPlayer(r, socket.id);
    if (existing) {
      existing.connected = true;
      emitState(r);
      return;
    }

    // Rejoin by a same-name disconnected seat if possible.
    let p = r.players.find(x => !x.connected && x.name === nick);
    if (p) {
      p.id = socket.id;
      p.connected = true;
      log(r, `${nick} 重新连接`);
    } else {
      p = {
        id: socket.id, name: nick, seat: nextSeat(r), chips: STARTING_CHIPS,
        connected: true, sittingOut: false, inHand: false, folded: false,
        allIn: false, streetBet: 0, totalBet: 0, hole: [], handValue: null
      };
      r.players.push(p);
      log(r, `${nick} 加入房间`);
    }
    socket.join(code);
    emitState(r);

    if (!r.handActive && playablePlayers(r).length >= 2) {
      clearNextHandTimer(r);
      r.nextHandTimer = setTimeout(() => startHand(r), 1200);
    }
  });

  socket.on("action", ({type, amount}) => {
    const r = roomOf(socket);
    if (!r) return;
    const p = getPlayer(r, socket.id);
    if (!p) return;
    handleAction(r, p, type, amount);
  });

  socket.on("toggleSitOut", () => {
    const r = roomOf(socket);
    if (!r) return;
    const p = getPlayer(r, socket.id);
    if (!p) return;
    p.sittingOut = !p.sittingOut;
    if (p.sittingOut && p.inHand && !p.folded) {
      p.folded = true;
      r.pending.delete(p.id);
      if (r.turnId === p.id) afterAction(r, p.seat);
    }
    log(r, `${p.name} ${p.sittingOut ? "暂停游戏" : "回到牌桌"}`);
    emitState(r);
    if (!r.handActive && playablePlayers(r).length >= 2) startHand(r);
  });

  socket.on("startNow", () => {
    const r = roomOf(socket);
    if (r && !r.handActive) startHand(r);
  });

  socket.on("disconnect", () => {
    const code = socket.data.room;
    const r = rooms.get(code);
    if (!r) return;
    const p = getPlayer(r, socket.id);
    if (!p) return;
    p.connected = false;
    log(r, `${p.name} 断开连接`);
    if (r.handActive && p.inHand && !p.folded) {
      p.folded = true;
      r.pending.delete(p.id);
      if (r.turnId === p.id) afterAction(r, p.seat);
      else if (contenders(r).length <= 1) finishByFold(r);
      else emitState(r);
    } else {
      emitState(r);
    }
    if (!r.players.some(x=>x.connected)) {
      clearTurnTimer(r);
      clearNextHandTimer(r);
      if (r.cleanupTimer) clearTimeout(r.cleanupTimer);
      r.cleanupTimer = setTimeout(() => {
        const rr = rooms.get(code);
        if (rr && !rr.players.some(x=>x.connected)) rooms.delete(code);
      }, 10 * 60 * 1000);
      r.cleanupTimer.unref?.();
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Friends Poker V2 running on ${PORT}`));
}

module.exports = {
  server,
  io,
  createRoom,
  startHand,
  handleAction,
  legalActions,
  clearTurnTimer,
  clearNextHandTimer,
  handValue5,
  best7,
  compareValue,
  awardSidePots
};
