import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import csv from "csvtojson";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { exec } from "child_process";
import { v4 as uuidv4 } from "uuid";
import * as googleTTS from "google-tts-api";

// For __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const downloadsFolder = __dirname;
const app = express();
const PORT = 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LOCALE = process.env.LOCALE || "english";

let prompt = `You are a professional content strategist and scriptwriter with over 10 years of experience in creating viral short-form videos, especially for YouTube Shorts. Your task is to analyze the following JSON object, which contains data on a trending topic. The JSON includes:
- "trend": the name of the trend
- "volume": the current search volume of the trend (string, e.g. "1M+")
- "breakdown": a comma-separated string of related search terms

Your responsibilities:
- Research the most up-to-date information about the trend and related search terms. Search online as needed to ensure you select the freshest, most viral content angle.
- Identify the most viral content angle based on the trend, volume, and breakdown.
- Create a video plan with three elements:

Output a JSON object with exactly these fields:
- "title": A catchy title for the video (must be less than 100 characters). Hashtags are encouraged.
- "description": A short, engaging description for the video, including relevant hashtags.
- "body": The full, exact speech script of the video subtitles. The script must be natural, fast-paced, and highly engaging for a YouTube Short between 15 and 60 seconds. A good length would be of 300 words, so so ensure body to be between 250 and 300 words. It must sound natural, as if read by a narrator. Avoid using "I", "me", or any personal visual references. Do not include any hashtags in the body. Hashtags must only appear in the title and description. Try to add a call to action if appliable.

Additional important instructions:
- Maximize emotional pull, curiosity, or value delivery (fun fact, quick tutorial, shocking info, etc.).
- Keep the tone professional, engaging, and tailored for virality.
- You must check online for the latest updates or trending variations of the topic before finalizing the content.

Example input JSON:
{
  "trend": "AI art generators",
  "volume": "1M+",
  "breakdown": "best AI art tools, how to create AI art, free AI art generator, AI art examples"
}

Expected output JSON format:
{
  "title": "Top FREE AI Art Generators You Must Try! 🎨 #AIArt #Tech",
  "description": "Discover the best free AI art tools you can use today! #AIArt #DigitalArt #Creativity",
  "body": "Want to create stunning art with zero drawing skills? Check out these FREE AI art generators! Number one: Dall-e! Just type your idea and watch the magic happen. Number two: Midjourney—perfect for wild, surreal designs. Number three: Microsoft designer, the easiest for beginners. Start creating your own AI masterpieces today!"
}

IMPORTANT:
Always provide only the final JSON output in your response. Do not include explanations or additional text. Do not use for any reason placeholders in your response, the output must be definitive and ready to use without further inspection.

Now analyze the following JSON input and respond only with the requested JSON output.`;


app.use(express.json({ limit: "10mb" })); // JSON + base64 handling

// ---------------- /scrape ----------------
app.post("/scrape", async (req, res) => {
  const { geo, status, sort, category, hours } = req.body;

  const url = `https://trends.google.com/trending?geo=${geo}&status=${status}&sort=${sort}&category=${category}&hours=${hours}`;

  let browser;
  try {
    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.goto(url);
    await page.setViewport({ width: 1080, height: 1024 });

    const client = await page.createCDPSession();
    await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadsFolder });

    const filesBefore = new Set(fs.readdirSync(downloadsFolder));

    try {
      await page.waitForSelector("tr[role='row']", { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await page.waitForSelector('li[data-action="csv"]', { timeout: 5000 });
      await page.evaluate(() => document.querySelector('li[data-action="csv"]').click());
    } catch {
      return res.status(404).json({ error: "Cannot fetch trends data. Please check the parameters." });
    }

    const timeoutMs = 15000;
    const pollingInterval = 500;
    let downloadedFile = null;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const currentFiles = new Set(fs.readdirSync(downloadsFolder));
      const newFiles = [...currentFiles].filter((f) => !filesBefore.has(f) && f.endsWith(".csv"));
      if (newFiles.length > 0) {
        downloadedFile = newFiles[0];
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollingInterval));
    }

    if (!downloadedFile) return res.status(500).json({ error: "Download failed or timed out" });

    const filePath = path.join(downloadsFolder, downloadedFile);
    const jsonArray = (await csv().fromFile(filePath)).map((item) => ({
      trend: item["Trends"],
      volume: item["Search volume"],
      breakdown: item["Trend breakdown"],
      started: item["Started"],
      ended: item["Ended"],
    }));

    await fs.promises.unlink(filePath);
    return res.json(jsonArray);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  } finally {
    if (browser) await browser.close();
  }
});

