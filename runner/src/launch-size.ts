import { t as tx } from "./i18n.js";
export const MAX_LAUNCH_STRING_BYTES = 120 * 1024;
export const MAX_LAUNCH_TOTAL_BYTES = 1536 * 1024;
export interface LaunchCommand {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  launchWarnings?: string[];
}
const bytes = (text: string) => Buffer.byteLength(text, "utf8") + 1;
function argumentName(value: string, index: number, args: string[]) {
  if (args[index - 1] === "-c") {
    const key = value.match(/^([a-zA-Z_][a-zA-Z0-9_.]*)=/)?.[1];
    if (key) return `ayar (${key})`;
  }
  return tx("komut argümanı {0}", [index + 1]);
}
export function launchSize(command: LaunchCommand) {
  const argumentsList = [
    { part: tx("çalıştırılacak program"), bytes: bytes(command.bin) },
    ...command.args.map((arg, index) => ({ part: argumentName(arg, index, command.args), bytes: bytes(arg) })),
  ];
  const environment = Object.entries(command.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => ({ part: tx("ortam değişkeni ({0})", [key]), bytes: bytes(`${key}=${value}`) }));
  const argumentBytes = argumentsList.reduce((sum, item) => sum + item.bytes, 0);
  const environmentBytes = environment.reduce((sum, item) => sum + item.bytes, 0);
  const pointerBytes = (argumentsList.length + environment.length + 2) * 8;
  const largest = [...argumentsList, ...environment].sort((a, b) => b.bytes - a.bytes)[0];
  return { argumentBytes, environmentBytes, pointerBytes, totalBytes: argumentBytes + environmentBytes + pointerBytes, largest };
}
export class LaunchSizeError extends Error {
  constructor(public part: string, public measuredBytes: number, public limitBytes: number) {
    super(tx("Ajan başlatma verisi çok büyük: {0} ({1} bayt; güvenli sınır {2} bayt).", [part, measuredBytes, limitBytes]));
  }
}
export function assertLaunchSize(command: LaunchCommand) {
  const size = launchSize(command);
  if (size.largest.bytes >= MAX_LAUNCH_STRING_BYTES)
    throw new LaunchSizeError(size.largest.part, size.largest.bytes, MAX_LAUNCH_STRING_BYTES);
  if (size.totalBytes >= MAX_LAUNCH_TOTAL_BYTES)
    throw new LaunchSizeError(tx("toplam argüman ve ortam; en büyük parça: {0}", [size.largest.part]), size.totalBytes, MAX_LAUNCH_TOTAL_BYTES);
  return size;
}
// Retry once only for launch-size errors. The caller must provide safe
// file/stdin transfer instead of blindly truncating permissions or instructions.
export function guardLaunch<T extends LaunchCommand>(command: T, shorten?: (command: T, error: LaunchSizeError) => T): T & LaunchCommand {
  try { assertLaunchSize(command); return command; }
  catch (error) {
    if (!(error instanceof LaunchSizeError) || !shorten) throw error;
    const retry = shorten(command, error);
    assertLaunchSize(retry);
    return { ...retry, launchWarnings: [...(retry.launchWarnings || []), tx("{0} Veri küçültülerek yeniden hazırlandı.", [error.message])] };
  }
}
