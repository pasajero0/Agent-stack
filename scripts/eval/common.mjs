// Small helpers the eval runner modules share. Plain Node ESM, built-ins only.

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const shown = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
export const round2 = (x) => Math.round(x * 100) / 100;
export const pad2 = (n) => String(n).padStart(2, "0");
export const clock = (sec) => `${Math.floor(sec / 60)}:${pad2(sec % 60)}`;
export const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Local time with its offset, whole seconds: 2026-11-24T15:30:00+03:00. */
export function stamp(d) {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return `${localDate(d)}T${time}${off >= 0 ? "+" : "-"}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}
