/** ADB 无线调试的核心数据模型（不依赖 vscode，便于单元测试）。 */

export const PAIRING_TYPE = "_adb-tls-pairing._tcp";
export const CONNECT_TYPE = "_adb-tls-connect._tcp";

/** 一条 adb 连接（对应 adb devices 的一行）。 */
export interface AdbDevice {
  serial: string;
  /** device / offline / unauthorized / no permissions / ... */
  state: string;
  model: string;
  brand?: string;
  manufacturer?: string;
  address?: string;
  addressFromSession: boolean;
  hardwareSerial?: string;
  pairingGuid?: string;
  transportId: number;
}

/** mDNS 发现的 ADB 无线调试服务。 */
export interface AdbService {
  name: string;
  /** 已转小写，例如 _adb-tls-pairing._tcp */
  type: string;
  endpoint: string;
  givenName?: string;
  model?: string;
  hardwareSerial?: string;
}

/** ADB 自身配对记录（adb_known_hosts.pb）中的一条设备。 */
export interface AdbKnownHost {
  guid: string;
  deviceSerial: string;
  endpoint?: string;
  endpointFromSession: boolean;
  deviceName?: string;
  model?: string;
  brand?: string;
  manufacturer?: string;
}

/** 本地持久化的设备资料：断开后仍可显示品牌 / 型号。 */
export interface DeviceProfile {
  hardwareSerial?: string;
  pairingGuid?: string;
  brand?: string;
  model?: string;
  manufacturer?: string;
  updatedAt: number;
}

export interface DeviceProfileStore {
  load(): DeviceProfile[];
  save(profiles: DeviceProfile[]): void;
}

/** 同一部手机的若干连接合并后的设备分组。 */
export interface DeviceGroup {
  key: string;
  connections: AdbDevice[];
}

export interface DeviceUi {
  key: string;
  name: string;
  brand: string;
  model: string;
  manufacturer: string;
  hardwareSerial: string;
  address: string;
  addressTooltip: string;
  state: string;
  connectionSummary: string;
  isHistory: boolean;
  isConnected: boolean;
  canConnect: boolean;
  disconnectable: boolean;
  canUnpair: boolean;
  pairingGuid?: string;
  detailsHeading: string;
  connections: Array<{
    serial: string;
    transport: string;
    label: string;
    state: string;
    displayName: string;
    address: string;
  }>;
}

export type TransportKind = "无线调试" | "IP 直连" | "模拟器" | "USB / 其他";

export function transportOf(device: AdbDevice, normalizeEndpoint: (value: string) => string | null): TransportKind {
  if (device.serial.replace(/\.+$/, "").toLowerCase().endsWith("." + CONNECT_TYPE)) return "无线调试";
  if (normalizeEndpoint(device.serial) !== null) return "IP 直连";
  if (device.serial.startsWith("emulator-")) return "模拟器";
  return "USB / 其他";
}

export function isWireless(device: AdbDevice, normalizeEndpoint: (value: string) => string | null): boolean {
  const transport = transportOf(device, normalizeEndpoint);
  return transport === "无线调试" || transport === "IP 直连";
}

export function isConnected(device: AdbDevice): boolean {
  return device.state === "device";
}

export function connectionLabel(device: AdbDevice, normalizeEndpoint: (value: string) => string | null): string {
  const transport = transportOf(device, normalizeEndpoint);
  if (transport === "无线调试") return "无线调试 · mDNS";
  if (transport === "IP 直连") return "IP 直连";
  return transport;
}

export function displayState(device: AdbDevice): string {
  switch (device.state) {
    case "device": return "已连接";
    case "paired": return device.address === undefined ? "已配对 · 未连接" : "已配对 · 可连接";
    case "disconnected": return "已断开";
    case "offline": return "连接不可用";
    case "connecting": return "连接中";
    case "authorizing": return "授权中";
    case "unauthorized": return "待授权";
    case "no permissions": return "无权限";
    default: return device.state;
  }
}

/** ADB 配对记录转成一条“已配对”设备连接。 */
export function knownHostAsDevice(host: AdbKnownHost): AdbDevice {
  const deviceName = host.deviceName ?? host.model ?? host.deviceSerial;
  return {
    serial: host.guid + "." + CONNECT_TYPE,
    state: "paired",
    model: deviceName,
    brand: host.brand,
    manufacturer: host.manufacturer,
    address: host.endpoint,
    addressFromSession: host.endpointFromSession,
    hardwareSerial: host.deviceSerial,
    pairingGuid: host.guid,
    transportId: 0
  };
}

export function preferredConnection(group: DeviceGroup, normalizeEndpoint: (value: string) => string | null): AdbDevice {
  return [...group.connections].sort((left, right) => {
    const connectedDiff = Number(isConnected(right)) - Number(isConnected(left));
    if (connectedDiff !== 0) return connectedDiff;
    const rank = (device: AdbDevice): number => {
      const transport = transportOf(device, normalizeEndpoint);
      return transport === "无线调试" ? 0 : transport === "IP 直连" ? 1 : 2;
    };
    const rankDiff = rank(left) - rank(right);
    if (rankDiff !== 0) return rankDiff;
    return left.serial < right.serial ? -1 : left.serial > right.serial ? 1 : 0;
  })[0];
}
