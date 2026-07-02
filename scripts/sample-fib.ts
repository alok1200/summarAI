// Sample Fibonacci sequence generator in TypeScript
export function fibonacci(n: number): number[] {
  const sequence: number[] = [0, 1];
  for (let i = 2; i < n; i++) {
    sequence.push(sequence[i - 1] + sequence[i - 2]);
  }
  return sequence.slice(0, n);
}

// Example usage:
console.log(fibonacci(10));
// Output: [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
