// 提示词与结构化输出 schema
// 风格库（styles.json）与方向/语气/热梗（style-guide.json）整理自 research-20261105 的表情包调研。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.mjs";

export const STYLES = JSON.parse(readFileSync(join(ROOT, "server/styles.json"), "utf8"));
export const GUIDE = JSON.parse(readFileSync(join(ROOT, "server/style-guide.json"), "utf8"));

// 旧项目里的画风 id 映射到新风格库
const LEGACY = { chibi: "cream", semi: "cream", clay: "round3d", anime: "line", watercolor: "crayon", meme: "doodle" };
export const styleById = (id) => STYLES.find((s) => s.id === (LEGACY[id] ?? id)) ?? STYLES[0];
export const sceneById = (id) => GUIDE.scenes.find((s) => s.id === id) ?? GUIDE.scenes[0];
export const subjectById = (id) => GUIDE.subjects.find((s) => s.id === id) ?? GUIDE.subjects[0];
const toneById = (id) => GUIDE.tones.find((t) => t.id === id);
export const isTextPack = (a) => a?.subjectType === "text";
// 纯文字包的字一定由画面画出；其余按风格的配字方式
export const captionStyle = (a) => (isTextPack(a) ? { mode: "model" } : styleById(a?.styleId).caption ?? { mode: "overlay" });
export const modelCaption = (a) => captionStyle(a).mode === "model";

// 用户上传的多张图各自的用途
export const IMAGE_ROLES = {
  subject: "主体（要画成表情包的对象）",
  style: "风格参考（只学画法）",
  both: "主体 + 风格参考",
  scene: "元素/场景参考（道具、服装、背景、文字内容等）",
  other: "其他参考",
};
export const roleIsSubject = (r) => r === "subject" || r === "both";
export const roleIsStyle = (r) => r === "style" || r === "both";
// refs: [{ index: 用户图序号, role, note }]，按附图顺序排列；offset 是这些图之前已有的附图张数
export function inputRefText(refs, offset = 0) {
  return refs
    .map((r, i) => `附图${offset + i + 1} 是用户的图${r.index}——${IMAGE_ROLES[r.role] ?? IMAGE_ROLES.other}${r.note ? `：${r.note}` : ""}`)
    .join("；");
}
// 实拍类风格要把原图一起作为参考，保持真实样貌
export const needsInputRef = (a) => ["petphoto", "realshot"].includes(styleById(a?.styleId).id);

const str = { type: "string" };
const obj = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

export const ANALYSIS_SCHEMA = obj({
  summary: str,
  imageRoles: { type: "array", items: obj({ index: { type: "integer" }, role: { type: "string", enum: Object.keys(IMAGE_ROLES) }, note: str }) },
  subjectType: { type: "string", enum: GUIDE.subjects.map((s) => s.id) },
  characters: {
    type: "array",
    items: obj({
      role: { type: "string", enum: ["主角", "配角"] },
      name: str,
      appearance: str,
      personality: str,
    }),
  },
  styleId: { type: "string", enum: STYLES.map((s) => s.id) },
  altStyleIds: { type: "array", items: { type: "string", enum: STYLES.map((s) => s.id) } },
  styleReason: str,
  toneIds: { type: "array", items: { type: "string", enum: GUIDE.tones.map((t) => t.id) } },
  directions: { type: "array", items: obj({ title: str, description: str, sceneId: { type: "string", enum: GUIDE.scenes.map((s) => s.id) } }) },
  recommendedDirection: { type: "integer" },
});

export const PLAN_SCHEMA = obj({
  items: {
    type: "array",
    items: obj({ emotion: str, action: str, caption: str, motion: str, gif: { type: "boolean" } }),
  },
});

const list = (arr, f) => arr.map(f).join("\n");