// ---------------- /generate ----------------
app.post("/generate", async (req, res) => {
  const { language = "english", ...data } = req.body;

  let currentPrompt = prompt;

  // Dynamic translation if language is not english
  if (language.toLowerCase() !== "english") {
    try {
      const translationResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: `System: You are a professional translator. Please translate the following prompt from english to ${language}. Ensure the translation is accurate and meaning is preserved. JSON contents MUST be translated in ${language} too, that's mandatory. Omit the system prompt from the translation and translate only user content, ensure full prompt is translated (do not miss any part, and DO NOT add any additional part not in the prompt).\n\n User:` },
                { text: prompt },
              ],
            },
          ],
        }),
      });
      const translationData = await translationResponse.json();
      if (translationData.candidates && translationData.candidates[0].content) {
        currentPrompt = translationData.candidates[0].content.parts[0].text;
      }
    } catch (e) {
      console.error("Translation failed, falling back to English prompt", e);
    }
  }

  const raw = JSON.stringify({
    contents: [
      {
        parts: [
          {
            text: currentPrompt,
          },
          { text: JSON.stringify(data) },
        ],
      },
    ],
  });

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw,
  });

  const geminiRes = await response.json();
  const resText = geminiRes.candidates[0].content.parts[0].text;
  const json = resText.substring(resText.indexOf("{"), resText.lastIndexOf("}") + 1);
  try {
    return res.json(JSON.parse(json));
  } catch (err) {
    console.error("Error parsing JSON:", err);
    return res.status(500).json({ error: "Failed to parse JSON response", response: resText });
  }
});

