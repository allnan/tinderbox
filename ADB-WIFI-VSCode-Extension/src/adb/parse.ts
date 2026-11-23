import { isIPv6 } from "net";
import {
  AdbDevice,
  AdbKnownHost,
  AdbService,
  CONNECT_TYPE,
  DeviceGroup,
  PAIRING_TYPE,
  connectionLabel,
  displayState,
  isConnected,
  knownHostAsDevice,
  preferredConnection,
  transportOf
} from "./models";

/** 规范化 IPv4 / [IPv6]:端口；非法时返回 null。 */
export function normalizeEndpoint(value: string | undefined | null): string | null {
  const text = (value ?? "").trim();
  const match = /^(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9a-fA-F:.]+(?:%[0-9]+)?)\]):(\d{1,5})$/.exec(text);
  if (!match) return null;
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (match[1] !== undefined) {
    const octets = match[1].split(".").map((item) => Number(item));
    if (octets.some((octet) => octet > 255)) return null;
    return octets.join(".") + ":" + String(port);
  }
  const host = match[2];
  const bareHost = host.replace(/%[0-9]+$/, "");
  if (!isIPv6(bareHost)) return null;
  return "[" + host + "]:" + String(port);
}

/** 解析 adb mdns services 的输出。 */
export function parseServices(output: string): AdbService[] {
  const services: AdbService[] = [];
  for (const line of splitLines(output)) {
    const match = /^(\S+)\s+(_adb-tls-(?:pairing|connect)\._tcp)\.?\s+(\S+)/i.exec(line.trim());
    if (!match) continue;
    const endpoint = normalizeEndpoint(match[3]);
    if (endpoint === null) continue;
    services.push({
      name: match[1].replace(/\.+$/, ""),
      type: match[2].toLowerCase(),
      endpoint
    });
  }
  return services;
}

/** 解析 adb devices -l 的输出。 */
export function parseDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  let reading = false;
  for (const line of splitLines(output)) {
    if (line.startsWith("List of devices attached")) {
      reading = true;
      continue;
    }
    if (!reading) continue;
    const match = /^(\S+)\s+(no permissions|\S+)(.*)$/.exec(line.trim());
    if (!match) continue;
    const details = match[3];
    const modelMatch = /\bmodel:(\S+)/.exec(details);
    const transportMatch = /\btransport_id:(\d+)/.exec(details);
    devices.push({
      serial: match[1],
      state: match[2],
      transportId: transportMatch === null ? 0 : Number(transportMatch[1]),
      model: modelMatch === null ? "—" : modelMatch[1].replace(/_/g, " "),
      addressFromSession: false
    });
  }
  return devices;
}

/** 解析 adb mdns track-services --proto-text 输出的一个 service { ... } 块。 */
export function parseTrackedService(block: string): AdbService | null {
  const fields = new Map<string, string>();
  const fieldPattern = /^\s*([a-zA-Z0-9_]+)\s*:\s*"((?:\\.|[^"])*)"\s*$/;
  for (const line of (block ?? "").split(/\r?\n/)) {
    const match = fieldPattern.exec(line);
    if (match !== null) fields.set(match[1].toLowerCase(), unescapeProtoString(match[2]));
  }
  const name = fields.get("instance");
  const type = fields.get("service");
  if (name === undefined || type === undefined) return null;
  const model = pickField(fields, "device_model", "product_model");
  return {
    name,
    type: type.toLowerCase(),
    endpoint: "",
    givenName: pickField(fields, "given_name"),
    model: model === undefined ? undefined : model.replace(/_/g, " "),
    hardwareSerial: pickField(fields, "serial")
  };
}

/** 解析 adb mdns list-known-hosts --proto-text 的 guid 列表。 */
export function parseKnownHostsText(output: string): string[] {
  const guids: string[] = [];
  const pattern = /\bguid\s*:\s*"?([^"\s]+)"?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output ?? "")) !== null) {
    const guid = match[1].replace(/"$/, "");
    if (guid.length > 0) guids.push(guid);
  }
  return guids;
}

