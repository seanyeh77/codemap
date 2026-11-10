import { Counter, format } from './util'

const counter = new Counter()

export function go(): void {
  const n = counter.bump()
  show(format(n))
}

const show = (text: string) => {
  console.log(text)
}
