export function format(n: number): string {
  return String(n)
}

export class Counter {
  count = 0
  bump(): number {
    this.count += 1
    return this.count
  }
}
