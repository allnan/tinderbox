import * as os from "os";
import { normalizeEndpoint } from "./parse";

/**
 * 当前电脑唯一的 /24 局域网前缀（例如 192.168.1.），用于补全地址输入。
 * 与原工具的差异：不校验默认网关，仅在恰好一个 /24 网卡地址时返回。
 */
export function localPrefix(): string | null {
  const prefixes = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.netmask !== "255.255.255.0") continue;
      const parts = entry.address.split(".");
      if (parts.length !== 4) continue;
      prefixes.add(parts.slice(0, 3).join(".") + ".");
    }
  }
  const values = [...prefixes];
  return values.length === 1 ? values[0] : null;
}

/** 取地址的主机部分（IPv6 保留方括号）。 */
export function hostOf(endpoint: string | null | undefined): string | null {
  const normalized = normalizeEndpoint(endpoint);
  if (normalized === null) return null;
  return normalized.slice(0, normalized.lastIndexOf(":"));
}
