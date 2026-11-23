import { test } from "node:test";
import * as assert from "node:assert/strict";

import { readKnownHostGuids, removeKnownHostRecords } from "../adb/knownHosts";
import { buildKnownHosts, groupDevices, mergeGroups, normalizeEndpoint, parseDevices, parseKnownHostsText, parseServices, parseTrackedService } from "../adb/parse";
import { createQrSession, renderQrSvg } from "../qr";
import { hostOf } from "../adb/localNetwork";

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let current = value;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

function knownHostMessage(guid: string): Buffer {
  const text = Buffer.from(guid, "utf8");
  return Buffer.concat([varint((1 << 3) | 2), varint(text.length), text]);
}

function knownHostsFile(guids: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const guid of guids) {
    const inner = knownHostMessage(guid);
    parts.push(Buffer.concat([varint((1 << 3) | 2), varint(inner.length), inner]));
  }
  return Buffer.concat(parts);
}

test("normalizeEndpoint 规范化 IPv4/IPv6 地址", () => {
  assert.equal(normalizeEndpoint("192.168.1.2:5555"), "192.168.1.2:5555");
  assert.equal(normalizeEndpoint(" 192.168.1.2:5555 "), "192.168.1.2:5555");
  assert.equal(normalizeEndpoint("192.168.001.002:1"), "192.168.1.2:1");
  assert.equal(normalizeEndpoint("[fe80::1]:5555"), "[fe80::1]:5555");
  assert.equal(normalizeEndpoint("fe80::1:5555"), null);
  assert.equal(normalizeEndpoint("192.168.1.2:0"), null);
  assert.equal(normalizeEndpoint("192.168.1.2:65536"), null);
  assert.equal(normalizeEndpoint("192.168.1.256:5555"), null);
  assert.equal(normalizeEndpoint(""), null);
  assert.equal(normalizeEndpoint(undefined), null);
});

test("parseServices 解析 adb mdns services", () => {
  const output = [
    "adb-ABC123-XYZ\t_adb-tls-pairing._tcp\t192.168.1.5:37105",
    "adb-ABC123-XYZ\t_adb-tls-connect._tcp\t192.168.1.5:40011",
    "garbage line",
    "studio-123abc\t_adb-tls-pairing._tcp\t[fe80::1]:37001"
  ].join("\r\n");
  const services = parseServices(output);
  assert.equal(services.length, 3);
  assert.deepEqual(services[0], { name: "adb-ABC123-XYZ", type: "_adb-tls-pairing._tcp", endpoint: "192.168.1.5:37105" });
  assert.equal(services[2].endpoint, "[fe80::1]:37001");
});

test("parseDevices 解析 adb devices -l", () => {
  const output = [
    "List of devices attached",
    "adb-ABC123-XYZ._adb-tls-connect._tcp. device model:Pixel_7 transport_id:3",
    "192.168.1.6:5555 offline transport_id:4",
    "emulator-5554 unauthorized",
    ""
  ].join("\n");
  const devices = parseDevices(output);
  assert.equal(devices.length, 3);
  assert.equal(devices[0].serial, "adb-ABC123-XYZ._adb-tls-connect._tcp.");
  assert.equal(devices[0].state, "device");
  assert.equal(devices[0].model, "Pixel 7");
  assert.equal(devices[0].transportId, 3);
  assert.equal(devices[1].state, "offline");
  assert.equal(devices[2].state, "unauthorized");
});

test("parseTrackedService 解析 proto-text 服务块", () => {
  const block = [
    "service {",
    "  instance: \"adb-ABC123-XYZ\"",
    "  service: \"_adb-tls-connect._tcp\"",
    "  given_name: \"我的手机\"",
    "  device_model: \"Pixel_7\"",
    "  serial: \"XYZ123\"",
    "}"
  ].join("\n");
  const service = parseTrackedService(block);
  assert.notEqual(service, null);
  assert.equal(service!.name, "adb-ABC123-XYZ");
  assert.equal(service!.type, "_adb-tls-connect._tcp");
  assert.equal(service!.givenName, "我的手机");
  assert.equal(service!.model, "Pixel 7");
  assert.equal(service!.hardwareSerial, "XYZ123");
  assert.equal(parseTrackedService("service {\n  foo: \"bar\"\n}"), null);
});