// ---------------- /burn ----------------
app.post("/burn", async (req, res) => {
  let { video, audio, subtitles, fontsize = 30, outline = 2, watermark, watermarkColor = "white", watermarkOpacity = 0.5, videoSource = "local", pexelsApiKey, videoQuery } = req.body;
  if (!audio || !subtitles) return res.status(400).send("Missing parameters");

  const tmp = `/tmp/${uuidv4()}`;
  fs.mkdirSync(tmp);

  try {
    const audioPath = `${tmp}/audio.wav`;
    const subPath = `${tmp}/sub.srt`;
    const assPath = `${tmp}/sub.ass`;
    const outputPath = `${tmp}/output.mp4`;

    fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));
    fs.writeFileSync(subPath, subtitles);

    let { video, audio, subtitles, fontsize = 30, outline = 2, watermark, watermarkColor = "white", watermarkOpacity = 0.5, videoSource = "local", pexelsApiKey, videoQuery } = req.body;
    if (!audio || !subtitles) return res.status(400).send("Missing parameters");

    const tmp = `/tmp/${uuidv4()}`;
    fs.mkdirSync(tmp);

    try {
      const audioPath = `${tmp}/audio.wav`;
      const subPath = `${tmp}/sub.srt`;
      const assPath = `${tmp}/sub.ass`;
      const outputPath = `${tmp}/output.mp4`;

      fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));
      fs.writeFileSync(subPath, subtitles);

      let videoFilePath;
      let startOffset = 0;

      // Pexels Integration
      if (videoSource === "pexels" && pexelsApiKey && videoQuery) {
        try {
          console.log(`Searching Pexels for: ${videoQuery}`);
          const pexelsRes = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(videoQuery)}&per_page=1&orientation=portrait&size=medium`, {
            headers: { "Authorization": pexelsApiKey }
          });
          const pexelsData = await pexelsRes.json();

          if (pexelsData.videos && pexelsData.videos.length > 0) {
            const videoData = pexelsData.videos[0];
            // Try to find the best quality file, preferably HD
            const videoFiles = videoData.video_files || [];
            // Sort by resolution (width * height) desc
            videoFiles.sort((a, b) => (b.width * b.height) - (a.width * a.height));
            const bestVideo = videoFiles[0];

            if (bestVideo) {
              const pexelsPath = `${tmp}/pexels_video.mp4`;
              console.log(`Downloading Pexels video: ${bestVideo.link}`);
              await downloadFile(bestVideo.link, pexelsPath);
              videoFilePath = pexelsPath;
              // No random start offset for pexels usually as they are short, but we can verify
              // const pexelsDuration = await getDuration(pexelsPath);
              // startOffset = 0; 
            }
          } else {
            console.log("No videos found on Pexels, falling back to local.");
          }
        } catch (err) {
          console.error("Pexels error:", err);
        }
      }

      // Fallback to local if videoFilePath is not set
      if (!videoFilePath) {
        if (!video) {
          const allFiles = fs.readdirSync("/mnt/videos");
          const defaultVideos = allFiles.filter(f => f.startsWith("default_"));
          if (defaultVideos.length === 0) throw new Error("No default videos found");
          video = defaultVideos[Math.floor(Math.random() * defaultVideos.length)];
          videoFilePath = path.join("/mnt/videos", video);

          // Only calc offset for local long videos
          const videoDuration = await getDuration(videoFilePath);
          const audioDuration = await getDuration(audioPath);
          const delta = Math.max(videoDuration - audioDuration - 1, 0);
          startOffset = delta > 0 ? Math.random() * delta : 0;
        } else {
          videoFilePath = path.join("/mnt/videos", video);
          if (!fs.existsSync(videoFilePath)) return res.status(404).send("Video file not found");
        }
      }

      // Generate styled ASS subtitles
      await execPromise(`ffmpeg -y -i "${subPath}" "${assPath}"`);
      await execPromise(`sed -i '/^Style:/c\\Style: Default,Montserrat ExtraBold,${fontsize},&H00FFFFFF,&H00000000,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,2,${outline},2,10,10,10,1' "${assPath}"`);
      await execPromise(`grep -q "WrapStyle" "${assPath}" && sed -i 's/WrapStyle.*/WrapStyle: 0/' "${assPath}" || sed -i '/^\\[Script Info\\]/a WrapStyle: 0' "${assPath}"`);

      // Build filter string
      // Subtitles filter
      let filters = `subtitles=${assPath}:fontsdir=/app/fonts`;

      // Add watermark if present
      if (watermark) {
        // Simple positioning: centered at the top/bottom or just bottom right? 
        // Let's do bottom center with padding.
        // opacity adjustment requires fontcolor=white@0.5 format if using text, or using alpha in drawtext.
        // ffmpeg drawtext alpha: fontcolor_expr=...
        // simplest: fontcolor=${watermarkColor}@${watermarkOpacity}
        filters += `,drawtext=text='${watermark}':x=(w-text_w)/2:y=h-th-50:fontsize=24:fontcolor=${watermarkColor}@${watermarkOpacity}:borderw=1:bordercolor=black`;
      }

      // Burn subtitles, combine video + audio
      const finalFilename = `${uuidv4()}.mp4`;
      const finalPath = path.join("/app/outputs", finalFilename);

      // Ensure outputs dir exists
      if (!fs.existsSync("/app/outputs")) fs.mkdirSync("/app/outputs");

      await execPromise(
        `ffmpeg -y -stream_loop -1 -ss ${startOffset.toFixed(2)} -i "${videoFilePath}" -i "${audioPath}" -vf "${filters}" -map 0:v:0 -map 1:a:0 -c:v libx264 -c:a aac -shortest "${outputPath}"`
      );

      // Initial output was to tmp/outputPath, move it to final persistent location
      fs.copyFileSync(outputPath, finalPath);

      // Return the public URL
      res.json({ url: `/outputs/${finalFilename}` });

      // Cleanup tmp folder
      cleanup(tmp);
    } catch (err) {
      console.error(err);
      cleanup(tmp);
      res.status(500).send("Internal server error");
    }
  } catch (err) {
    console.error(err);
    cleanup(tmp);
    res.status(500).send("Internal server error");
  }
});


// ---------------- /clear-data ----------------
app.post("/clear-data", async (req, res) => {
  try {
    const outputsDir = "/app/outputs";
    if (fs.existsSync(outputsDir)) {
      const files = fs.readdirSync(outputsDir);
      for (const file of files) {
        fs.unlinkSync(path.join(outputsDir, file));
      }
    }
    res.json({ success: true, message: "All generated data cleared." });
  } catch (err) {
    console.error("Error clearing data:", err);
    res.status(500).json({ error: "Failed to clear data" });
  }
});

app.get("/coquiSpeakerId", (req, res) => {
  const speakerId = process.env.COQUI_SPEAKER_ID;
  res.json({ speakerId: speakerId || "p340" });
});

function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => (error ? reject(stderr) : resolve(stdout)));
  });
}

async function getDuration(filePath) {
  const stdout = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
  return parseFloat(stdout.trim());
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download: ${res.statusText}`);
  const fileStream = fs.createWriteStream(dest);
  return new Promise((resolve, reject) => {
    // node-fetch/native fetch body is web stream, convert to node stream
    // For node 18+ native fetch
    const reader = res.body.getReader();
    const pump = async () => {
      const { done, value } = await reader.read();
      if (done) {
        fileStream.end();
        resolve();
        return;
      }
      fileStream.write(value);
      pump();
    };
    pump().catch(err => {
      fileStream.end();
      reject(err);
    });

    fileStream.on("error", reject);
  });
}

