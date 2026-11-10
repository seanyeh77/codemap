export class Shape {
  constructor() {}
  area(): number { return 0; }
  describe(): string { return String(this.area()); }
}
export class Circle extends Shape {
  constructor() { super(); }
  area(): number { return super.area() + 1; }
}
export class Square extends Shape {}
export abstract class Animal {
  abstract speak(): string;
  greet() { return this.speak(); }
}
export class Dog extends Animal { speak() { return 'woof'; } }
