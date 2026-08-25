import { add, multiply } from './arithmetic';

export type Scalar = number;

export interface PointLike {
  x: number;
  y: number;
}

export class Vector2 implements PointLike {
  constructor(
    public x: number,
    public y: number,
  ) {}

  plus(other: PointLike): Vector2 {
    return new Vector2(add(this.x, other.x), add(this.y, other.y));
  }

  scale(factor: Scalar): Vector2 {
    return new Vector2(multiply(this.x, factor), multiply(this.y, factor));
  }

  length(): number {
    return Math.hypot(this.x, this.y);
  }
}
