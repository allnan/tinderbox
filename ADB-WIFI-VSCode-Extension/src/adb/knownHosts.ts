import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";

/**
 * ADB 自身的配对记录（%USERPROFILE%\.android\adb_known_hosts.pb）。
 *
 * 文件是 protobuf 二进制：顶层 message 的 1 号字段（repeated, wire type 2）是
 * KnownHost，KnownHost 的 1 号字段是 guid 字符串。这里只做只读解析与按 guid 删除，
 * 不重新编码其它字段，避免破坏 ADB 写入的其它信息。
 */

export interface KnownHostsFileResult {
  ok: boolean;
  guids: string[];
  path: string;
  source: string;
  error?: string;
}

export function knownHostsPath(): string {
  const home = process.env.ANDROID_USER_HOME && process.env.ANDROID_USER_HOME.trim().length > 0
    ? process.env.ANDROID_USER_HOME
    : os.homedir();
  return path.join(home, ".android", "adb_known_hosts.pb");
}

/** 读取文件中的全部配对 GUID；格式不可信时返回 null。 */
export function readKnownHostGuids(data: Buffer): string[] | null {
  const guids: string[] = [];
  let offset = 0;
  const limit = data.length;
  while (offset < limit) {
    const key = readVarint(data, offset, limit);
    if (key === null) return null;
    offset = key.offset;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (field === 0 || field > 0x7fffffff) return null;
    if (field === 1 && wire === 2) {
      const length = readVarint(data, offset, limit);
      if (length === null) return null;
      offset = length.offset;
      const end = offset + length.value;
      if (end > limit) return null;
      const guid = readHostGuid(data, offset, end);
      if (guid === null) return null;
      if (guid.length > 0) guids.push(guid);
      offset = end;
    } else {
      const skipped = skipField(data, offset, limit, field, wire);
      if (skipped === null) return null;
      offset = skipped;
    }
  }
  return guids;
}

/** 从 protobuf 数据中删除指定 guid 的配对记录，保留其它字节原样。 */
export function removeKnownHostRecords(data: Buffer, guid: string): { updated: Buffer; removed: number } | null {
  const chunks: Buffer[] = [];
  let removed = 0;
  let offset = 0;
  const limit = data.length;
  while (offset < limit) {
    const start = offset;
    const key = readVarint(data, offset, limit);
    if (key === null) return null;
    offset = key.offset;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (field === 0 || field > 0x7fffffff) return null;
    let match = false;
    if (field === 1 && wire === 2) {
      const length = readVarint(data, offset, limit);
      if (length === null) return null;
      offset = length.offset;
      const end = offset + length.value;
      if (end > limit) return null;
      const storedGuid = readHostGuid(data, offset, end);
      if (storedGuid === null) return null;
      match = storedGuid.toLowerCase() === guid.toLowerCase();
      offset = end;
    } else {
      const skipped = skipField(data, offset, limit, field, wire);
      if (skipped === null) return null;
      offset = skipped;
    }
    if (match) removed += 1;
    else chunks.push(data.subarray(start, offset));
  }
  return { updated: Buffer.concat(chunks), removed };
}

export function readKnownHostsFile(file: string = knownHostsPath()): KnownHostsFileResult {
  try {
    if (!fs.existsSync(file)) {
      return { ok: true, guids: [], path: file, source: "未找到配对记录文件（尚未配对过设备）" };
    }
    const guids = readKnownHostGuids(fs.readFileSync(file));
    if (guids === null) {
      return { ok: false, guids: [], path: file, source: file, error: "ADB 配对记录文件无法安全解析。" };
    }
    return { ok: true, guids, path: file, source: file };
  } catch (error) {
    return { ok: false, guids: [], path: file, source: file, error: "读取 ADB 配对记录文件失败。" + describeError(error) };
  }
}

export interface RemoveKnownHostResult {
  ok: boolean;
  removed: number;
  error?: string;
}

/**
 * 按 guid 删除 ADB 配对记录。先写同目录临时文件并 fsync，确认原文件未被其它
 * ADB 服务改写后再原子替换；任何异常都不会留下临时文件。
 */