export function analysisPrompt({ userPrompt, count, imageCount = 1 }) {
  const multi = imageCount > 1;
  const none = imageCount === 0;
  return `${none
    ? `用户没有上传图片。请完全根据下面的想法，为它策划一套 ${count} 张的微信聊天表情包；需要角色时由你原创设计形象（不要模仿任何已有 IP），不要向用户索要图片。`
    : `请分析附图，为它策划一套 ${count} 张的微信聊天表情包。`}
${multi ? `
用户上传了 ${imageCount} 张图，按附图顺序依次是图1 到图${imageCount}。用户可能在想法里写明了每张图的用途（例如"图1 是我的小猫，按图2 的风格"），有写明的严格照办；没写或写得含糊时，根据图片内容自己判断。
` : ""}
用户的想法：${userPrompt || "（没有补充，请你根据图片判断）"}

背景知识：好表情包的竞争力来自"这个主体能替发送者完成什么聊天动作"。主体、画风、语气、场景要分开判断。
主体不一定是角色：也可以是真实宠物、真人、双角色、食物物品、手势，或者完全没有主角的纯文字/装饰包。

请输出：
0. imageRoles：${none ? "没有图片，返回空数组。" : "每张图一条（index 从 1 开始）。"}role 可选：${Object.entries(IMAGE_ROLES).map(([k, v]) => `${k}=${v}`).join("，")}；note 用一句话说明这张图里要用的是什么。${multi || none ? "" : "只有一张图时通常是 subject；如果用户说这张只是风格参考，就标 style。"}
1. summary：一句话概括${none ? "这套表情包的主体" : multi ? "这些图" : "这张图"}和定位。
2. subjectType：主体类型，从下面选一个：
${list(GUIDE.subjects, (s) => `   - ${s.id}=${s.name}：${s.hint}`)}
3. characters：表情包里的角色。纯文字包（text）返回空数组；其他类型必须有且只有 1 个"主角"，"配角"最多 2 个（图里确实存在或用户要求时才加，duo 类型至少 2 个）。
   - name：简短好记的名字（2-4 个字）
   - appearance：${none ? "你原创设计的形象，" : ""}极其具体的外貌描述，供画师保持一致性（物种/性别年龄感、发型发色或毛色花纹、脸型五官、服装配饰、体型、2-3 个缩小后仍能认出的识别点），不少于 40 字
   - personality：有反差的性格（例如"懒但在乎你""表面平静内心忙乱"），影响表演
4. styleId：最合适的画风；altStyleIds：另外 2 个也值得预览的画风。画风库：
${list(STYLES, (s) => `   - ${s.id}=${s.name}（${s.group}）：${s.desc}；适合主体：${s.fits.join("/")}`)}
   styleReason 说明理由。实拍照片可以选实拍字幕类保留真实感，也可以选插画类做 Q 化。
   ${none ? "没有图片时不要选 fromref，也不要选实拍字幕类（petphoto/realshot）。\n   " : ""}有图被标为风格参考（style/both）时，优先选 fromref（按参考图风格），再从画风库里挑 2 个接近的作为备选；没有风格参考图时不要选 fromref。
   characters 只描述主体图里的对象，不要把风格参考图里的角色当成主体。
5. toneIds：1-2 个语气：${GUIDE.tones.map((t) => `${t.id}=${t.name}`).join("，")}
6. directions：3 个不同的内容方向，每个包含 title、一句 description、sceneId（场景模板）：
${list(GUIDE.scenes, (s) => `   - ${s.id}=${s.name}：${s.structure}`)}
   recommendedDirection 是最推荐的序号（从 0 开始）。
   用户的想法里点名的梗、流行语，要体现在方向的 description 里。`;
}

export function planPrompt({ analysis, direction, count, userPrompt, note, keep = [] }) {
  const scene = sceneById(direction.sceneId);
  const text = isTextPack(analysis);
  const cast = text ? "无（纯文字/装饰包，字本身是主角）" : analysis.characters.map((c) => `${c.role}「${c.name}」：${c.personality}`).join("；");
  const tones = (analysis.toneIds ?? []).map(toneById).filter(Boolean);
  // 热梗不自动加：只落实用户在想法/调整要求里点名的梗；用户笼统地说"加点热梗"时，才给出近期热梗作参考
  const asked = `${userPrompt ?? ""} ${note ?? ""}`;
  const wantsTrend = /热梗|梗|流行|热点|网络用语|潮流/.test(asked);
  const st = styleById(analysis.styleId);
  return `为下面这套微信表情包写出 ${count} 条表情计划。

主体类型：${subjectById(analysis.subjectType).name}
角色：${cast}
画风：${st.name}
语气：${tones.length ? tones.map((t) => `${t.name}（${t.prompt}）`).join("；") : "按角色性格"}
内容方向：${direction.title} —— ${direction.description}
场景模板「${scene.name}」的内容结构：${scene.structure}
可参考的常用条目（按需取舍、改写，不必照抄）：${scene.skeleton.slice(0, Math.max(count, 16)).join("、")}
用户的想法：${userPrompt || "无"}
${wantsTrend ? `用户想要梗：用户点名的梗必须落实到具体条目（每个梗 1-2 张，在 emotion 或 action 里写明是哪个梗）；没点名具体的梗时，可以从下面的近期热梗/梗机制里挑适合这个主体的 1-3 个：\n${list(GUIDE.memes.filter((m) => m.needs !== "duo" || analysis.subjectType === "duo"), (m) => `- ${m.name}（${m.since}）：${m.how}${m.caption ? `，配字可用「${m.caption}」` : ""}`)}\n` : ""}${note ? `本次调整要求：${note}\n` : ""}${keep.length ? `以下表情已经确定，不要重复：${keep.join("、")}\n` : ""}
每条包含：
- emotion：这张的聊天功能或情绪（2-6 字），例如"收到""软拒绝""委屈"
- action：${text
    ? "画面设计：文字的排版方式、字体气质、配色、装饰元素和动势（例如\"三个大字从左下到右上斜排，字边冒出速度线，亮黄底\"），不要写画风名"
    : "具体画面：动作姿态、表情细节、道具或特效、多角色时谁做什么（例如\"双手捂脸，眼泪喷成两道瀑布，头顶飘着乌云\"），不要写画风名"}
- caption：${text ? "画面里要写的文字（必填，2-8 个字，口语、好认）" : "配字（中文口语、简短，不超过 6 个字；动作已经足够清楚时可以留空）"}
- motion：如果做成动图，这张的循环动作（一句话，8 帧左右能表现完，首尾能接上），例如"双手举过头顶左右摇摆，眼泪一甩一甩"
- gif：用户明确要求动图（或这一条点名要动）时为 true，否则 false

编排规则：
${list(GUIDE.rules, (r) => `- ${r}`)}
- 整套要覆盖「${scene.name}」的各个环节，并穿插轻重不同的情绪`;
}

