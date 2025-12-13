// Автопостинг 1 текста в Threads через Assistants v2 + анти-повторы (Gist)
import axios from "axios";

// ===== ENV =====
const {
  OPENAI_API_KEY,
  ASSISTANT_ID,
  THREADS_USER_ACCESS_TOKEN,
  GITHUB_TOKEN,
  GIST_ID,
  STATE_FILE = "state.json",
  DRY_RUN = "0"
} = process.env;

function need(name){ if(!process.env[name]) throw new Error(`ENV ${name} is required`); }
["OPENAI_API_KEY","ASSISTANT_ID","THREADS_USER_ACCESS_TOKEN","GITHUB_TOKEN","GIST_ID"].forEach(need);

// ===== Gist state =====
async function loadState(){
  const { data } = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "User-Agent": "meridian-threads-autopost" }
  });
  const file = data.files?.[STATE_FILE];
  if (!file?.content) return { last_id: 0, published_titles: [] };
  try { return JSON.parse(file.content); } catch { return { last_id: 0, published_titles: [] }; }
}
async function saveState(state){
  const files = {}; files[STATE_FILE] = { content: JSON.stringify(state, null, 2) };
  await axios.patch(`https://api.github.com/gists/${GIST_ID}`, { files }, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "User-Agent": "meridian-threads-autopost" }
  });
}

// ===== OpenAI Assistants v2 =====
const OA = axios.create({
  baseURL: "https://api.openai.com/v1",
  headers: {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "OpenAI-Beta": "assistants=v2",
    "Content-Type": "application/json"
  },
  timeout: 60000
});

async function runAssistant(nextId, publishedTitles, todayTopicIndex){
  // 1) создать thread
  const thread = await OA.post("/threads", {});
  const thread_id = thread.data.id;

  // 2) передать ассистенту тему дня и антиповторы заголовков
  const banned = (publishedTitles || []).slice(-50);
  const userMsgParts = [];

  if (banned.length > 0) {
    userMsgParts.push(
      `Не используй дословно заголовки из списка: ${banned.join(" | ")}. Заголовок должен отличаться по формулировке.`
    );
  }

  if (userMsgParts.length) {
    await OA.post(`/threads/${thread_id}/messages`, {
      role: "user",
      content: userMsgParts.join(" ")
    });
  }

  // 3) запустить run
  const run = await OA.post(`/threads/${thread_id}/runs`, { assistant_id: ASSISTANT_ID });
  const run_id = run.data.id;

  // 4) дождаться завершения
  let status = run.data.status;
  while (!["completed","failed","cancelled","expired"].includes(status)) {
    await new Promise(r => setTimeout(r, 1500));
    const r2 = await OA.get(`/threads/${thread_id}/runs/${run_id}`);
    status = r2.data.status;
  }
  if (status !== "completed") throw new Error(`Run status=${status}`);

  // 5) получить ответ
  const messages = await OA.get(`/threads/${thread_id}/messages`, { params: { order: "desc", limit: 5 } });
  const firstAssistant = messages.data.data.find(m => m.role === "assistant");
  const parts = (firstAssistant?.content || []).map(c => c?.text?.value || "").filter(Boolean);
  const raw = parts.join("\n").trim();

  // 6) выдрать JSON с безопасной очисткой и fallback
  let json, text, tag, title;
  
  try {
    // Очистка от мусора перед парсингом
    const rawClean = raw
      .replace(/[\u0000-\u001F]+/g, " ") // удалить control-символы
      .replace(/[“”]/g, '"')              // заменить “ ” на обычные "
      .replace(/\\(?!["\\/bfnrtu])/g, "\\\\"); // экранировать невалидные \

    console.log("=== RAW ASSISTANT OUTPUT ===\n", raw, "\n==========================");
  
    const start = rawClean.indexOf("{");
    const end = rawClean.lastIndexOf("}");
    if (start < 0 || end < 0) throw new Error("Assistant output has no JSON");
  
    json = JSON.parse(rawClean.slice(start, end + 1));
  
    if (json.lang !== "ru" || json.type !== "single") throw new Error("JSON not in required format (ru/single)");
    if (!json.title || !json.body || !json.cta) throw new Error("Missing fields in JSON");
  
    text = `${json.title}\n${json.body}\n\n${json.cta}`;
    tag = (json.tag || "").trim();
    title = json.title.trim();
  
  } catch (err) {
    console.warn("⚠️ JSON parse failed, trying to clean JSON wrapper. Error:", err.message);
    
    // Попробуем вырезать поля из JSON даже при невалидности
    let bodyMatch = raw.match(/"body"\s*:\s*"([^"]+)"/);
    let titleMatch = raw.match(/"title"\s*:\s*"([^"]+)"/);
    let ctaMatch = raw.match(/"cta"\s*:\s*"([^"]+)"/);
    
    if (bodyMatch || titleMatch || ctaMatch) {
      text = `${titleMatch ? titleMatch[1] + "\n" : ""}${bodyMatch ? bodyMatch[1] + "\n\n" : ""}${ctaMatch ? ctaMatch[1] : ""}`;
    } else {
      text = raw.replace(/[\u0000-\u001F]+/g, " ").trim();
    }
  
    // Ограничение Threads API
    if (text.length > 500) text = text.slice(0, 497) + "...";
  
    tag = "";
    title = titleMatch ? titleMatch[1].slice(0, 60) : "Без названия";
  }
  
  return { text, title, tag };
}

