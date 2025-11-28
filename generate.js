import express from "express";
import cors from "cors";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/api/generate", async (req, res) => {
  const { subject, topic, level, taskCount } = req.body;

  const prompt = `
Jsi asistent učitele. Vytvoř pracovní list pro předmět "${subject}", téma "${topic}".
Úroveň: ${level}. Počet úloh: ${taskCount}.
Výstup formátuj jako krátký text s úlohami, vhodný pro tisk.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const text = completion.choices[0].message.content;
    res.json({ worksheet: text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Chyba při generování" });
  }
});

app.listen(3001, () => console.log("✅ API běží na http://localhost:3001"));