function castText(analysis) {
  if (isTextPack(analysis) || !analysis.characters?.length) return "无角色，文字本身就是主体";
  return analysis.characters.map((c) => `${c.role}「${c.name}」：${c.appearance}`).join("\n");
}

function styleText(analysis, styleId, styleNote) {
  const st = styleById(styleId ?? analysis.styleId);
  const note = styleNote ?? analysis.styleNote;
  const tones = (analysis.toneIds ?? []).map(toneById).filter(Boolean);
  return `${st.name}——${st.prompt}${note ? `；${note}` : ""}${tones.length ? `\n语气：${tones.map((t) => t.prompt).join("；")}` : ""}`;
}

// 风格设定图：2×2 四宫格，左上是主体设定（或字体样张），其余三格是示例表情
export function stylePreviewPrompt({ analysis, styleId, styleNote, sceneId, userPrompt, note, samples, refs = [] }) {
  const st = styleById(styleId);
  const text = isTextPack(analysis);
  const drawText = st.caption?.mode === "model";
  const s = samples ?? sceneById(sceneId).samples;
  return `请为一套微信聊天表情包制作一张「风格设定图」，用来确定整套的画风${text ? "和字体" : "和主体形象"}。

画面是 2×2 四宫格，四格等大，格子之间用细的浅灰线分隔，整体白色背景：
- 左上：${text ? "字体与配色样张，写「你好呀」" : "主体设定——主体正面、完整、表情平静友好；有配角时并排站"}
- 右上：示例表情「${s[0]}」
- 左下：示例表情「${s[1]}」
- 右下：示例表情「${s[2]}」

${refs.length ? `参考图：${inputRefText(refs)}。\n` : ""}${text ? "" : `主体：\n${castText(analysis)}\n${refs.some((r) => r.role === "subject" || r.role === "both") ? `忠实保留主体图中主体的辨识特征，按下面的画风重新呈现${refs.some((r) => r.role === "style") ? "；风格参考图里的角色不是主体，不要画进来" : ""}` : `按上面的描述原创设计主体形象，${refs.length ? "参考图里的角色不是主体，不要画进来；" : ""}外观识别点要清楚，后面整套都以它为准`}。\n\n`}画风：${styleText(analysis, styleId, styleNote)}

${drawText ? "示例格子里要把文字画出来，文字是画面主体，必须清楚易读、一字不差。" : "四个格子里都不要写任何文字，只用表情和动作表达（文字后期再加）。"}
${userPrompt ? `用户的想法：${userPrompt}\n` : ""}${note ? `本次调整要求：${note}\n` : ""}三张示例要体现同一套的统一风格，同时动作和情绪明显不同。不要模仿任何已有 IP 形象。`;
}