// ===== Threads publish (TEXT, auto publish) =====
async function postToThreads({ text, tag }){
  const url = "https://graph.threads.net/me/threads";
  // Параметры как в офиц. Postman коллекции: media_type=TEXT, auto_publish_text=true, reply_control, topic_tag
  // Авторизация — Bearer USER ACCESS TOKEN
  // Threads API ограничивает text <= 500 символов
  if (text.length > 500) {
    console.warn(`⚠️ Text too long (${text.length} chars) — trimming to 500`);
    text = text.slice(0, 497) + "...";
  }
  const resp = await axios.post(url, null, {
    headers: {
      "Authorization": `Bearer ${THREADS_USER_ACCESS_TOKEN}`,
      "Accept": "application/json"
    },
    params: {
      media_type: "TEXT",
      text,
      auto_publish_text: true,
      reply_control: "everyone",
      ...(tag ? { topic_tag: tag } : {})
    },
    timeout: 20000
  });
  return resp.data; // { id: "..." }
}

// ===== Main =====
(async () => {
  console.log("▶️ Start Meridian Threads autopost…");
  const state = await loadState(); // { last_id, published_titles }
  const nextId = (state.last_id ?? 0) + 1;
  const topicIndex = (state.topic_index ?? 0) + 1;
  const topicMax = 30; // у тебя 30 тем в списке
  const todayTopicIndex = ((topicIndex - 1) % topicMax) + 1; // 1..30 по кругу

  const { text, title, tag } = await runAssistant(
    nextId,
    state.published_titles || [],
    todayTopicIndex
  );

  if (state.published_titles?.includes(title)) {
    throw new Error(`Title already published earlier: "${title}"`);
  }

  if (DRY_RUN === "1") {
    console.log("----- DRY RUN -----\n" + text + "\nTag:", tag, "\n-------------------");
  } else {
    const res = await postToThreads({ text, tag });
    console.log("✅ Published to Threads:", res);
  }

  const published = Array.isArray(state.published_titles) ? state.published_titles : [];
  if (title && !published.includes(title)) published.push(title);

  await saveState({
    last_id: nextId,
    published_titles: published.slice(-500),
    topic_index: topicIndex
  });
  console.log("💾 State saved. Done.");
})().catch(err => {
  console.error("❌ Fatal:", err?.response?.data || err.message || err);
  process.exit(1);
});