/** 由 guid 与当前 mDNS 服务构建配对历史。 */
export function buildKnownHosts(guids: Iterable<string>, services: AdbService[]): AdbKnownHost[] {
  const hosts: AdbKnownHost[] = [];
  for (const rawGuid of guids) {
    const guid = (rawGuid ?? "").trim();
    if (guid.length === 0) continue;
    if (hosts.some((host) => host.guid.toLowerCase() === guid.toLowerCase())) continue;

    let deviceSerial = guid.toLowerCase().startsWith("adb-") ? guid.slice(4) : guid;
    const suffix = deviceSerial.lastIndexOf("-");
    if (suffix > 0 && deviceSerial.length - suffix - 1 === 6 && /^[A-Za-z0-9]{6}$/.test(deviceSerial.slice(suffix + 1))) {
      deviceSerial = deviceSerial.slice(0, suffix);
    }
    const service = services.find((item) =>
      item.type === CONNECT_TYPE && item.name.toLowerCase() === guid.toLowerCase());
    hosts.push({
      guid,
      deviceSerial: service?.hardwareSerial !== undefined && service.hardwareSerial.length > 0
        ? service.hardwareSerial
        : deviceSerial,
      endpoint: service?.endpoint,
      endpointFromSession: false,
      deviceName: service?.givenName,
      model: service?.model
    });
  }
  return hosts;
}

