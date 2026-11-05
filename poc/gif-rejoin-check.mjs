import sharp from "sharp";
const src = process.argv[2], out = process.argv[3];
const meta = await sharp(src, { animated: true }).metadata();
console.log("pages", meta.pages, "w", meta.width, "pageHeight", meta.pageHeight, "delay", meta.delay, "loop", meta.loop);
const { data, info } = await sharp(src, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
console.log("raw", info.width, info.height, info.channels);
// split into frames, then join back as animated
const fh = meta.pageHeight, n = meta.pages, w = info.width;
const frames = [];
for (let i = 0; i < n; i++) frames.push(await sharp(data.subarray(i * w * fh * 4, (i + 1) * w * fh * 4), { raw: { width: w, height: fh, channels: 4 } }).png().toBuffer());
const t = Date.now();
await sharp(frames, { join: { animated: true } }).gif({ delay: meta.delay, loop: 0 }).toFile(out);
const m2 = await sharp(out, { animated: true }).metadata();
console.log("rejoined pages", m2.pages, "delay", m2.delay, "ms", Date.now() - t);
