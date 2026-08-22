const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRoom,
  startHand,
  handleAction,
  legalActions,
  clearTurnTimer,
  clearNextHandTimer,
  handValue5,
  best7,
  compareValue
} = require("../server");

function player(id, seat, chips = 1000) {
  return {
    id,
    name: id,
    seat,
    chips,
    connected: true,
    sittingOut: false,
    inHand: false,
    folded: false,
    allIn: false,
    streetBet: 0,
    totalBet: 0,
    hole: [],
    handValue: null
  };
}

function stop(room) {
  clearTurnTimer(room);
  clearNextHandTimer(room);
}

function card(r, s) {
  return { r, s };
}

test("recognizes a wheel straight and a royal flush", () => {
  const wheel = handValue5([
    card(14, "S"), card(2, "H"), card(3, "D"), card(4, "C"), card(5, "S")
  ]);
  const royal = handValue5([
    card(10, "H"), card(11, "H"), card(12, "H"), card(13, "H"), card(14, "H")
  ]);

  assert.deepEqual(wheel, [4, 5]);
  assert.deepEqual(royal, [8, 14]);
  assert.ok(compareValue(royal, wheel) > 0);
});

test("best of seven cards chooses the strongest five-card hand", () => {
  const value = best7([
    card(14, "S"), card(14, "H"), card(14, "D"),
    card(13, "S"), card(13, "H"), card(2, "C"), card(3, "C")
  ]);
  assert.deepEqual(value, [6, 14, 13]);
});

test("heads-up all-in waits for the opponent to call or fold", () => {
  const room = createRoom("allin-response");
  room.players.push(player("A", 1), player("B", 2));
  startHand(room);

  const actor = room.players.find(p => p.id === room.turnId);
  const opponent = room.players.find(p => p.id !== actor.id);
  handleAction(room, actor, "allin");

  assert.equal(room.handActive, true);
  assert.equal(room.board.length, 0);
  assert.equal(room.turnId, opponent.id);
  assert.equal(legalActions(room, opponent).call, true);
  assert.equal(legalActions(room, opponent).callAmount, 900);
  stop(room);
});

test("a short all-in requires responses without reopening a prior actor's raise", () => {
  const room = createRoom("short-allin");
  const a = player("A", 1, 900);
  const b = player("B", 2, 40);
  const c = player("C", 3, 900);
  room.players.push(a, b, c);
  for (const p of room.players) {
    p.inHand = true;
    p.streetBet = 100;
    p.totalBet = 100;
  }
  room.handActive = true;
  room.stage = "flop";
  room.currentBet = 100;
  room.minRaise = 100;
  room.pot = 300;
  room.turnId = b.id;
  room.pending = new Set([b.id, c.id]);
  room.raiseRights = new Set([b.id, c.id]);

  handleAction(room, b, "allin");
  assert.equal(room.currentBet, 140);
  assert.equal(room.turnId, c.id);
  assert.deepEqual([...room.pending].sort(), ["A", "C"]);

  handleAction(room, c, "call");
  assert.equal(room.turnId, a.id);
  const legal = legalActions(room, a);
  assert.equal(legal.callAmount, 40);
  assert.equal(legal.raise, false);
  stop(room);
});

test("a full all-in raise reopens raising for the other players", () => {
  const room = createRoom("full-allin");
  const a = player("A", 1, 900);
  const b = player("B", 2, 200);
  const c = player("C", 3, 900);
  room.players.push(a, b, c);
  for (const p of room.players) {
    p.inHand = true;
    p.streetBet = 100;
    p.totalBet = 100;
  }
  room.handActive = true;
  room.stage = "turn";
  room.currentBet = 100;
  room.minRaise = 100;
  room.pot = 300;
  room.turnId = b.id;
  room.pending = new Set([b.id, c.id]);
  room.raiseRights = new Set([b.id, c.id]);

  handleAction(room, b, "allin");
  assert.equal(room.currentBet, 300);
  assert.deepEqual([...room.pending].sort(), ["A", "C"]);
  assert.deepEqual([...room.raiseRights].sort(), ["A", "C"]);
  assert.equal(legalActions(room, c).raise, true);
  stop(room);
});

test("starting a hand twice cannot deal a duplicate hand", () => {
  const room = createRoom("single-start");
  room.players.push(player("A", 1), player("B", 2));
  assert.equal(startHand(room), true);
  const handNumber = room.handNumber;
  assert.equal(startHand(room), false);
  assert.equal(room.handNumber, handNumber);
  stop(room);
});
