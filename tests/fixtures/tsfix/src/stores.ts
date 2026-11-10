export interface Store { get(k: string): string }
export class MemStore implements Store { get(k: string) { return k; } }
export class FileStore implements Store { get(k: string) { return k + '!'; } }
export interface Handler { handle(): void }
export function use(s: Store) { return s.get('a'); }
export function narrowed() { const st: Store = new MemStore(); return st.get('b'); }
export function dispatch(h: Handler) { h.handle(); }
