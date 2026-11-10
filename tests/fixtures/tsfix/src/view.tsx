import { forwardRef } from 'react';
import { add } from './util/math';

const Fancy = forwardRef((props: any, ref: any) => <b>{add(1, 1)}</b>);

function Badge({ onPress }: { onPress: () => void }) {
  onPress();
  return <span onClick={onPress} />;
}

export function Page() {
  const save = () => add(1, 2);
  return <div><Badge onPress={save} /><Fancy /></div>;
}
