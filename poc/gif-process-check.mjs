import { processGif } from "../server/imaging.mjs";
const r = await processGif(process.argv[2], [{ path: process.argv[3] + "-512.gif", size: 512 }, { path: process.argv[3] + "-240.gif", size: 240 }], { caption: "你好呀", captionPos: "bottom" });
console.log(JSON.stringify({ frames: r.frames, results: r.results.map((x) => ({ size: x.size, kb: Math.round(x.bytes / 1024) })), stats: { ...r.stats, bbox: undefined } }));
