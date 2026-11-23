import qrcodeModule from "./vendor/qrcode-generator";

interface QrCodeInstance {
  addData(data: string): void;
  make(): void;
  createSvgTag(options: Record<string, unknown>): string;
}

type QrCodeFactory = (typeNumber: number, errorCorrectionLevel: string) => QrCodeInstance;

// 内置 qrcode-generator 没有类型声明，这里做最小类型收窄。
const qrcodeGenerator = qrcodeModule as unknown as QrCodeFactory;

export interface QrSession {
  name: string;
  secret: string;
  payload: string;
  expiresAt: number;
}

/**
 * 生成二维码配对会话。二维码内容格式与 Android Studio / 原工具一致：
 * WIFI:T:ADB;S:<服务名>;P:<配对密码>;;
 * 手机扫码后会广播同名 _adb-tls-pairing._tcp 服务，电脑发现后用密码调用 adb pair。
 */
export function createQrSession(now: number = Date.now()): QrSession {
  const name = "studio-" + randomHex(5);
  const secret = randomHex(5).toUpperCase();
  return {
    name,
    secret,
    payload: "WIFI:T:ADB;S:" + name + ";P:" + secret + ";;",
    expiresAt: now + 2 * 60 * 1000
  };
}

export async function renderQrSvg(payload: string): Promise<string> {
  const qr = qrcodeGenerator(0, "M");
  qr.addData(payload);
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 4, alt: "ADB WIFI 配对二维码" });
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  const cryptoModule = require("crypto") as typeof import("crypto");
  cryptoModule.randomFillSync(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}
