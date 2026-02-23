const statusEl = document.getElementById("status");
const fileEl = document.getElementById("file");
const canvas = document.getElementById("preview");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const btnPrev = document.getElementById("prev");
const btnNext = document.getElementById("next");
const btnSend = document.getElementById("send");

// ---- HiveMQ Cloud settings ----
// In HiveMQ Cloud "Cluster Details" you’ll see the host like: xxxx.s1.eu.hivemq.cloud
// WSS is typically wss://HOST:8884/mqtt  :contentReference[oaicite:1]{index=1}
const HOST = "cc0f333c4acf4560a6c5d7d55405eab4.s1.eu.hivemq.cloud"; // e.g. "abcd1234.s1.eu.hivemq.cloud"
const USERNAME = "Remco";
const PASSWORD = "Remco121";

const client = mqtt.connect(`wss://${HOST}:8884/mqtt`, {
  username: USERNAME,
  password: PASSWORD,
  // mqtt.js in browsers uses WebSocket TLS automatically via wss://
  reconnectPeriod: 2000,
});

client.on("connect", () => setStatus("MQTT connected ✅"));
client.on("reconnect", () => setStatus("MQTT reconnecting…"));
client.on("error", (e) => setStatus("MQTT error: " + e.message));

function setStatus(s) { statusEl.textContent = s; }

// ---- Playlist ----
/** @type {File[]} */
let files = [];
let idx = 0;
let frameId = 1;

fileEl.addEventListener("change", async (e) => {
  files = Array.from(e.target.files || []);
  idx = 0;
  if (files.length) await renderPreview(files[idx]);
  setStatus(`Loaded ${files.length} image(s).`);
});

btnPrev.addEventListener("click", async () => {
  if (!files.length) return;
  idx = (idx - 1 + files.length) % files.length;
  await renderPreview(files[idx]);
  setStatus(`Preview: ${files[idx].name} (${idx+1}/${files.length})`);
});

btnNext.addEventListener("click", async () => {
  if (!files.length) return;
  idx = (idx + 1) % files.length;
  await renderPreview(files[idx]);
  setStatus(`Preview: ${files[idx].name} (${idx+1}/${files.length})`);
});

btnSend.addEventListener("click", async () => {
  if (!files.length) return;
  if (!client.connected) { setStatus("Not connected to MQTT yet."); return; }

  // Convert current canvas -> RGB565 bytes
  const rgb565 = canvasToRGB565(canvas);

  await publishFrame(rgb565);
  setStatus(`Sent: ${files[idx].name} (frameId=${frameId-1})`);
});

// ---- Rendering: fit image into 128x128 (center-crop style) ----
async function renderPreview(file) {
  const img = await fileToImage(file);

  // Cover-fit: fill 128x128, crop overflow
  const cw = 128, ch = 128;
  const ir = img.width / img.height;
  const cr = cw / ch;

  let drawW, drawH;
  if (ir > cr) { // image wider than canvas -> fit height
    drawH = ch;
    drawW = ch * ir;
  } else {       // image taller -> fit width
    drawW = cw;
    drawH = cw / ir;
  }

  const dx = (cw - drawW) / 2;
  const dy = (ch - drawH) / 2;

  ctx.clearRect(0, 0, cw, ch);
  ctx.drawImage(img, dx, dy, drawW, drawH);
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

// ---- Convert canvas RGBA -> RGB565 (big-endian or little-endian; pick one and match ESP32) ----
// We'll use BIG-ENDIAN (network order): high byte first, then low byte.
function canvasToRGB565(cnv) {
  const { width, height } = cnv;
  const imageData = ctx.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height * 2);

  let o = 0;
  for (let i = 0; i < imageData.length; i += 4) {
    const r = imageData[i + 0];
    const g = imageData[i + 1];
    const b = imageData[i + 2];

    const rgb565 =
      ((r & 0xF8) << 8) |
      ((g & 0xFC) << 3) |
      ((b & 0xF8) >> 3);

    out[o++] = (rgb565 >> 8) & 0xFF; // hi
    out[o++] = rgb565 & 0xFF;        // lo
  }
  return out;
}

// ---- Publish binary chunks with 8-byte header ----
async function publishFrame(rgb565Bytes) {
  const chunkSize = 1024;
  const totalChunks = Math.ceil(rgb565Bytes.length / chunkSize);

  const myFrameId = frameId++ & 0xFFFF;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, rgb565Bytes.length);
    const chunk = rgb565Bytes.subarray(start, end);

    const payload = new Uint8Array(8 + chunk.length);
    payload[0] = 0x4D; // 'M'
    payload[1] = 0x58; // 'X'
    payload[2] = (myFrameId >> 8) & 0xFF;
    payload[3] = myFrameId & 0xFF;
    payload[4] = (chunkIndex >> 8) & 0xFF;
    payload[5] = chunkIndex & 0xFF;
    payload[6] = (totalChunks >> 8) & 0xFF;
    payload[7] = totalChunks & 0xFF;
    payload.set(chunk, 8);

    client.publish("matrix/frame", payload, { qos: 0 });
    // tiny yield so browser stays responsive
    await new Promise(r => setTimeout(r, 0));
  }
}