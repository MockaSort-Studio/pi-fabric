import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DATASET = "SALT-NLP/SWE-chat";
const REVISION = "f66cca95b14caaa4177f7ed5eaa424608dadcffa";
const FILES = new Map([
  ["conversations.parquet", 1_311_422_253],
  ["sessions.parquet", 1_997_377],
]);
const CACHE = path.resolve("node_modules/.cache/pi-fabric-datasets/swe-chat");
const BROWSER = process.env.BROWSER_HARNESS_JS || "browser-harness-js";

const resolverProgram = (file) => `
if (!session.isConnected()) await session.connect()
const sourceUrl = ${JSON.stringify(`https://huggingface.co/datasets/${DATASET}/resolve/${REVISION}/${file}?download=true`)}
const target = await session.Target.createTarget({ url: "about:blank", background: true })
const { sessionId } = await session.Target.attachToTarget({ targetId: target.targetId, flatten: true })
try {
  await cdp(sessionId, "Page.enable", {})
  await cdp(sessionId, "Fetch.enable", { patterns: [{ urlPattern: "*SWE-chat*", requestStage: "Response" }] })
  const paused = session.waitFor({ method: "Fetch.requestPaused", sessionId, timeoutMs: 30000 })
  const navigation = cdp(sessionId, "Page.navigate", { url: sourceUrl })
  const event = await paused
  const location = (event.responseHeaders || []).find(header => header.name.toLowerCase() === "location")?.value || ""
  await cdp(sessionId, "Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" })
  await navigation.catch(() => {})
  if (!location) throw new Error("No authenticated redirect. Confirm SWE-chat access in the browser.")
  return location
} finally {
  cdp(sessionId, "Fetch.disable", {}).catch(() => {})
  session.closeTab(target.targetId, sessionId).catch(() => {})
}
`;

const run = (command, arguments_, options = {}) => {
  const result = spawnSync(command, arguments_, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
};

const signedUrl = (file) => run(BROWSER, [], { input: resolverProgram(file) });

fs.mkdirSync(CACHE, { recursive: true });
for (const [file, expectedBytes] of FILES) {
  const destination = path.join(CACHE, file);
  if (fs.existsSync(destination) && fs.statSync(destination).size === expectedBytes) {
    console.log(`${file}: cached (${expectedBytes} bytes)`);
    continue;
  }
  const temporary = `${destination}.part`;
  fs.rmSync(temporary, { force: true });
  const url = signedUrl(file);
  run("curl", [
    "--silent",
    "--show-error",
    "--location",
    "--fail",
    "--retry",
    "3",
    "--output",
    temporary,
    url,
  ]);
  const actualBytes = fs.statSync(temporary).size;
  if (actualBytes !== expectedBytes) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`${file}: expected ${expectedBytes} bytes, downloaded ${actualBytes}`);
  }
  fs.renameSync(temporary, destination);
  console.log(`${file}: downloaded (${actualBytes} bytes)`);
}

console.log(`SWE-chat ${REVISION} ready at ${CACHE}`);
