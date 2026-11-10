import { add } from './util/math';

function Badge({ onPress }: { onPress: () => void }) {
  onPress();
  return <span onClick={onPress} />;
}

export function Page() {
  const save = () => add(1, 2);
  return <div><Badge onPress={save} /></div>;
}
