import mul, { add as sum } from './util/math';
import { plus, Geo } from './util';
import * as M from './util/math';
import { Shape, Circle, Square, Dog } from './shapes';
import { register, Client, Plugin } from 'fakelib';
import { missing } from 'not-installed';

export function names() {
  sum(1, 2); plus(1, 2); M.sub(3, 1); mul(2, 2); Geo.dist(1);
  track('names');
  missing();
}

export function shapes(s: Shape) {
  const c = new Circle();
  c.area();
  const sq = new Square();
  sq.area();
  s.area();
  new Dog().greet();
}

function make(): Circle { return new Circle(); }

export function types<T extends Shape>(u: Circle | Square, g: T, both: Circle & { name(): string }) {
  make().area();
  let s = make();
  s.area();
  u.area();
  g.area();
  both.area();
}

export function run(f: () => void) { f(); }

export function values() {
  let cb = sum;
  cb(1, 2);
  run(() => mul(1, 2));
  run(names);
  const inc = counter();
  inc();
}

function counter() {
  let n = 0;
  return () => { n = sum(n, 1); };
}

class Logger implements Plugin { start() { new Client().send('up'); } }

export function libs() {
  register(new Logger());
  [1, 2].map((x) => sum(x, 1));
}

export class Button {
  onClick: () => void;
  constructor(h: () => void) { this.onClick = h; }
  click() { this.onClick(); }
}

export function buttons() { new Button(names).click(); }
