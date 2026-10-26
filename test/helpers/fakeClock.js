// -----------------------------------------------------------------------------
// Fake timers on a virtual clock: nothing fires by itself; `advance(ms)` moves
// the clock and runs every timer due on the way, in order. A callback is not
// awaited to its end (it may wait for a later timer: a request that hangs
// until its timeout): the work in flight (promises, setImmediate) is let run
// to its end before the clock jumps, as a real clock would not move between
// two of those steps.
// -----------------------------------------------------------------------------

const quiet = async () => {
  for (let k = 0; k < 40; k += 1) await new Promise((resolve) => setImmediate(resolve));
};

export function createFakeClock(start) {
  const clock = { now: start };
  let nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  async function advance(ms) {
    const target = clock.now + ms;
    for (let i = 0; i < 100_000; i += 1) {
      await quiet();
      let next;
      for (const [id, timer] of pending) {
        if (timer.at <= target && (!next || timer.at < next.timer.at)) {
          next = { id, timer };
        }
      }
      if (!next) {
        break;
      }
      pending.delete(next.id);
      clock.now = Math.max(clock.now, next.timer.at);
      Promise.resolve()
        .then(() => next.timer.fn())
        .catch(() => {});
    }
    // Never back: a slow answer may have moved the clock beyond the target.
    clock.now = Math.max(clock.now, target);
  }
  return { clock, timers, pending, advance };
}