/** 将当前连接与配对历史合并成界面分组（对应 DeviceCatalog.Group + MergeKnownHosts）。 */
export function mergeGroups(devices: AdbDevice[], knownHosts: AdbKnownHost[]): DeviceGroup[] {
  const groups = groupDevices(devices);
  const pairedGroups = groupDevices(knownHosts.map(knownHostAsDevice));
  for (const paired of pairedGroups) {
    if (!groups.some((group) => samePhysicalDevice(group, paired))) groups.push(paired);
  }
  return groups.sort((left, right) => {
    const nameDiff = groupDisplayName(left).localeCompare(groupDisplayName(right), "zh-Hans-CN", { sensitivity: "base" });
    if (nameDiff !== 0) return nameDiff;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
}

/** 对应 DeviceCatalog.Group：按硬件序列号合并，否则按地址 / 传输合并。 */
export function groupDevices(devices: AdbDevice[]): DeviceGroup[] {
  const groups: DeviceGroup[] = [];
  for (const device of devices.filter(canUseHardwareSerial)) {
    const key = "device:" + (device.hardwareSerial ?? "");
    let group = groups.find((item) => item.key === key);
    if (group === undefined) {
      group = { key, connections: [] };
      groups.push(group);
    }
    group.connections.push(device);
  }
  for (const device of devices.filter((item) => !canUseHardwareSerial(item))) {
    const emulator = device.serial.startsWith("emulator-");
    const endpoint = device.address ?? normalizeEndpoint(device.serial);
    const matches = emulator || endpoint === null
      ? []
      : groups.filter((group) => group.connections.some((item) =>
          (item.address ?? normalizeEndpoint(item.serial)) === endpoint));
    const key = !emulator && endpoint !== null ? "endpoint:" + endpoint : "transport:" + transportKey(device);
    const target = matches.length === 1 ? matches[0] : groups.find((group) => group.key === key);
    if (target !== undefined) target.connections.push(device);
    else groups.push({ key, connections: [device] });
  }
  return groups;
}

function canUseHardwareSerial(device: AdbDevice): boolean {
  return typeof device.hardwareSerial === "string" && device.hardwareSerial.length > 0 &&
    !device.serial.startsWith("emulator-");
}

function transportKey(device: AdbDevice): string {
  return device.serial + "\t" + String(device.transportId);
}

export function samePhysicalDevice(left: DeviceGroup, right: DeviceGroup): boolean {
  if (left.key === right.key) return true;
  const leftSerial = groupsHardwareSerial(left);
  const rightSerial = groupsHardwareSerial(right);
  if (leftSerial !== undefined && rightSerial !== undefined) {
    return leftSerial.toLowerCase() === rightSerial.toLowerCase();
  }
  const leftEndpoint = normalizeEndpoint(groupDisplayAddress(left));
  const rightEndpoint = normalizeEndpoint(groupDisplayAddress(right));
  if (leftEndpoint !== null && rightEndpoint !== null && leftEndpoint.toLowerCase() === rightEndpoint.toLowerCase()) {
    return true;
  }
  return left.connections.some((first) => right.connections.some((second) =>
    first.serial.toLowerCase() === second.serial.toLowerCase() ||
    (endpointIdentity(first) !== null && endpointIdentity(first) === endpointIdentity(second))));
}

function endpointIdentity(device: AdbDevice): string | null {
  return normalizeEndpoint(device.address) ?? normalizeEndpoint(device.serial);
}

export function groupsHardwareSerial(group: DeviceGroup): string | undefined {
  for (const connection of group.connections) {
    if (connection.hardwareSerial !== undefined && connection.hardwareSerial.length > 0) return connection.hardwareSerial;
  }
  return undefined;
}

export function groupDisplayName(group: DeviceGroup): string {
  for (const connection of group.connections) {
    if (connection.model.length > 0 && connection.model !== "—") return connection.model;
  }
  return preferredConnection(group, normalizeEndpoint).serial;
}

export function groupDisplayAddress(group: DeviceGroup): string {
  const ordered = [...group.connections].sort((left, right) => {
    const connectedDiff = Number(isConnected(right)) - Number(isConnected(left));
    if (connectedDiff !== 0) return connectedDiff;
    return Number(right.addressFromSession) - Number(left.addressFromSession);
  });
  for (const connection of ordered) {
    const endpoint = normalizeEndpoint(connection.address);
    if (endpoint !== null) return endpoint;
  }
  if (isHistoryGroup(group)) return "未发现连接地址";
  const hasWireless = group.connections.some((connection) =>
    connection.serial.replace(/\.+$/, "").toLowerCase().endsWith("." + CONNECT_TYPE) ||
    normalizeEndpoint(connection.serial) !== null);
  if (hasWireless) return "地址待解析";
  return transportOf(preferredConnection(group, normalizeEndpoint), normalizeEndpoint);
}

export function isHistoryGroup(group: DeviceGroup): boolean {
  return group.connections.length > 0 && group.connections.every((connection) => connection.state === "paired");
}

export function groupState(group: DeviceGroup): string {
  const connected = group.connections.some(isConnected);
  if (isHistoryGroup(group)) return normalizeEndpoint(groupDisplayAddress(group)) !== null ? "已配对 · 可连接" : "已配对 · 未连接";
  if (connected) return "已连接";
  return displayState(preferredConnection(group, normalizeEndpoint));
}

export function groupConnectionSummary(group: DeviceGroup): string {
  if (isHistoryGroup(group)) return "无线调试 · 已配对（未连接）";
  if (group.connections.length === 1) return connectionLabel(group.connections[0], normalizeEndpoint);
  return group.connections.length + " 条连接";
}

export function groupPairingGuid(group: DeviceGroup): string | undefined {
  for (const connection of group.connections) {
    if (connection.pairingGuid !== undefined && connection.pairingGuid.length > 0) return connection.pairingGuid;
  }
  return undefined;
}

export function groupHasWireless(group: DeviceGroup): boolean {
  return group.connections.some((connection) => {
    const transport = transportOf(connection, normalizeEndpoint);
    return transport === "无线调试" || transport === "IP 直连";
  });
}

export function groupCanConnect(group: DeviceGroup): boolean {
  return normalizeEndpoint(groupDisplayAddress(group)) !== null;
}

export function groupCanUnpair(group: DeviceGroup): boolean {
  return isHistoryGroup(group) && !group.connections.some(isConnected) && groupPairingGuid(group) !== undefined;
}

export function groupDisconnectable(group: DeviceGroup): boolean {
  return !isHistoryGroup(group) && groupHasWireless(group) && group.connections.some(isConnected);
}

export function pairingEndpoints(services: AdbService[]): string[] {
  const endpoints = services
    .filter((service) => service.type === PAIRING_TYPE && !service.name.toLowerCase().startsWith("studio-"))
    .map((service) => service.endpoint);
  return [...new Set(endpoints)].sort();
}

export function connectingEndpoints(services: AdbService[]): string[] {
  const endpoints = services
    .filter((service) => service.type === CONNECT_TYPE)
    .map((service) => service.endpoint);
  return [...new Set(endpoints)].sort();
}

export function splitLines(output: string): string[] {
  return (output ?? "").split(/\r?\n/).filter((line) => line.length > 0);
}

function unescapeProtoString(value: string): string {
  return value.replace(/\\\\/g, "\\").replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\r/g, "\r");
}

function pickField(fields: Map<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = fields.get(name);
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

