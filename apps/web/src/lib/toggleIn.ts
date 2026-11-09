/** A copy of `list` with `value` added or removed (for checkbox groups bound to an array). */
export function toggleIn<T>(list: readonly T[], value: T, on = !list.includes(value)): T[] {
  return on ? (list.includes(value) ? [...list] : [...list, value]) : list.filter((v) => v !== value);
}
