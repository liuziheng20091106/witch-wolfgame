export interface RandomResult {
  value: number;
  state: number;
}

export function nextRandom(state: number): RandomResult {
  const nextState = (state + 0x6d2b79f5) >>> 0;
  let value = nextState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return {
    value: ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296,
    state: nextState,
  };
}

export function shuffleWithState<T>(items: readonly T[], initialState: number): { items: T[]; state: number } {
  const shuffled = [...items];
  let state = initialState >>> 0;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const result = nextRandom(state);
    state = result.state;
    const swapIndex = Math.floor(result.value * (index + 1));
    const current = shuffled[index];
    const swap = shuffled[swapIndex];
    if (current === undefined || swap === undefined) {
      throw new Error('随机排列索引越界');
    }
    shuffled[index] = swap;
    shuffled[swapIndex] = current;
  }
  return { items: shuffled, state };
}

export function chooseWithState<T>(items: readonly T[], initialState: number): { item: T; state: number } {
  if (items.length === 0) {
    throw new Error('无法从空候选中选择');
  }
  const result = nextRandom(initialState);
  const item = items[Math.floor(result.value * items.length)];
  if (item === undefined) {
    throw new Error('随机候选索引越界');
  }
  return { item, state: result.state };
}
