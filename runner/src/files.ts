import { t as tx } from "./i18n.js";
import {
  realpathSync,
  readdirSync,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  fstatSync,
  readSync,
  constants,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { resolve, sep, dirname, join, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { RunnerConfig } from "./config.js";
import type { Approval, FolderLink, IncomingFile } from "../../office/shared/runtime.js";
export const sha = (b: Uint8Array) =>
  createHash("sha256").update(b).digest("hex");
export const within = (root: string, path: string) =>
  path === root || path.startsWith(root + sep);
export function validateFolder(path: string, c: RunnerConfig): string {
  if (!isAbsolute(path) || /[\x00-\x1f]/.test(path))
    throw new Error(tx("Klasör yolu mutlak olmalı."));
  const normalized = resolve(path),
    real = realpathSync(path);
  const forbidden = [
    "/etc",
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/boot",
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/var",
    "/root",
    ...c.protectedRoots,
    c.workDir,
  ];
  const protectedPaths = forbidden.map(path => {
    let canonical = resolve(path);
    try { canonical = realpathSync(path); } catch { /* Missing protected roots still reserve their configured path. */ }
    return {path, canonical};
  });
  const prohibited = (p: string) =>
    p === "/" ||
    p === homedir() ||
    /^\/home\/[^/]+$/.test(p) ||
    p
      .split(sep)
      .some((s) =>
        [
          ".ssh",
          ".config",
          ".claude",
          ".codex",
          ".aws",
          ".env",
          ".agents",
        ].includes(s),
      ) ||
    protectedPaths.some(({path:r,canonical}) => {
      // The test Office may expose only its separate data root, never application code.
      if(c.smoke && c.url==='http://127.0.0.1:9401' && c.smokeRoot && c.protectedRoots[0]===r && realpathSync(c.smokeRoot)===resolve(c.smokeRoot) && within(resolve(r),c.smokeRoot) && within(c.smokeRoot,p))return false;
      return within(resolve(r), p) || within(p, resolve(r)) || within(canonical,p) || within(p,canonical);
    });
  if (
    prohibited(normalized) ||
    prohibited(real) ||
    !c.allowedRoots.some((root) => within(realpathSync(root), real))
  )
    throw new Error(tx("Bu klasör izinli köklerde değil veya korunan bir alan."));
  if (!lstatSync(real).isDirectory()) throw new Error(tx("Yol bir klasör değil."));
  const pending = [real];
  let entries = 0;
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++entries > 50000)
        throw new Error(tx("Klasör çok büyük; daha dar bir bağlantı seçin."));
      const nested = join(dir, entry.name);
      if (prohibited(nested) || entry.name.startsWith(".env"))
        throw new Error(tx("Klasör özel ayar veya gizli dosya içeriyor."));
      if (entry.isSymbolicLink()) {
        const target = realpathSync(nested);
        if (!within(real, target) || prohibited(target))
          throw new Error(tx("Klasör dışına çıkan bir bağlantı var."));
      } else if (entry.isDirectory()) pending.push(nested);
      else if (!entry.isFile() || lstatSync(nested).nlink !== 1)
        throw new Error(tx("Bağlantı veya özel dosya kullanılamaz."));
    }
  }
  return real;
}
export function relativePath(path: string) {
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    /[\x00-\x1f]/.test(path) ||
    path
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p.startsWith("."))
  )
    throw new Error(tx("Göreli dosya yolu geçersiz."));
  return path;
}
export function safePath(root: string, path: string, missing = false): string {
  relativePath(path);
  const realRoot = realpathSync(root),
    target = join(realRoot, path);
  const pieces = path.split("/");
  let current = realRoot;
  for (let i = 0; i < pieces.length; i++) {
    current = join(current, pieces[i]);
    try {
      const st = lstatSync(current);
      if (
        st.isSymbolicLink() ||
        (i < pieces.length - 1 && !st.isDirectory()) ||
        (i === pieces.length - 1 && !st.isFile())
      )
        throw new Error(tx("Bağlantı veya özel dosya kullanılamaz."));
    } catch (e) {
      if (missing && (e as NodeJS.ErrnoException).code === "ENOENT")
        return target;
      throw e;
    }
  }
  if (!within(realRoot, realpathSync(target)))
    throw new Error(tx("Dosya klasör dışına çıkıyor."));
  return target;
}
export function readSafe(root: string, path: string): Buffer {
  relativePath(path);
  // Pin each directory inode. O_NOFOLLOW on only the final file would still
  // follow a parent replaced with a symlink between validation and open.
  let directory = openSync(realpathSync(root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let fd: number;
  try {
    const pieces = path.split("/");
    for (const piece of pieces.slice(0, -1)) {
      const next = openSync(`/proc/self/fd/${directory}/${piece}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(directory);
      directory = next;
    }
    fd = openSync(`/proc/self/fd/${directory}/${pieces.at(-1)!}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } finally { closeSync(directory); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error(tx("Bağlantı veya özel dosya kullanılamaz."));
    if (stat.size > 1000000)
      throw new Error(tx("Dosya en çok 1 MB olabilir."));
    const buffer = Buffer.alloc(1000001);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.length > 1000000) throw new Error(tx("Dosya en çok 1 MB olabilir."));
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function proposal(work: string, link: FolderLink, paths: string[]) {
  return paths.map((path) => {
    const bytes = readSafe(work, path);
    let before: Buffer | null = null;
    try {
      before = readSafe(link.path, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return {
      path,
      content: bytes.toString("base64"),
      before_content: before ? before.toString("base64") : null,
      before_hash: before ? sha(before) : null,
      after_hash: sha(bytes),
      diff: tx("{0}\nÖnce: {1} bayt ({2})\nSonra: {3} bayt ({4})\n--- Önce\n{5}\n+++ Sonra\n{6}", [path, before?.length || 0, before ? sha(before) : "yeni dosya", bytes.length, sha(bytes), before?.toString("utf8").slice(0, 5000) || "", bytes.toString("utf8").slice(0, 5000)]),
    };
  });
}
export function applyApproval(a: Approval, link: FolderLink, c: RunnerConfig) {
  if (
    link.id !== a.link_id ||
    link.access !== "write" ||
    !link.approved_write ||
    !link.agent_ids.includes(a.agent_id) ||
    a.state !== "applying"
  )
    throw new Error(tx("Klasör yazma onayı geçersiz."));
  const root = validateFolder(link.path, c);
  const planned = a.files.map((f) => {
    const bytes = Buffer.from(f.content, "base64");
    if (bytes.length > 1000000 || sha(bytes) !== f.after_hash)
      throw new Error(tx("Onaylanan içerik değişmiş."));
    const target = safePath(root, f.path, true);
    let current: Buffer | null = null;
    try {
      current = readSafe(root, f.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if ((current ? sha(current) : null) !== f.before_hash)
      throw new Error(
        tx("Hedef dosya onaydan sonra değişmiş. Yeni onay gerekiyor."),
      );
    return { f, target, bytes };
  });
  // No active agent can mount this root writable: callers serialize all copies with running jobs.
  for (const p of planned) {
    mkdirSync(dirname(p.target), { recursive: true, mode: 0o700 });
    safePath(root, p.f.path, true);
    const tmp = join(dirname(p.target), `.ofis-${randomUUID()}`);
    try {
      writeFileSync(tmp, p.bytes, { flag: "wx", mode: 0o600 });
      safePath(root, p.f.path, true);
      renameSync(tmp, p.target);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* already renamed */
      }
    }
  }
  return tx("{0} dosya onaylanan içerikle kopyalandı.", [planned.length]);
}

export function receiveFile(work: string, file: IncomingFile, content: string) {
  relativePath(file.path);
  if (!file.path.startsWith("gelen/")) throw new Error(tx("Gelen dosya yolu geçersiz."));
  const bytes = Buffer.from(content, "base64");
  if (bytes.length !== file.size || bytes.length > 1000000 || sha(bytes) !== file.hash) throw new Error(tx("Gelen dosyanın özeti uyuşmuyor."));
  let path = work;
  const pieces = file.path.split("/");
  for (const piece of pieces.slice(0, -1)) {
    path = join(path, piece);
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) throw new Error(tx("Gelen dosya klasörü güvenli değil."));
    if (!existsSync(path)) mkdirSync(path, { recursive: false, mode: 0o700 });
  }
  const target = join(path, pieces.at(-1)!);
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(tx("Gelen dosya güvenli değil."));
    if (sha(readSafe(work, file.path)) === file.hash) { chmodSync(target, 0o400); return; }
    unlinkSync(target);
  }
  writeFileSync(target, bytes, { flag: "wx", mode: 0o400 });
}
// Names only: no file contents, secrets or symlink targets are sent to the office.
export function documentPaths(path:string,c:RunnerConfig){
  const root=validateFolder(path,c),documents:string[]=[];let visited=0,truncated=false;
  const walk=(directory:string,prefix='')=>{
    if(++visited>500 || documents.length>=1000){truncated=true;return;}
    const safe=realpathSync(directory);if(safe!==root && !safe.startsWith(root+sep))return;
    for(const entry of readdirSync(safe,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(entry.isSymbolicLink() || entry.name.startsWith('.') || ['node_modules','dist','build','coverage'].includes(entry.name))continue;
      const relative=prefix+entry.name;if(relative.length>500){truncated=true;continue;}
      if(entry.isDirectory()){try{walk(join(safe,entry.name),relative+'/');}catch{/* Unreadable/protected subdirectory cannot be a resource. */}}
      else if(entry.isFile())documents.push(relative);
      if(documents.length>=1000){truncated=true;break;}
    }
  };walk(root);return {documents,documents_truncated:truncated};
}
