export function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'];

export function bytes(n: number): string {
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return (v < 10 ? v.toFixed(2) : v.toFixed(1)) + ' ' + UNITS[i];
}
