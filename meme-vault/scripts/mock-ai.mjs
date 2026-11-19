// 本地模拟 OpenAI 兼容视觉服务，仅用于端到端验证 AI 整理链路。
import http from "node:http";

const port = Number(process.env.MOCK_AI_PORT) || 7412;

const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    if (!request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end("not found");
      return;
    }
    let payload = {};
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      response.writeHead(400).end("bad json");
      return;
    }
    const text = JSON.stringify(payload.messages ?? []);
    const ids = [...new Set([...text.matchAll(/id=(item_[a-z0-9]+)/g)].map((match) => match[1]))];
    if (ids.length === 0) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ model: "mock-vision", choices: [{ message: { content: "OK" } }] }));
      return;
    }
    const items = ids.map((id, index) => ({
      id,
      category: index % 3 === 0 ? "可爱" : index % 3 === 1 ? "无语" : "",
      newCategory: index % 3 === 2 ? "模拟分类" : "",
      groups: [],
      newGroups: ["AI 测试"],
      tags: ["AI 标记"],
      name: "",
      confidence: 0.86,
      reason: "模拟视觉服务：根据画面判断",
    }));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        model: "mock-vision",
        choices: [{ message: { content: JSON.stringify({ items }) } }],
        usage: { prompt_tokens: 120, completion_tokens: 80 },
      }),
    );
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log("模拟 AI 服务：http://127.0.0.1:" + port + "/v1");
});