export function removeKnownHostRecord(guid: string, file: string = knownHostsPath()): RemoveKnownHostResult {
  if (typeof guid !== "string" || guid.trim().length === 0) {
    return { ok: false, removed: 0, error: "没有取得设备的 ADB 配对标识。" };
  }
  if (!fs.existsSync(file)) {
    return { ok: false, removed: 0, error: "未找到 ADB 的配对记录文件。" };
  }

  let original: Buffer;
  let updated: Buffer;
  let removed: number;
  try {
    original = fs.readFileSync(file);
    const result = removeKnownHostRecords(original, guid);
    if (result === null) {
      return { ok: false, removed: 0, error: "ADB 配对记录格式无法安全解析，文件未修改。" };
    }
    updated = result.updated;
    removed = result.removed;
  } catch (error) {
    return { ok: false, removed: 0, error: "读取 ADB 配对记录失败。" + describeError(error) };
  }
  if (removed === 0) {
    return { ok: false, removed: 0, error: "ADB 配对记录中没有找到这台设备。" };
  }

  const directory = path.dirname(file);
  const temp = path.join(directory, ".adb-known-hosts-" + randomBytes(16).toString("hex") + ".tmp");
  try {
    writeFileSynced(temp, updated);
    const current = fs.readFileSync(file);
    if (!original.equals(current)) {
      return { ok: false, removed: 0, error: "ADB 配对记录在操作期间发生变化，未覆盖新记录。请刷新后重试。" };
    }
    fs.renameSync(temp, file);
    return { ok: true, removed };
  } catch (error) {
    return { ok: false, removed: 0, error: "更新 ADB 配对记录失败。" + describeError(error) };
  } finally {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {
      // 清理失败不影响结果
    }
  }
}

function writeFileSynced(file: string, data: Buffer): void {
  const handle = fs.openSync(file, "wx");
  try {
    fs.writeSync(handle, data, 0, data.length, 0);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

interface VarintResult {
  value: number;
  offset: number;
}

function readVarint(data: Buffer, offset: number, limit: number): VarintResult | null {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (; shift < 70; shift += 7) {
    if (cursor >= limit) return null;
    const next = data[cursor];
    cursor += 1;
    if (shift === 63 && (next & 0xfe) !== 0) return null;
    value += (next & 0x7f) * Math.pow(2, shift);
    if ((next & 0x80) === 0) return { value, offset: cursor };
  }
  return null;
}

function readHostGuid(data: Buffer, start: number, end: number): string | null {
  let offset = start;
  let guid = "";
  while (offset < end) {
    const key = readVarint(data, offset, end);
    if (key === null) return null;
    offset = key.offset;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (field === 0 || field > 0x7fffffff) return null;
    if (field === 1 && wire === 2) {
      const length = readVarint(data, offset, end);
      if (length === null) return null;
      offset = length.offset;
      if (offset + length.value > end) return null;
      try {
        guid = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(offset, offset + length.value));
      } catch {
        return null;
      }
      offset += length.value;
    } else {
      const skipped = skipField(data, offset, end, field, wire);
      if (skipped === null) return null;
      offset = skipped;
    }
  }
  return guid;
}

function skipField(data: Buffer, offset: number, limit: number, field: number, wire: number): number | null {
  switch (wire) {
    case 0: {
      const result = readVarint(data, offset, limit);
      return result === null ? null : result.offset;
    }
    case 1:
      return limit - offset < 8 ? null : offset + 8;
    case 2: {
      const length = readVarint(data, offset, limit);
      if (length === null) return null;
      const end = length.offset + length.value;
      return end > limit ? null : end;
    }
    case 3: {
      let cursor = offset;
      while (cursor < limit) {
        const key = readVarint(data, cursor, limit);
        if (key === null) return null;
        cursor = key.offset;
        const nestedField = Math.floor(key.value / 8);
        const nestedWire = key.value % 8;
        if (nestedField === 0) return null;
        if (nestedWire === 4) return nestedField === field ? cursor : null;
        const skipped = skipField(data, cursor, limit, nestedField, nestedWire);
        if (skipped === null) return null;
        cursor = skipped;
      }
      return null;
    }
    case 5:
      return limit - offset < 4 ? null : offset + 4;
    default:
      return null;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