function cleanup(folder) {
  fs.rmSync(folder, { recursive: true, force: true });
}

(async () => {
  // first thing we do is check if locale is different from english, if so we ask gemini to translate the prompt to the locale language
  if (LOCALE !== "english") {
    const translationResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: `System: You are a professional translator. Please translate the following prompt from english to ${LOCALE}. Ensure the translation is accurate and meaning is preserved. JSON contents MUST be translated in ${LOCALE} too, that's mandatory. Omit the system prompt from the translation and translate only user content, ensure full prompt is translated (do not miss any part, and DO NOT add any additional part not in the prompt).\n\n User:` },
              { text: prompt },
            ],
          },
        ],
      }),
    });
    const translationData = await translationResponse.json();
    prompt = translationData.candidates[0].content.parts[0].text;
    console.log(`Prompt translated to ${LOCALE}:`, prompt);
  }

  // ---------------- /tts ----------------
  app.get("/tts", async (req, res) => {
    const { text, speaker_id, lang = "english" } = req.query;

    if (lang.toLowerCase() !== "english") {
      try {
        // Map language names to codes
        const langMap = {
          "english": "en",
          "indonesian": "id",
          "spanish": "es",
          "french": "fr",
          "german": "de",
          "italian": "it",
          "portuguese": "pt",
          "hindi": "hi",
          "japanese": "ja"
        };
        const code = langMap[lang.toLowerCase()] || "en";

        console.log(`Using Google TTS for language: ${lang} (${code})`);

        // google-tts-api splits long text automatically
        const results = await googleTTS.getAllAudioBase64(text, {
          lang: code,
          slow: false,
          host: "https://translate.google.com",
          timeout: 10000,
        });

        // Concatenate base64 parts into a single buffer
        const buffers = results.map(r => Buffer.from(r.base64, "base64"));
        const finalBuffer = Buffer.concat(buffers);

        res.setHeader("Content-Type", "audio/mp3");
        res.send(finalBuffer);

      } catch (err) {
        console.error("Google TTS failed:", err);
        res.status(500).send("TTS Generation Failed");
      }
    } else {
      // Proxy to Coqui for English
      // We forward the text and speaker_id
      // Coqui endpoint: http://coqui:5002/api/tts?text=...&speaker_id=...
      try {
        const coquiUrl = `http://coqui:5002/api/tts?text=${encodeURIComponent(text)}&speaker_id=${speaker_id}`;
        const coquiRes = await fetch(coquiUrl);
        if (!coquiRes.ok) throw new Error(`Coqui response ${coquiRes.status}`);

        // Stream the response back
        res.setHeader("Content-Type", "audio/wav"); // Coqui returns WAV
        // Node 18 fetch returns stream in body
        // We can convert to buffer or pipe if using node-fetch
        // Native fetch body is a ReadableStream
        const arrayBuffer = await coquiRes.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));

      } catch (err) {
        console.error("Coqui TTS failed:", err);
        res.status(500).send("TTS Generation Failed");
      }
    }
  });

  app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
})();
