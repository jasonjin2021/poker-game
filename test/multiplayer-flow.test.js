const test = require("node:test");
const assert = require("node:assert/strict");
const { io: connect } = require("socket.io-client");
const { server, io } = require("../server");

function tracker(url, room, name) {
  const client = connect(url, { transports: ["websocket"], forceNew: true });
  let latest = null;
  const waiters = new Set();

  client.on("state", state => {
    latest = state;
    for (const waiter of [...waiters]) {
      if (waiter.predicate(state)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(state);
      }
    }
  });

  function waitFor(predicate, timeout = 3000) {
    if (latest && predicate(latest)) return Promise.resolve(latest);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out waiting for state for ${name}`));
      }, timeout);
      waiters.add(waiter);
    });
  }

  client.on("connect", () => client.emit("join", { room, name }));
  function dispose() {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(latest);
    }
    waiters.clear();
    client.close();
  }

  return { client, waitFor, dispose, get latest() { return latest; } };
}

function signature(state) {
  return [
    state.handNumber,
    state.stage,
    state.turnId,
    state.pot,
    state.currentBet,
    state.log[0]
  ].join("|");
}

test("two clients can play through flop, turn raise, river raise, and showdown", async t => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  const room = `flow-${Date.now()}`;
  const a = tracker(url, room, "Alice");
  const b = tracker(url, room, "Bob");

  t.after(async () => {
    a.dispose();
    b.dispose();
    await new Promise(resolve => io.close(resolve));
  });

  await Promise.all([
    a.waitFor(s => s.stage === "preflop"),
    b.waitFor(s => s.stage === "preflop")
  ]);

  const handNumber = a.latest.handNumber;
  const players = new Map([
    [a.latest.me, a],
    [b.latest.me, b]
  ]);
  const raised = { turn: false, river: false };

  for (let actionCount = 0; actionCount < 20; actionCount++) {
    const state = a.latest;
    if (state.handNumber !== handNumber || state.stage === "showdown") break;

    const actor = players.get(state.turnId);
    assert.ok(actor, `missing client for turn ${state.turnId}`);
    const actorState = await actor.waitFor(s =>
      s.handNumber === handNumber &&
      s.stage === state.stage &&
      s.turnId === state.turnId &&
      s.legal && s.legal.fold
    );
    const legal = actorState.legal;
    const oldSignature = signature(a.latest);
    const changed = a.waitFor(s => signature(s) !== oldSignature);

    if ((state.stage === "turn" || state.stage === "river") &&
        !raised[state.stage] && legal.raise) {
      actor.client.emit("action", { type: "raise", amount: legal.minRaiseTo });
      raised[state.stage] = true;
    } else if (legal.call) {
      actor.client.emit("action", { type: "call" });
    } else {
      assert.equal(legal.check, true);
      actor.client.emit("action", { type: "check" });
    }
    await changed;
  }

  const result = await a.waitFor(s => s.handNumber === handNumber && s.stage === "showdown");
  assert.equal(result.board.length, 5);
  assert.equal(result.pot, 0);
  assert.equal(raised.turn, true);
  assert.equal(raised.river, true);
  assert.match(result.message, /赢得/);
  assert.equal(result.players.reduce((sum, p) => sum + p.chips, 0), 20000);
});
