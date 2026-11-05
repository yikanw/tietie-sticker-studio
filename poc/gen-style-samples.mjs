// 为每种风格生成一张样张（2×2 四格表情），用原创形象，避免直接展示有版权的参考 IP。
// 用法：先停掉工作台服务（避免累计开销被覆盖），再运行 node poc/gen-style-samples.mjs [风格id...]
// 产物：server/style-samples/<id>.jpg（512px）
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { runApiImage } from "../server/api-backend.mjs";
import { priceApiImage } from "../server/billing.mjs";
import { getSettings } from "../server/settings.mjs";
import { initSpend, recordSpend } from "../server/spend.mjs";
import { STYLES } from "../server/prompts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "server/style-samples");

// 每种风格配一个原创主体和四格内容（文字类风格四格就是四句话）
const SAMPLES = {
  cream: { subject: "一只圆滚滚的奶白色小兔子，耳朵内侧粉色，脖子上系粉色小蝴蝶结", caps: ["哈哈哈", "委屈", "收到", "晚安"] },
  line: { subject: "一个圆头豆眼的白色小团子人，头顶一根呆毛，身体像小汤圆", caps: ["好的", "？", "冲啊", "溜了"] },
  crayon: { subject: "一只耳朵耷拉的棕色短腿小狗，圆眼睛，肚子白色", caps: ["饿了", "委屈", "期待", "抱抱"] },
  round3d: { subject: "一只明黄色、圆滚滚、大嘴巴的小鸡，短翅膀短腿", caps: ["在吗", "震惊", "告辞", "来啦"] },
  uglycute: { subject: "一个绿色土豆形状的小生物，豆豆眼眼神呆滞，几乎没有表情", caps: ["哦", "我先缓缓", "？", "好的吧"] },
  doodle: { subject: "一个马克笔画的圆脑袋小人，身体是简单线条，五官夸张变形", caps: ["笑死", "离谱", "救命", "绝了"] },
  pixel: { subject: "一只像素风的灰色小猫，大眼睛，像复古游戏里的角色", caps: ["GG", "冲", "开心", "晚安"] },
  petphoto: { subject: "一只真实照片质感的普通柴犬（不是任何网红宠物），自然光，四格是不同的特写和姿态", caps: ["嘴硬", "委屈", "装镇定", "困了"] },
  realshot: { subject: "一位虚构的普通年轻人（不是任何真实的名人或网红），影视截图质感，四格是不同的强烈面部反应", caps: ["你认真的？", "震惊", "不要", "无语"] },
  bigtext: { text: true, caps: ["收到", "稍等", "好的", "下班"] },
  blessing: { text: true, caps: ["早上好", "平安喜乐", "周末愉快", "晚安"] },
  inkwash: { text: true, caps: ["早安", "安好", "珍重", "晚安"] },
};

function promptFor(st, s) {
  const grid = "画面是 2×2 四宫格，四格等大，格子之间用细的浅灰线分隔，整体白色背景。";
  if (s.text) {
    return `制作一张纯文字表情包的风格样张。${grid}
四格分别是四张文字表情，文字依次为：「${s.caps.join("」「")}」，每个字都必须一字不差、清楚易读，文字就是画面主体，不要角色。
画风：${st.prompt}`;
  }
  const cap = st.caption?.mode === "overlay"
    ? `每格下方写一句配字，依次为：「${s.caps.join("」「")}」，粗体，字色 ${st.caption.fill}，描边 ${st.caption.stroke}，一字不差、清楚易读。`
    : "";
  return `制作一张表情包的风格样张，用来展示这种画风。${grid}
四格是同一个原创形象的四张聊天表情，动作和情绪明显不同，分别对应：${s.caps.join("、")}。
形象：${s.subject}。
画风：${st.prompt}
${cap}
必须是原创形象，不要模仿任何已有 IP、卡通角色或真实人物。`;
}

const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SAMPLES);
await mkdir(OUT, { recursive: true });
initSpend([]);
const { model, quality } = getSettings().image;
let total = 0;

async function one(id) {
  const st = STYLES.find((x) => x.id === id);
  const s = SAMPLES[id];
  if (!st || !s) return console.log(`跳过 ${id}`);
  const t0 = Date.now();
  try {
    const r = await runApiImage({ prompt: promptFor(st, s), refImages: [], transparent: false });
    await sharp(r.buffer).resize(512, 512).flatten({ background: "#ffffff" }).jpeg({ quality: 84 }).toFile(join(OUT, `${id}.jpg`));
    const usd = r.usage ? priceApiImage({ model, quality, cls: "square", refCount: 0, usage: r.usage }).usd : 0;
    total += usd;
    recordSpend({ backend: "api", usd });
    console.log(`✓ ${id} ${((Date.now() - t0) / 1000).toFixed(0)}s $${usd.toFixed(4)}`);
  } catch (e) {
    console.log(`✗ ${id}：${e.message}`);
  }
}

// 4 个一组并发
for (let i = 0; i < ids.length; i += 4) await Promise.all(ids.slice(i, i + 4).map(one));
console.log(`合计 $${total.toFixed(4)}`);