test("parseKnownHostsText 与 buildKnownHosts", () => {
  const output = 'known_hosts {\n  guid: "adb-1234567890ABCDEF-abcdef"\n}\nknown_hosts {\n  guid: "adb-AAA-123456"\n}';
  assert.deepEqual(parseKnownHostsText(output), ["adb-1234567890ABCDEF-abcdef", "adb-AAA-123456"]);
  const hosts = buildKnownHosts(["adb-1234567890ABCDEF-abcdef", "adb-AAA-123456"], []);
  assert.equal(hosts.length, 2);
  assert.equal(hosts[0].deviceSerial, "1234567890ABCDEF");
  assert.equal(hosts[1].deviceSerial, "AAA");
  assert.equal(hosts[0].endpoint, undefined);
});

test("buildKnownHosts 使用 mDNS 服务补全名称与地址", () => {
  const hosts = buildKnownHosts(["adb-ABC123-XYZ"], [{
    name: "adb-ABC123-XYZ",
    type: "_adb-tls-connect._tcp",
    endpoint: "192.168.1.5:40011",
    givenName: "我的手机",
    model: "Pixel 7",
    hardwareSerial: "XYZ123"
  }]);
  assert.equal(hosts[0].deviceSerial, "XYZ123");
  assert.equal(hosts[0].endpoint, "192.168.1.5:40011");
  assert.equal(hosts[0].deviceName, "我的手机");
  assert.equal(hosts[0].model, "Pixel 7");
});

test("groupDevices 按硬件序列号合并连接", () => {
  const groups = groupDevices([
    { serial: "adb-ABC._adb-tls-connect._tcp.", state: "device", model: "Pixel 7", address: "192.168.1.5:40011", addressFromSession: false, hardwareSerial: "XYZ123", transportId: 1 },
    { serial: "192.168.1.5:40011", state: "device", model: "Pixel 7", address: "192.168.1.5:40011", addressFromSession: false, hardwareSerial: "XYZ123", transportId: 2 }
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].connections.length, 2);
});

test("mergeGroups 合并配对历史与当前连接", () => {
  const groups = mergeGroups([
    { serial: "adb-ABC._adb-tls-connect._tcp.", state: "device", model: "Pixel 7", address: "192.168.1.5:40011", addressFromSession: false, hardwareSerial: "XYZ123", transportId: 1 }
  ], [{
    guid: "adb-ABC",
    deviceSerial: "XYZ123",
    endpoint: "192.168.1.5:40011",
    endpointFromSession: false,
    deviceName: "Pixel 7",
    model: "Pixel 7"
  }]);
  assert.equal(groups.length, 1);
});

test("known_hosts.pb 读取与按 guid 删除", () => {
  const data = knownHostsFile(["adb-AAA-111111", "adb-BBB-222222"]);
  assert.deepEqual(readKnownHostGuids(data), ["adb-AAA-111111", "adb-BBB-222222"]);

  const removed = removeKnownHostRecords(data, "adb-AAA-111111");
  assert.notEqual(removed, null);
  assert.equal(removed!.removed, 1);
  assert.deepEqual(readKnownHostGuids(removed!.updated), ["adb-BBB-222222"]);

  const keepAll = removeKnownHostRecords(data, "adb-CCC-333333");
  assert.notEqual(keepAll, null);
  assert.equal(keepAll!.removed, 0);
  assert.deepEqual(readKnownHostGuids(keepAll!.updated), ["adb-AAA-111111", "adb-BBB-222222"]);
});

test("known_hosts.pb 无法安全解析时返回 null", () => {
  assert.equal(readKnownHostGuids(Buffer.from([0xff, 0xff, 0xff, 0xff])), null);
  const invalidUtf8 = Buffer.concat([varint((1 << 3) | 2), varint(4), varint((1 << 3) | 2), varint(2), Buffer.from([0xff, 0xfe])]);
  assert.equal(readKnownHostGuids(invalidUtf8), null);
});

test("二维码内容格式与有效期", async () => {
  const session = createQrSession(0);
  assert.match(session.name, /^studio-[0-9a-f]{10}$/);
  assert.match(session.secret, /^[0-9A-F]{10}$/);
  assert.equal(session.payload, "WIFI:T:ADB;S:" + session.name + ";P:" + session.secret + ";;");
  assert.equal(session.expiresAt, 120000);
  const svg = await renderQrSvg(session.payload);
  assert.ok(svg.startsWith("<svg"));
});

test("hostOf 提取主机名", () => {
  assert.equal(hostOf("192.168.1.5:40011"), "192.168.1.5");
  assert.equal(hostOf("[fe80::1]:40011"), "[fe80::1]");
  assert.equal(hostOf("invalid"), null);
});
