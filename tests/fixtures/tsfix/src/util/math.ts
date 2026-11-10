export function add(a: number, b: number): number { return a + b; }
export default function mul(a: number, b: number): number { return a * b; }
export const sub = (a: number, b: number): number => a - b;
export namespace Geo {
  export function dist(x: number): number { return add(x, x); }
}
