import { Store, Handler, use, dispatch } from '../src/stores';
import { Shape } from '../src/shapes';

class FakeStore implements Store { get(k: string) { return 'fake'; } }
class FakeHandler implements Handler { handle() {} }
class TestShape extends Shape { area() { return 42; } }

export function check() {
  use(new FakeStore());
  dispatch(new FakeHandler());
  const s: Store = new FakeStore();
  s.get('x');
}
