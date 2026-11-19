export class AsyncGeneration {
  private value = 0;

  next(): number {
    return ++this.value;
  }

  isCurrent(generation: number): boolean {
    return generation === this.value;
  }
}