function refIntro(analysis, { edit = false, refs = [] } = {}) {
  const parts = [];
  let i = 1;
  if (edit) parts.push(`附图${i++} 是当前这张表情（修改的底稿）`);
  parts.push(`附图${i++} 是整套的「风格设定图」（2×2 四宫格），只参考其中的${isTextPack(analysis) ? "字体、配色、装饰和排版气质" : "主体外观、画风、配色和线条"}，不要复制四宫格布局`);
  if (refs.length) parts.push(inputRefText(refs, i - 1) + "（主体图用于保持真实样貌，风格参考图只学画法）");
  return parts.join("；") + "。";
}

export function stickerPrompt({ analysis, item, captionSpace, refs = [] }) {
  const text = isTextPack(analysis);
  const drawText = modelCaption(analysis);
  return `${refIntro(analysis, { refs })}
${text ? "" : "严格保持主体身份一致：脸型五官、发型/毛色花纹、服装配饰、配色都不能改变。\n"}
${text ? "" : `主体：\n${castText(analysis)}\n\n`}画风：${styleText(analysis)}

这张表情：【${item.emotion}】${item.action}
${drawText && item.caption ? `画面中的文字：「${item.caption}」——必须一字不差、清楚易读，是画面的主体。\n` : ""}
要求：
- 单张图、单个画面（不要四宫格），表情和动作要夸张、一眼能看懂，适合作为聊天表情包
- 主体完整不被裁切，居中，四周留出少量空白
- 透明背景
${drawText ? "- 除上面指定的文字外不要出现其他文字" : `- 画面中不要出现任何文字、字母、对话框${captionSpace ? "\n- 画面下方留出约 20% 的空白，后期会加字" : ""}`}`;
}

export function editPrompt({ analysis, item, instruction, refs = [] }) {
  const drawText = modelCaption(analysis);
  return `请修改这张表情包。${refIntro(analysis, { edit: true, refs })}

修改要求：${instruction}

除修改要求外，保持附图1 的构图、动作、画风、主体外观不变。
这张表情原本的内容：【${item.emotion}】${item.action}
画风：${styleText(analysis)}
透明背景。${drawText && item.caption ? `画面文字保持为「${item.caption}」。` : "画面中不要出现任何文字。"}`;
}

// 静图只用 action（定格画面），动图只用 motion（循环动作）；没写动作时按情绪自动设计，不拿静态描述充当动作
function motionLine(item, motion, base) {
  return motion?.trim()
    ? `循环动作：${motion.trim()}`
    : `循环动作：根据【${item.emotion}】在${base}的基础上设计一个简短、幅度明显的循环动作（例如点头、摇摆、蹦跳、抖动、眨眼、挥手），不要改变构图`;
}

// 直出动图：不经过静图，以风格设定图为参考直接生成 GIF
export function directGifPrompt({ analysis, item, motion, refs = [] }) {
  const text = isTextPack(analysis);
  const drawText = modelCaption(analysis);
  return `${refIntro(analysis, { refs })}
请直接制作一张循环动图表情包（GIF）。
${text ? "" : "严格保持主体身份一致：脸型五官、发型/毛色花纹、服装配饰、配色都不能改变。\n"}
${text ? "" : `主体：\n${castText(analysis)}\n\n`}画风：${styleText(analysis)}

这张表情：【${item.emotion}】
起始画面：${item.action || "按情绪设计一个清楚的姿态"}
${motionLine(item, motion, "起始画面")}
${drawText && item.caption ? `画面中的文字：「${item.caption}」——必须一字不差、清楚易读，可以有弹跳、抖动、闪烁等文字动效。\n` : ""}
要求：
- 单个画面（不要四宫格），镜头不动，主体完整居中，四周留出少量空白
- 动作幅度明显、节奏有喜感，一眼能看出【${item.emotion}】
- 最后一帧自然衔接回第一帧，无缝循环
- 纯白色背景
${drawText ? "- 除上面指定的文字外不要出现其他文字" : "- 画面中不要出现任何文字、字母、对话框（文字后期再加）"}`;
}

export function animatePrompt({ analysis, item, motion }) {
  const drawText = modelCaption(analysis);
  return `把附图1（当前这张表情）做成循环动图表情包。附图2 是整套的风格设定图，用于保持风格一致。
画面内容以附图1 为准，不需要重新构图。

${motionLine(item, motion, "附图1 现有姿态")}

要求：
- 主体外观、配色、画风、构图与附图1 保持一致，镜头不动
- 动作幅度明显、节奏有喜感，一眼能看出【${item.emotion}】
- 最后一帧自然衔接回第一帧，无缝循环
- 纯白色背景，${drawText && item.caption ? `文字「${item.caption}」保持清楚，可以有弹跳、抖动、闪烁等文字动效` : "画面中不要出现任何文字、对话框"}
画风：${styleText(analysis)}`;
}
